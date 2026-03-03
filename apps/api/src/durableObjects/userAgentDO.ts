import { DurableObject } from 'cloudflare:workers';
import type { AgentEventRecord } from '../agent/events';
import {
  generateDailyDigestContent,
  generateTopicArticleContent,
  getArticleMarkdownContent,
  refreshRecommendationsContent,
} from './userAgentContentService';
import type { Bindings } from '../types';
import {
  enqueueJob,
  JOB_STATUS_FAILED,
  JOB_STATUS_QUEUED,
  JOB_STATUS_RUNNING,
  JOB_STATUS_SUCCEEDED,
  runDueJobs,
} from './userAgentJobRunner';
import {
  isoDate,
  isRecommendationTriggerEvent,
  nextUtcHour,
  normalizeOccurredAt,
  normalizeSqlNumber,
  normalizeSqlString,
  sanitizeLimit,
  tomorrowDate,
} from './userAgentHelpers';
import { initializeAgentSchema } from './userAgentSchema';
import type {
  ArticleRow,
  EventRow,
  JobType,
  PortfolioSnapshotPoint,
  RecommendationRow,
  TransferRow,
  TodayDailyStatus,
  WatchlistAssetRow,
} from './userAgentTypes';
import { safeJsonParse } from '../utils/json';
import { ensureTopicSpecialSchema } from '../services/topicSpecials';

const OWNER_KEY = 'owner_user_id';
const USER_LOCALE_KEY = 'user_locale';
const REQUEST_LOCALE_KEY = 'request_locale';
const HOURLY_SNAPSHOT_RETENTION_HOURS = 72;
const DAILY_SNAPSHOT_RETENTION_DAYS = 180;
const TOPIC_SPECIAL_FETCH_MULTIPLIER = 3;
const TOPIC_SPECIAL_MIN_FETCH = 24;
const MAX_WATCHLIST_SIZE = 500;

type WatchlistType = 'crypto' | 'perps' | 'stock' | 'prediction';

type WatchlistAssetUpsertInput = {
  watchType?: string | null;
  itemId?: string | null;
  chain?: string | null;
  contract?: string | null;
  symbol?: string | null;
  name?: string | null;
  image?: string | null;
  source?: string | null;
  change24h?: number | null;
  externalUrl?: string | null;
};

type TopicSpecialArticleIndexRow = {
  id: string;
  title: string;
  summary: string;
  r2_key: string;
  related_assets_json: string;
  generated_at: string;
  status: string;
};

export class UserAgentDO extends DurableObject<Bindings> {
  private topicSpecialSchemaReady = false;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      initializeAgentSchema(this.ctx.storage.sql);
    });
  }

  async ingestEventRpc(event: AgentEventRecord): Promise<{
    ok: true;
    eventId: string;
    deduped: boolean;
    sequence: number;
  }> {
    await this.ensureDailyDigestJobs();
    return this.ingestEvent(event);
  }

  async setUserLocaleRpc(userId: string, locale: string | null): Promise<{ ok: true }> {
    this.ensureOwner(userId);
    this.setUserLocale(locale);
    return { ok: true };
  }

  async setRequestLocaleRpc(userId: string, locale: string | null): Promise<{ ok: true }> {
    this.ensureOwner(userId);
    this.setRequestLocale(locale);
    return { ok: true };
  }

  async listRecommendationsRpc(
    userId: string,
    limit = 10,
  ): Promise<{ recommendations: RecommendationRow[] }> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    return { recommendations: this.getRecommendations(limit) };
  }

  async listArticlesRpc(
    userId: string,
    options?: {
      limit?: number;
      articleType?: string;
    },
  ): Promise<{ articles: ArticleRow[] }> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    await this.ensureTodayDailyReady();
    const limit = options?.limit ?? 20;
    const articleType = options?.articleType ?? null;
    return { articles: await this.getArticles(limit, articleType) };
  }

  async getArticleDetailRpc(
    userId: string,
    articleId: string,
  ): Promise<{ article: ArticleRow; markdown: string } | null> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    await this.ensureTodayDailyReady();
    return this.getArticleDetail(articleId);
  }

  async getTodayDailyRpc(userId: string): Promise<{
    date: string;
    status: TodayDailyStatus;
    article: ArticleRow | null;
    lastReadyArticle: ArticleRow | null;
  }> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    await this.ensureTodayDailyReady();

    const now = new Date();
    const dateKey = isoDate(now);
    const article = this.getTodayDailyArticle(dateKey);
    const lastReadyArticle = this.getLatestDailyBefore(dateKey);

    if (article) {
      return {
        date: dateKey,
        status: 'ready',
        article,
        lastReadyArticle,
      };
    }

    const status = this.getTodayDailyJobStatus(dateKey);
    return {
      date: dateKey,
      status,
      article: null,
      lastReadyArticle,
    };
  }

  async enqueueJobRpc(
    userId: string,
    options: {
      jobType: JobType;
      runAt?: string;
      payload?: Record<string, unknown>;
      jobKey?: string;
    },
  ): Promise<{ ok: true; jobId: string; deduped: boolean }> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    const runAt = normalizeOccurredAt(options.runAt);
    const result = await this.enqueueJob(options.jobType, runAt, options.payload ?? {}, options.jobKey ?? null);
    return { ok: true, ...result };
  }

  async runJobsNowRpc(userId: string): Promise<{ ok: true }> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    await this.alarm();
    return { ok: true };
  }

  async savePortfolioSnapshotRpc(
    userId: string,
    input: { totalUsd: number; holdings: unknown[]; asOf?: string },
  ): Promise<{ ok: true }> {
    this.ensureOwner(userId);
    const asOf = normalizeOccurredAt(input.asOf);
    this.savePortfolioSnapshot(asOf, input.totalUsd, input.holdings ?? []);
    return { ok: true };
  }

  async listPortfolioSnapshotsRpc(
    userId: string,
    period: '24h' | '7d' | '30d',
  ): Promise<{ points: PortfolioSnapshotPoint[] }> {
    this.ensureOwner(userId);
    return { points: this.listPortfolioSnapshots(period) };
  }

  async createTransferRpc(
    userId: string,
    input: {
      id: string;
      chainId: number;
      fromAddress: string;
      toAddress: string;
      tokenAddress?: string | null;
      tokenSymbol?: string | null;
      tokenDecimals: number;
      amountInput: string;
      amountRaw: string;
      txValue: string;
      status: TransferRow['status'];
      idempotencyKey?: string | null;
      txHash?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      submittedAt?: string | null;
      confirmedAt?: string | null;
    },
  ): Promise<{ transfer: TransferRow; deduped: boolean }> {
    this.ensureOwner(userId);
    const now = new Date().toISOString();
    const idempotencyKey = input.idempotencyKey?.trim() || null;

    if (idempotencyKey) {
      const existing = this.ctx.storage.sql
        .exec('SELECT id FROM transfers WHERE idempotency_key = ? LIMIT 1', idempotencyKey)
        .toArray()[0] as Record<string, unknown> | undefined;
      const existingId = normalizeSqlString(existing?.id);
      if (existingId) {
        const transfer = this.getTransfer(existingId);
        if (transfer) return { transfer, deduped: true };
      }
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO transfers (
        id,
        user_id,
        chain_id,
        from_address,
        to_address,
        token_address,
        token_symbol,
        token_decimals,
        amount_input,
        amount_raw,
        tx_value,
        tx_hash,
        status,
        error_code,
        error_message,
        idempotency_key,
        created_at,
        updated_at,
        submitted_at,
        confirmed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      userId,
      input.chainId,
      input.fromAddress,
      input.toAddress,
      input.tokenAddress ?? null,
      input.tokenSymbol ?? null,
      input.tokenDecimals,
      input.amountInput,
      input.amountRaw,
      input.txValue,
      input.txHash ?? null,
      input.status,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      idempotencyKey,
      now,
      now,
      input.submittedAt ?? null,
      input.confirmedAt ?? null,
    );

    const transfer = this.getTransfer(input.id);
    if (!transfer) {
      throw new Error('transfer_create_failed');
    }
    return { transfer, deduped: false };
  }

  async updateTransferRpc(
    userId: string,
    transferId: string,
    input: {
      status?: TransferRow['status'];
      txHash?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      submittedAt?: string | null;
      confirmedAt?: string | null;
    },
  ): Promise<{ transfer: TransferRow | null }> {
    this.ensureOwner(userId);
    const existing = this.getTransfer(transferId);
    if (!existing) {
      return { transfer: null };
    }

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE transfers
       SET status = ?,
           tx_hash = ?,
           error_code = ?,
           error_message = ?,
           submitted_at = ?,
           confirmed_at = ?,
           updated_at = ?
       WHERE id = ?`,
      input.status ?? existing.status,
      input.txHash ?? existing.tx_hash,
      input.errorCode ?? existing.error_code,
      input.errorMessage ?? existing.error_message,
      input.submittedAt ?? existing.submitted_at,
      input.confirmedAt ?? existing.confirmed_at,
      now,
      transferId,
    );

    return { transfer: this.getTransfer(transferId) };
  }

  async getTransferRpc(userId: string, transferId: string): Promise<{ transfer: TransferRow | null }> {
    this.ensureOwner(userId);
    return { transfer: this.getTransfer(transferId) };
  }

  async listTransfersRpc(
    userId: string,
    options?: {
      limit?: number;
      status?: TransferRow['status'];
    },
  ): Promise<{ transfers: TransferRow[] }> {
    this.ensureOwner(userId);
    const limit = sanitizeLimit(options?.limit ?? 20, 1, 100);
    const normalizedStatus = options?.status?.trim() ?? '';
    if (normalizedStatus) {
      return { transfers: this.listTransfers(limit, normalizedStatus as TransferRow['status']) };
    }
    return { transfers: this.listTransfers(limit) };
  }

  async listWatchlistAssetsRpc(
    userId: string,
    limit = 50,
  ): Promise<{ assets: WatchlistAssetRow[] }> {
    this.ensureOwner(userId);
    return { assets: this.getWatchlistAssets(limit) };
  }

  async upsertWatchlistAssetRpc(
    userId: string,
    input: WatchlistAssetUpsertInput,
  ): Promise<{ asset: WatchlistAssetRow }> {
    this.ensureOwner(userId);
    const asset = this.upsertWatchlistAsset(userId, input);
    return { asset };
  }

  async removeWatchlistAssetRpc(
    userId: string,
    input: { id?: string | null; chain?: string | null; contract?: string | null },
  ): Promise<{ removed: boolean }> {
    this.ensureOwner(userId);
    const removed = this.removeWatchlistAsset(userId, input.id ?? null, input.chain ?? null, input.contract ?? null);
    return { removed };
  }

  async alarm(): Promise<void> {
    await runDueJobs({
      sql: this.ctx.storage.sql,
      alarmStorage: this.ctx.storage,
      executeJob: (jobType, payload) => this.executeJob(jobType, payload),
    });
  }

  private async ingestEvent(event: AgentEventRecord): Promise<{
    ok: true;
    eventId: string;
    deduped: boolean;
    sequence: number;
  }> {
    if (!event?.userId || !event?.eventId || !event?.type) {
      throw new Error('invalid_event_payload');
    }

    this.ensureOwner(event.userId);

    if (event.dedupeKey) {
      const existing = this.ctx.storage.sql
        .exec('SELECT id FROM user_events WHERE dedupe_key = ? LIMIT 1', event.dedupeKey)
        .toArray()[0] as Record<string, unknown> | undefined;
      const existingId = normalizeSqlString(existing?.id);
      if (existingId) {
        return {
          ok: true,
          eventId: existingId,
          deduped: true,
          sequence: this.countEvents(),
        };
      }
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO user_events (
        id,
        user_id,
        event_type,
        payload_json,
        dedupe_key,
        occurred_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      event.userId,
      event.type,
      JSON.stringify(event.payload ?? {}),
      event.dedupeKey,
      event.occurredAt,
      event.receivedAt,
    );

    if (event.type === 'asset_favorited') {
      const payload = event.payload ?? {};
      const chain = typeof payload.chain === 'string' ? payload.chain : '';
      const contract = typeof payload.contract === 'string' ? payload.contract : '';
      try {
        this.upsertWatchlistAsset(event.userId, {
          watchType: 'crypto',
          chain,
          contract,
          itemId: chain && contract ? `${chain.trim().toLowerCase()}:${contract.trim().toLowerCase()}` : null,
          symbol: typeof payload.asset === 'string' ? payload.asset : typeof payload.symbol === 'string' ? payload.symbol : null,
          name: typeof payload.name === 'string' ? payload.name : null,
          image: typeof payload.image === 'string' ? payload.image : null,
          source: typeof payload.source === 'string' ? payload.source : 'event_asset_favorited',
        });
      } catch {
        // Ignore malformed payloads from event ingestion.
      }
    }

    if (isRecommendationTriggerEvent(event.type)) {
      const today = isoDate(new Date());
      const jobKey = `recommendation_refresh:${today}`;
      await this.enqueueJob('recommendation_refresh', new Date(Date.now() + 5000).toISOString(), {}, jobKey);
    }

    await this.ensureDailyDigestJobs();

    return {
      ok: true,
      eventId: event.eventId,
      deduped: false,
      sequence: this.countEvents(),
    };
  }

  private ensureOwner(userId: string): void {
    const row = this.ctx.storage.sql
      .exec('SELECT value_json FROM agent_state WHERE key = ? LIMIT 1', OWNER_KEY)
      .toArray()[0] as Record<string, unknown> | undefined;
    const valueJson = normalizeSqlString(row?.value_json);
    if (!valueJson) {
      this.ctx.storage.sql.exec(
        'INSERT INTO agent_state (key, value_json, updated_at) VALUES (?, ?, ?)',
        OWNER_KEY,
        JSON.stringify({ userId }),
        new Date().toISOString(),
      );
      return;
    }

    const parsed = JSON.parse(valueJson) as { userId?: string };
    if (parsed.userId !== userId) {
      throw new Error('user_id_mismatch_for_agent');
    }
  }

  private getOwnerUserId(): string | null {
    const row = this.ctx.storage.sql
      .exec('SELECT value_json FROM agent_state WHERE key = ? LIMIT 1', OWNER_KEY)
      .toArray()[0] as Record<string, unknown> | undefined;
    const valueJson = normalizeSqlString(row?.value_json);
    if (!valueJson) return null;
    const parsed = safeJsonParse<{ userId?: string }>(valueJson);
    return parsed?.userId ?? null;
  }

  private setUserLocale(locale: string | null): void {
    const normalized = locale?.trim().toLowerCase() ?? '';
    const value = normalized.slice(0, 32);
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_state (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      USER_LOCALE_KEY,
      JSON.stringify({ locale: value || null }),
      new Date().toISOString(),
    );
  }

  private setRequestLocale(locale: string | null): void {
    const normalized = locale?.trim().toLowerCase() ?? '';
    const value = normalized.slice(0, 32);
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_state (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      REQUEST_LOCALE_KEY,
      JSON.stringify({ locale: value || null }),
      new Date().toISOString(),
    );
  }

  private getLocaleByKey(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec('SELECT value_json FROM agent_state WHERE key = ? LIMIT 1', key)
      .toArray()[0] as Record<string, unknown> | undefined;
    const valueJson = normalizeSqlString(row?.value_json);
    if (!valueJson) return null;
    const parsed = safeJsonParse<{ locale?: string | null }>(valueJson);
    const locale = parsed?.locale;
    if (typeof locale !== 'string') return null;
    const normalized = locale.trim().toLowerCase();
    return normalized || null;
  }

  private getEffectiveLocale(): string | null {
    const userLocale = this.getLocaleByKey(USER_LOCALE_KEY);
    if (userLocale) return userLocale;
    return this.getLocaleByKey(REQUEST_LOCALE_KEY);
  }

  private countEvents(): number {
    const row = this.ctx.storage.sql.exec('SELECT COUNT(*) as count FROM user_events').one() as
      | Record<string, unknown>
      | null;
    return normalizeSqlNumber(row?.count);
  }

  private getLatestEvents(limit = 20): EventRow[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          event_type,
          occurred_at,
          received_at,
          payload_json,
          dedupe_key
         FROM user_events
         ORDER BY received_at DESC
         LIMIT ?`,
        sanitizeLimit(limit, 1, 100),
      )
      .toArray() as EventRow[];
  }

  private getWatchlistAssets(limit = 50): WatchlistAssetRow[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          user_id,
          watch_type,
          item_id,
          chain,
          contract,
          symbol,
          name,
          image,
          source,
          change_24h,
          external_url,
          created_at,
          updated_at
         FROM user_watchlist_assets
         ORDER BY updated_at DESC
         LIMIT ?`,
        sanitizeLimit(limit, 1, MAX_WATCHLIST_SIZE),
      )
      .toArray() as WatchlistAssetRow[];
  }

  private getWatchlistSymbols(limit = 12): string[] {
    const assets = this.getWatchlistAssets(limit);
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const asset of assets) {
      const symbol = this.normalizeAssetSymbol(asset.symbol);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      deduped.push(symbol);
    }
    return deduped;
  }

  private upsertWatchlistAsset(userId: string, input: WatchlistAssetUpsertInput): WatchlistAssetRow {
    const watchType = this.normalizeWatchType(input.watchType);
    if (!watchType) {
      throw new Error('invalid_watchlist_type');
    }
    const itemId = this.normalizeWatchlistItemId(input.itemId);
    let chain: string;
    let contract: string;

    if (watchType === 'crypto') {
      const normalizedChain = this.normalizeWatchlistChain(input.chain);
      const normalizedContract = this.normalizeWatchlistContract(input.contract);
      if (normalizedChain && normalizedContract) {
        chain = normalizedChain;
        contract = normalizedContract;
      } else {
        const syntheticKey = this.normalizeWatchlistItemId(input.itemId)
          ?? this.normalizeWatchlistItemId(input.symbol)
          ?? this.normalizeWatchlistItemId(input.name);
        if (!syntheticKey) {
          throw new Error('invalid_watchlist_item');
        }
        chain = 'watch:crypto';
        contract = `item:${syntheticKey}`;
      }
    } else {
      const syntheticKey = this.normalizeWatchlistItemId(input.itemId)
        ?? this.normalizeWatchlistItemId(input.symbol)
        ?? this.normalizeWatchlistItemId(input.name);
      if (!syntheticKey) {
        throw new Error('invalid_watchlist_item');
      }
      chain = `watch:${watchType}`;
      contract = `item:${syntheticKey}`;
    }

    const symbolValue = this.normalizeWatchSymbol(input.symbol);
    const nameValue = this.normalizeLabel(input.name, 80);
    const symbol = symbolValue
      ?? (nameValue ? nameValue.slice(0, 24).toUpperCase() : contract.slice(0, 24).toUpperCase());
    const name = nameValue ?? symbol;
    const image = this.normalizeOptional(input.image, 512);
    const source = this.normalizeOptional(input.source, 64);
    const externalUrl = this.normalizeOptional(input.externalUrl, 1024);
    const change24h = this.normalizeWatchChange(input.change24h);
    const now = new Date().toISOString();

    this.ctx.storage.sql.exec(
      `INSERT INTO user_watchlist_assets (
         id,
         user_id,
         watch_type,
         item_id,
         chain,
         contract,
         symbol,
         name,
         image,
         source,
         change_24h,
         external_url,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, chain, contract) DO UPDATE SET
         watch_type = excluded.watch_type,
         item_id = COALESCE(excluded.item_id, user_watchlist_assets.item_id),
         symbol = excluded.symbol,
         name = excluded.name,
         image = excluded.image,
         source = excluded.source,
         change_24h = COALESCE(excluded.change_24h, user_watchlist_assets.change_24h),
         external_url = COALESCE(excluded.external_url, user_watchlist_assets.external_url),
         updated_at = excluded.updated_at`,
      crypto.randomUUID(),
      userId,
      watchType,
      itemId,
      chain,
      contract,
      symbol,
      name,
      image,
      source,
      change24h,
      externalUrl,
      now,
      now,
    );

    const row = this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          user_id,
          watch_type,
          item_id,
          chain,
          contract,
          symbol,
          name,
          image,
          source,
          change_24h,
          external_url,
          created_at,
          updated_at
         FROM user_watchlist_assets
         WHERE user_id = ?
           AND chain = ?
           AND contract = ?
         LIMIT 1`,
        userId,
        chain,
        contract,
      )
      .toArray()[0] as WatchlistAssetRow | undefined;
    if (!row) {
      throw new Error('watchlist_upsert_failed');
    }
    return row;
  }

  private removeWatchlistAsset(
    userId: string,
    idRaw: string | null,
    chainRaw: string | null,
    contractRaw: string | null,
  ): boolean {
    const id = this.normalizeLabel(idRaw, 80);
    if (id) {
      const row = this.ctx.storage.sql
        .exec(
          `SELECT id
           FROM user_watchlist_assets
           WHERE user_id = ?
             AND id = ?
           LIMIT 1`,
          userId,
          id,
        )
        .toArray()[0] as { id?: string } | undefined;
      if (!row?.id) return false;
      this.ctx.storage.sql.exec(
        `DELETE FROM user_watchlist_assets
         WHERE user_id = ?
           AND id = ?`,
        userId,
        id,
      );
      return true;
    }

    const chain = this.normalizeWatchlistChain(chainRaw);
    const contract = this.normalizeWatchlistContract(contractRaw);
    if (!chain || !contract) {
      throw new Error('invalid_watchlist_remove_target');
    }

    const row = this.ctx.storage.sql
      .exec(
        `SELECT id
         FROM user_watchlist_assets
         WHERE user_id = ?
           AND chain = ?
           AND contract = ?
         LIMIT 1`,
        userId,
        chain,
        contract,
      )
      .toArray()[0] as { id?: string } | undefined;
    if (!row?.id) return false;

    this.ctx.storage.sql.exec(
      `DELETE FROM user_watchlist_assets
       WHERE user_id = ?
         AND chain = ?
         AND contract = ?`,
      userId,
      chain,
      contract,
    );
    return true;
  }

  private getRecommendations(limit = 10): RecommendationRow[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          category,
          asset_name,
          asset_symbol,
          asset_chain,
          asset_contract,
          asset_display_name,
          asset_image,
          asset_price_change_24h,
          reason,
          score,
          generated_at,
          valid_until
         FROM recommendations
         ORDER BY generated_at DESC
         LIMIT ?`,
        sanitizeLimit(limit, 1, 100),
      )
      .toArray() as RecommendationRow[];
  }

  private async getArticles(limit = 20, articleType: string | null = null): Promise<ArticleRow[]> {
    const safeLimit = sanitizeLimit(limit, 1, 100);
    const normalizedType = articleType?.trim().toLowerCase() ?? null;

    if (normalizedType === 'topic') {
      return this.getPersonalizedTopicArticles(safeLimit);
    }

    if (normalizedType) {
      return this.getLocalArticles(safeLimit, normalizedType);
    }

    const mergeLimit = Math.min(100, Math.max(safeLimit * 2, 20));
    const [localArticles, topicArticles] = await Promise.all([
      Promise.resolve(this.getLocalArticles(mergeLimit, null)),
      this.getPersonalizedTopicArticles(mergeLimit),
    ]);

    const deduped = new Map<string, ArticleRow>();
    for (const article of [...localArticles, ...topicArticles]) {
      if (!deduped.has(article.id)) {
        deduped.set(article.id, article);
      }
    }

    return Array.from(deduped.values())
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, safeLimit);
  }

  private getLocalArticles(limit = 20, articleType: string | null = null): ArticleRow[] {
    const safeLimit = sanitizeLimit(limit, 1, 100);
    const normalizedType = articleType?.trim();
    if (normalizedType) {
      return this.ctx.storage.sql
        .exec(
          `SELECT
            id,
            article_type,
            title,
            summary,
            r2_key,
            tags_json,
            created_at,
            status
           FROM article_index
           WHERE article_type = ?
           ORDER BY created_at DESC
           LIMIT ?`,
          normalizedType,
          safeLimit,
        )
        .toArray() as ArticleRow[];
    }

    return this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          article_type,
          title,
          summary,
          r2_key,
          tags_json,
          created_at,
          status
         FROM article_index
         ORDER BY created_at DESC
         LIMIT ?`,
        safeLimit,
      )
      .toArray() as ArticleRow[];
  }

  private async getPersonalizedTopicArticles(limit = 20): Promise<ArticleRow[]> {
    if (!(await this.ensureTopicSpecialSchemaReady())) return [];
    const safeLimit = sanitizeLimit(limit, 1, 100);
    const fetchLimit = Math.min(100, Math.max(safeLimit * TOPIC_SPECIAL_FETCH_MULTIPLIER, TOPIC_SPECIAL_MIN_FETCH));
    let rows: { results?: TopicSpecialArticleIndexRow[] };
    try {
      rows = await this.env.DB.prepare(
        `SELECT
           id,
           title,
           summary,
           r2_key,
           related_assets_json,
           generated_at,
           status
         FROM topic_special_articles
         WHERE status = 'ready'
         ORDER BY generated_at DESC
         LIMIT ?`,
      )
        .bind(fetchLimit)
        .all<TopicSpecialArticleIndexRow>();
    } catch (error) {
      console.error('topic_special_query_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }

    const topicRows = rows.results ?? [];
    if (topicRows.length === 0) return [];

    const eventAssets = this.getUserTopEventAssets(12);
    const eventWeight = new Map<string, number>();
    for (let index = 0; index < eventAssets.length; index += 1) {
      eventWeight.set(eventAssets[index], Math.max(1, 12 - index));
    }
    const watchlistAssets = this.getWatchlistSymbols(16);
    const watchlistWeight = new Map<string, number>();
    for (let index = 0; index < watchlistAssets.length; index += 1) {
      watchlistWeight.set(watchlistAssets[index], Math.max(1, 16 - index));
    }
    const holdingAssets = new Set(this.getUserTopHoldingAssets(12));

    const scored = topicRows.map((row, index) => {
      const relatedAssets = this.parseRelatedAssets(row.related_assets_json);
      const affinityScore = relatedAssets.reduce((score, asset) => {
        const eventScore = (eventWeight.get(asset) ?? 0) * 2;
        const watchlistScore = (watchlistWeight.get(asset) ?? 0) * 3;
        const holdingScore = holdingAssets.has(asset) ? 3 : 0;
        return score + eventScore + watchlistScore + holdingScore;
      }, 0);
      const ageMs = Date.now() - Date.parse(row.generated_at);
      const ageHours = Number.isFinite(ageMs) ? ageMs / (60 * 60 * 1000) : 999;
      const recencyScore = Math.max(0, 8 - ageHours / 12);
      return {
        row,
        relatedAssets,
        rankScore: affinityScore * 10 + recencyScore + Math.max(0, 2 - index * 0.1),
      };
    });

    scored.sort((a, b) => {
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      return Date.parse(b.row.generated_at) - Date.parse(a.row.generated_at);
    });

    return scored.slice(0, safeLimit).map((item) => this.toTopicArticleRow(item.row, item.relatedAssets));
  }

  private getUserTopEventAssets(limit = 12): string[] {
    const events = this.getLatestEvents(200);
    const counts = new Map<string, number>();
    for (const event of events) {
      const payload = safeJsonParse<Record<string, unknown>>(event.payload_json) ?? {};
      const candidates = [payload.asset, payload.symbol, payload.token]
        .map((value) => this.normalizeAssetSymbol(value))
        .filter((value): value is string => Boolean(value));
      const weight = event.event_type === 'trade_buy' || event.event_type === 'trade_sell'
        ? 3
        : event.event_type === 'asset_holding_snapshot'
          ? 2
          : 1;
      for (const symbol of candidates) {
        counts.set(symbol, (counts.get(symbol) ?? 0) + weight);
      }
    }

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([symbol]) => symbol);
  }

  private getUserTopHoldingAssets(limit = 12): string[] {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT holdings_json
         FROM portfolio_snapshots_hourly
         ORDER BY bucket_hour_utc DESC
         LIMIT 1`,
      )
      .toArray()[0] as { holdings_json?: string } | undefined;
    const holdings = safeJsonParse<Array<{ symbol?: string; value_usd?: number }>>(normalizeSqlString(row?.holdings_json) ?? '[]');
    if (!holdings || !Array.isArray(holdings)) return [];

    const sorted = holdings
      .filter((item) => Number(item.value_usd ?? 0) > 0)
      .sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0))
      .map((item) => this.normalizeAssetSymbol(item.symbol))
      .filter((value): value is string => Boolean(value));

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const symbol of sorted) {
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      deduped.push(symbol);
      if (deduped.length >= limit) break;
    }
    return deduped;
  }

  private normalizeAssetSymbol(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!normalized) return null;
    if (normalized.length < 2 || normalized.length > 16) return null;
    return normalized;
  }

  private normalizeWatchType(value: unknown): WatchlistType | null {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : 'crypto';
    if (normalized === 'crypto' || normalized === 'perps' || normalized === 'stock' || normalized === 'prediction') {
      return normalized;
    }
    return null;
  }

  private normalizeWatchlistChain(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase().slice(0, 32);
    return normalized || null;
  }

  private normalizeWatchlistContract(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase().slice(0, 96);
    if (normalized === 'native') return normalized;
    if (/^0x[a-f0-9]{40}$/.test(normalized)) return normalized;
    return null;
  }

  private normalizeWatchlistItemId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80);
    return normalized || null;
  }

  private normalizeWatchSymbol(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const compact = value.trim().slice(0, 24);
    if (!compact) return null;
    return compact.toUpperCase();
  }

  private normalizeLabel(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().slice(0, max);
    return normalized || null;
  }

  private normalizeOptional(value: unknown, max: number): string | null {
    return this.normalizeLabel(value, max);
  }

  private normalizeWatchChange(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private parseRelatedAssets(raw: string): string[] {
    const parsed = safeJsonParse<unknown[]>(raw) ?? [];
    if (!Array.isArray(parsed)) return [];
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const symbol = this.normalizeAssetSymbol(item);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      deduped.push(symbol);
      if (deduped.length >= 8) break;
    }
    return deduped;
  }

  private toTopicArticleRow(row: TopicSpecialArticleIndexRow, relatedAssets: string[]): ArticleRow {
    const tags = ['topic', 'special', ...relatedAssets.map((asset) => `asset:${asset}`)];
    return {
      id: row.id,
      article_type: 'topic',
      title: row.title,
      summary: row.summary,
      r2_key: row.r2_key,
      tags_json: JSON.stringify(tags),
      created_at: row.generated_at,
      status: row.status || 'ready',
    };
  }

  private async getArticleDetail(articleId: string): Promise<{ article: ArticleRow; markdown: string } | null> {
    const article = this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          article_type,
          title,
          summary,
          r2_key,
          tags_json,
          created_at,
          status
         FROM article_index
         WHERE id = ?
         LIMIT 1`,
        articleId,
      )
      .toArray()[0] as ArticleRow | undefined;

    if (article) {
      const markdown = await this.getArticleMarkdown(article.id, article.r2_key);
      return {
        article,
        markdown,
      };
    }

    if (!(await this.ensureTopicSpecialSchemaReady())) return null;

    let topicRow: TopicSpecialArticleIndexRow | null = null;
    try {
      topicRow = await this.env.DB.prepare(
        `SELECT
           id,
           title,
           summary,
           r2_key,
           related_assets_json,
           generated_at,
           status
         FROM topic_special_articles
         WHERE id = ?
         LIMIT 1`,
      )
        .bind(articleId)
        .first<TopicSpecialArticleIndexRow>();
    } catch (error) {
      console.error('topic_special_detail_query_failed', {
        articleId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!topicRow) return null;

    const relatedAssets = this.parseRelatedAssets(topicRow.related_assets_json);
    const topicArticle = this.toTopicArticleRow(topicRow, relatedAssets);
    const object = await this.env.AGENT_ARTICLES.get(topicRow.r2_key);
    const markdown = object ? await object.text() : '';
    return {
      article: topicArticle,
      markdown,
    };
  }

  private async ensureTopicSpecialSchemaReady(): Promise<boolean> {
    if (this.topicSpecialSchemaReady) return true;
    try {
      await ensureTopicSpecialSchema(this.env.DB);
      this.topicSpecialSchemaReady = true;
      return true;
    } catch (error) {
      console.error('topic_special_schema_init_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async ensureDailyDigestJobs(): Promise<void> {
    const ownerUserId = this.getOwnerUserId();
    if (!ownerUserId) return;

    const now = new Date();
    const today = isoDate(now);
    const hasTodayArticle = this.ctx.storage.sql
      .exec(
        `SELECT id
         FROM article_index
         WHERE article_type = 'daily'
           AND created_at >= ?
           AND created_at < ?
         LIMIT 1`,
        `${today}T00:00:00.000Z`,
        `${tomorrowDate(today)}T00:00:00.000Z`,
      )
      .toArray()[0];

    if (!hasTodayArticle) {
      await this.enqueueJob('daily_digest', new Date().toISOString(), {}, `daily_digest:${today}`);
    }

    const nextRun = nextUtcHour(now, 8);
    const nextDate = isoDate(nextRun);
    await this.enqueueJob('daily_digest', nextRun.toISOString(), {}, `daily_digest:${nextDate}`);
  }

  private hasTodayDailyArticle(now: Date): boolean {
    const today = isoDate(now);
    return Boolean(
      this.ctx.storage.sql
        .exec(
          `SELECT id
           FROM article_index
           WHERE article_type = 'daily'
             AND created_at >= ?
             AND created_at < ?
           LIMIT 1`,
          `${today}T00:00:00.000Z`,
          `${tomorrowDate(today)}T00:00:00.000Z`,
        )
        .toArray()[0],
    );
  }

  private async ensureTodayDailyReady(): Promise<void> {
    const now = new Date();
    if (this.hasTodayDailyArticle(now)) return;
    await this.alarm();
  }

  private getTodayDailyArticle(dateKey: string): ArticleRow | null {
    return (
      (this.ctx.storage.sql
        .exec(
          `SELECT
            id,
            article_type,
            title,
            summary,
            r2_key,
            tags_json,
            created_at,
            status
           FROM article_index
           WHERE article_type = 'daily'
             AND created_at >= ?
             AND created_at < ?
           ORDER BY created_at DESC
           LIMIT 1`,
          `${dateKey}T00:00:00.000Z`,
          `${tomorrowDate(dateKey)}T00:00:00.000Z`,
        )
        .toArray()[0] as ArticleRow | undefined) ?? null
    );
  }

  private getLatestDailyBefore(dateKey: string): ArticleRow | null {
    return (
      (this.ctx.storage.sql
        .exec(
          `SELECT
            id,
            article_type,
            title,
            summary,
            r2_key,
            tags_json,
            created_at,
            status
           FROM article_index
           WHERE article_type = 'daily'
             AND created_at < ?
           ORDER BY created_at DESC
           LIMIT 1`,
          `${dateKey}T00:00:00.000Z`,
        )
        .toArray()[0] as ArticleRow | undefined) ?? null
    );
  }

  private getTodayDailyJobStatus(dateKey: string): TodayDailyStatus {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT status
         FROM jobs
         WHERE job_type = 'daily_digest'
           AND (job_key = ? OR job_key = ?)
         ORDER BY updated_at DESC
         LIMIT 1`,
        `daily_digest:${dateKey}`,
        `manual_daily_digest:${dateKey}`,
      )
      .toArray()[0] as { status?: string } | undefined;

    const status = normalizeSqlString(row?.status);
    if (status === JOB_STATUS_FAILED) return 'failed';
    if (status === JOB_STATUS_QUEUED || status === JOB_STATUS_RUNNING || status === JOB_STATUS_SUCCEEDED) {
      return 'generating';
    }
    return 'stale';
  }

  private async enqueueJob(
    jobType: JobType,
    runAtIso: string,
    payload: Record<string, unknown>,
    jobKey: string | null,
  ): Promise<{ jobId: string; deduped: boolean }> {
    return enqueueJob({
      sql: this.ctx.storage.sql,
      alarmStorage: this.ctx.storage,
      jobType,
      runAtIso,
      payload,
      jobKey,
    });
  }

  private async executeJob(jobType: JobType, payload: Record<string, unknown>): Promise<void> {
    switch (jobType) {
      case 'daily_digest':
        await this.generateDailyDigest(payload);
        return;
      case 'recommendation_refresh':
        await this.refreshRecommendations(payload);
        return;
      case 'topic_generation':
        await this.generateTopicArticle(payload);
        return;
      case 'cleanup':
        return;
      default:
        throw new Error(`unsupported_job_type_${jobType}`);
    }
  }

  private async generateDailyDigest(_payload: Record<string, unknown>): Promise<void> {
    await generateDailyDigestContent(_payload, {
      env: this.env,
      sql: this.ctx.storage.sql,
      getOwnerUserId: () => this.getOwnerUserId(),
      getPreferredLocale: () => this.getEffectiveLocale(),
      getLatestEvents: (limit = 20) => this.getLatestEvents(limit),
      getWatchlistAssets: (limit = 20) => this.getWatchlistAssets(limit),
    });
  }

  private async refreshRecommendations(_payload: Record<string, unknown>): Promise<void> {
    await refreshRecommendationsContent(_payload, {
      env: this.env,
      sql: this.ctx.storage.sql,
      getOwnerUserId: () => this.getOwnerUserId(),
      getPreferredLocale: () => this.getEffectiveLocale(),
      getLatestEvents: (limit = 20) => this.getLatestEvents(limit),
      getWatchlistAssets: (limit = 20) => this.getWatchlistAssets(limit),
    });
  }

  private async generateTopicArticle(payload: Record<string, unknown>): Promise<void> {
    await generateTopicArticleContent(payload, {
      env: this.env,
      sql: this.ctx.storage.sql,
      getOwnerUserId: () => this.getOwnerUserId(),
      getPreferredLocale: () => this.getEffectiveLocale(),
      getLatestEvents: (limit = 20) => this.getLatestEvents(limit),
      getWatchlistAssets: (limit = 20) => this.getWatchlistAssets(limit),
    });
  }

  private async getArticleMarkdown(articleId: string, r2Key: string): Promise<string> {
    return getArticleMarkdownContent(this.env, this.ctx.storage.sql, articleId, r2Key);
  }

  private toHourBucket(asOf: string): string {
    return `${asOf.slice(0, 13)}:00:00.000Z`;
  }

  private toDateBucket(asOf: string): string {
    return asOf.slice(0, 10);
  }

  private savePortfolioSnapshot(asOf: string, totalUsd: number, holdings: unknown[]): void {
    const safeTotalUsd = Number.isFinite(totalUsd) ? totalUsd : 0;
    const hourBucket = this.toHourBucket(asOf);
    const dateBucket = this.toDateBucket(asOf);
    this.ctx.storage.sql.exec(
      `INSERT INTO portfolio_snapshots_hourly (
         bucket_hour_utc, total_usd, holdings_json, as_of, created_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bucket_hour_utc) DO UPDATE SET
         total_usd = excluded.total_usd,
         holdings_json = excluded.holdings_json,
         as_of = excluded.as_of,
         created_at = excluded.created_at`,
      hourBucket,
      safeTotalUsd,
      JSON.stringify(holdings ?? []),
      asOf,
      asOf,
    );

    const isUtcMidnight = asOf.slice(11, 13) === '00';
    if (isUtcMidnight) {
      this.ctx.storage.sql.exec(
        `INSERT INTO portfolio_snapshots_daily (
           bucket_date_utc, total_usd, as_of, created_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(bucket_date_utc) DO UPDATE SET
           total_usd = excluded.total_usd,
           as_of = excluded.as_of,
           created_at = excluded.created_at`,
        dateBucket,
        safeTotalUsd,
        asOf,
        asOf,
      );
    }

    this.cleanupPortfolioSnapshots(asOf);
  }

  private cleanupPortfolioSnapshots(asOf: string): void {
    const nowTs = Date.parse(asOf);
    if (!Number.isFinite(nowTs)) return;
    const hourlyCutoff = new Date(nowTs - HOURLY_SNAPSHOT_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
    const dailyCutoff = new Date(nowTs - DAILY_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    this.ctx.storage.sql.exec('DELETE FROM portfolio_snapshots_hourly WHERE bucket_hour_utc < ?', hourlyCutoff);
    this.ctx.storage.sql.exec('DELETE FROM portfolio_snapshots_daily WHERE bucket_date_utc < ?', dailyCutoff);
  }

  private listPortfolioSnapshots(period: '24h' | '7d' | '30d'): PortfolioSnapshotPoint[] {
    if (period === '24h') {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT bucket_hour_utc as ts, total_usd
           FROM portfolio_snapshots_hourly
           ORDER BY bucket_hour_utc DESC
           LIMIT 24`,
        )
        .toArray() as Array<{ ts?: string; total_usd?: number }>;
      return rows
        .reverse()
        .map((row) => ({
          ts: normalizeSqlString(row.ts) ?? '',
          total_usd: normalizeSqlNumber(row.total_usd),
        }))
        .filter((row) => Boolean(row.ts));
    }

    const limit = period === '7d' ? 7 : 30;
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT bucket_date_utc as ts, total_usd
         FROM portfolio_snapshots_daily
         ORDER BY bucket_date_utc DESC
         LIMIT ?`,
        limit,
      )
      .toArray() as Array<{ ts?: string; total_usd?: number }>;
    return rows
      .reverse()
      .map((row) => {
        const day = normalizeSqlString(row.ts);
        return {
          ts: day ? `${day}T00:00:00.000Z` : '',
          total_usd: normalizeSqlNumber(row.total_usd),
        };
      })
      .filter((row) => Boolean(row.ts));
  }

  private getTransfer(transferId: string): TransferRow | null {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          user_id,
          chain_id,
          from_address,
          to_address,
          token_address,
          token_symbol,
          token_decimals,
          amount_input,
          amount_raw,
          tx_value,
          tx_hash,
          status,
          error_code,
          error_message,
          idempotency_key,
          created_at,
          updated_at,
          submitted_at,
          confirmed_at
         FROM transfers
         WHERE id = ?
         LIMIT 1`,
        transferId,
      )
      .toArray()[0] as TransferRow | undefined;
    return row ?? null;
  }

  private listTransfers(limit: number, status?: TransferRow['status']): TransferRow[] {
    if (status) {
      return this.ctx.storage.sql
        .exec(
          `SELECT
            id,
            user_id,
            chain_id,
            from_address,
            to_address,
            token_address,
            token_symbol,
            token_decimals,
            amount_input,
            amount_raw,
            tx_value,
            tx_hash,
            status,
            error_code,
            error_message,
            idempotency_key,
            created_at,
            updated_at,
            submitted_at,
            confirmed_at
           FROM transfers
           WHERE status = ?
           ORDER BY created_at DESC
           LIMIT ?`,
          status,
          limit,
        )
        .toArray() as TransferRow[];
    }

    return this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          user_id,
          chain_id,
          from_address,
          to_address,
          token_address,
          token_symbol,
          token_decimals,
          amount_input,
          amount_raw,
          tx_value,
          tx_hash,
          status,
          error_code,
          error_message,
          idempotency_key,
          created_at,
          updated_at,
          submitted_at,
          confirmed_at
         FROM transfers
         ORDER BY created_at DESC
         LIMIT ?`,
        limit,
      )
      .toArray() as TransferRow[];
  }
}
