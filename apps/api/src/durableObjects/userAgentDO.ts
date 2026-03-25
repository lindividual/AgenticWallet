import { DurableObject } from 'cloudflare:workers';
import { Keypair } from '@solana/web3.js';
import type { AgentEventRecord } from '../agent/events';
import {
  buildMissingArticleMarkdownFallback,
  deleteArticleMarkdownContent,
  generateDailyDigestContent,
  getArticleMarkdownContent,
  refreshRecommendationsContent,
} from './userAgentContentService';
import { generateWithLlm } from '../services/llm';
import {
  applyAgentPromptConfig,
  applyAgentPromptSkills,
  getAgentPromptConfig,
  getAgentPromptSkills,
} from '../services/agentPromptConfig';
import type { Bindings, WalletProtocol, WalletSummary } from '../types';
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
import { buildTradeShelfContent } from './userAgentTradeShelfService';
import type {
  ArticleRow,
  EventRow,
  JobRow,
  JobType,
  PortfolioSnapshotPoint,
  RecommendationRow,
  TradeShelfItem,
  TradeShelfItemRow,
  TradeShelfResponse,
  TradeShelfSection,
  TradeShelfSectionId,
  TradeShelfStateRow,
  TransferRow,
  TodayDailyStatus,
  WatchlistAssetRow,
} from './userAgentTypes';
import { safeJsonParse } from '../utils/json';
import {
  normalizeAgentChatAction,
  normalizeAgentChatPayload,
  normalizeAgentChatQuickReplyOption,
} from '../agent/chatParsing';
import type { AgentChatToolCall, AgentRuntimeToolName } from '../agent/runtimeTools';
import {
  getAvailableAgentRuntimeTools,
  getRuntimeTokenContext,
  parseAgentRuntimeToolCall,
} from '../agent/runtimeTools';
import {
  buildReceiveAddressesToolResult,
  buildTokenContextToolResult,
  buildWalletContextToolResult,
} from '../agent/runtimeToolFormat';
import type { ArticleRelatedAssetRef } from '../services/articleRelatedAssets';
import { decryptString, encodeBase64, encryptString, generatePrivateKeyHex } from '../utils/crypto';
import { buildMergedPortfolioHoldings, fetchWalletPortfolio } from '../services/market';
import { APP_CONFIG } from '../config/appConfig';
import { normalizeMarketChain, toContractKey } from '../services/assetIdentity';
import {
  fetchBitgetTokenDetail,
  fetchBitgetTokenKline,
  fetchBitgetTokenSecurityAudit,
  type BitgetKlineCandle,
  type BitgetTokenDetail,
  type BitgetTokenSecurityAudit,
} from '../services/bitgetWallet';
import { fetchTopMarketAssets } from '../services/marketTopAssets';
import { fetchSolanaTokenDetails } from '../services/solana';
import { privateKeyToBitcoinSegwitAddress } from '../utils/bitcoin';
import { evmAddressToTronAddress } from '../utils/tron';
import { ensureTopicSpecialSchema } from '../services/topicSpecials';
import {
  ARBITRUM_NETWORK_KEY,
  BNB_NETWORK_KEY,
  BASE_NETWORK_KEY,
  BITCOIN_NETWORK_KEY,
  BTC_PROTOCOL,
  ETHEREUM_NETWORK_KEY,
  EVM_PROTOCOL,
  EVM_WALLET_PROVIDER,
  OPTIMISM_NETWORK_KEY,
  POLYGON_NETWORK_KEY,
  SOLANA_NETWORK_KEY,
  SVM_PROTOCOL,
  TRON_NETWORK_KEY,
  TVM_PROTOCOL,
  type WalletWithPrivateKey,
} from '../services/wallet';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base, bsc, mainnet, optimism, polygon } from 'viem/chains';

const OWNER_KEY = 'owner_user_id';
const USER_LOCALE_KEY = 'user_locale';
const REQUEST_LOCALE_KEY = 'request_locale';
const ACTIVE_UNTIL_KEY = 'active_until';
const RECOMMENDATION_STATE_KEY = 'recommendation_state';
const TRADE_SHELF_STATE_ROW_ID = 'default';
const HOURLY_SNAPSHOT_RETENTION_HOURS = 72;
const DAILY_SNAPSHOT_RETENTION_DAYS = 180;
const TOPIC_FEED_LIMIT_MAX = 10;
const TOPIC_FEED_RECENT_WINDOW_MS = 8 * 60 * 60 * 1000;
const TOPIC_FEED_MATERIALIZE_BATCH_SIZE = 100;

type AgentChatTransferAction = {
  type: 'transfer_preview';
  networkKey: string;
  toAddress: string;
  amount: string;
  tokenSymbol?: string | null;
  tokenAddress?: string | null;
  tokenDecimals?: number | null;
};

type AgentChatQuickReplyOption = {
  label: string;
  message?: string | null;
};

type AgentChatQuickRepliesAction = {
  type: 'quick_replies';
  options: AgentChatQuickReplyOption[];
};

type AgentChatAction = AgentChatTransferAction | AgentChatQuickRepliesAction;

type AgentRuntimeStep =
  | {
      kind: 'tool_call';
      toolCall: AgentChatToolCall;
    }
  | {
      kind: 'final';
      reply: string;
      actions: AgentChatAction[];
    };

type AgentRuntimeToolDefinition = {
  name: AgentRuntimeToolName;
  buildPromptLines: (pageContext: Record<string, string>) => string[];
  execute: (
    args: Record<string, string | null | undefined>,
    pageContext: Record<string, string>,
  ) => Promise<string>;
};

const CHAT_AGENT_STEP_LIMIT = 5;
const READ_ARTICLE_EXCERPT_CHAR_LIMIT = 6_000;

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function extractJsonObject(text: string): string | null {
  const candidate = stripJsonFences(text);
  if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}
const MAX_WATCHLIST_SIZE = 500;
const ACTIVE_USER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECOMMENDATION_REFRESH_COOLDOWN_MS = 30 * 60 * 1000;
const TRADE_SHELF_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

type WatchlistType = 'crypto' | 'perps' | 'prediction';

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

type TopicFeedRow = {
  article_id: string;
  feed_rank: number;
  delivered_at: string;
  generated_at: string;
};

type WalletChainAccountRow = {
  network_key: string;
  chain_id: number | null;
  protocol: WalletProtocol;
  address: string;
};

type PredictionApiKeyCreds = {
  key: string;
  secret: string;
  passphrase: string;
};

type RecommendationState = {
  dirty?: boolean;
  lastRefreshedAt?: string | null;
};

type TradeShelfState = {
  dirty: boolean;
  lastRefreshedAt: string | null;
  generatedAt: string | null;
};

type JobStatusCounts = {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
};

type JobHistoryRow = JobRow & {
  created_at: string;
  updated_at: string;
};

type LatestHourlyPortfolioSnapshot = {
  bucket_hour_utc: string;
  total_usd: number;
  holdings_count: number;
  as_of: string;
  created_at: string;
};

type LatestDailyPortfolioSnapshot = {
  bucket_date_utc: string;
  total_usd: number;
  as_of: string;
  created_at: string;
};

type AgentOpsDashboardData = {
  generated_at: string;
  locale: {
    preferred: string | null;
    request: string | null;
    effective: string | null;
  };
  activity: {
    is_active: boolean;
    active_until: string | null;
    event_count: number;
    recent_events: EventRow[];
  };
  daily: {
    date: string;
    status: TodayDailyStatus;
    article: ArticleRow | null;
    last_ready_article: ArticleRow | null;
  };
  jobs: {
    counts: JobStatusCounts;
    next_queued_run_at: string | null;
    recent: JobHistoryRow[];
  };
  recommendations: {
    dirty: boolean;
    last_refreshed_at: string | null;
    count: number;
    items: RecommendationRow[];
  };
  articles: {
    items: ArticleRow[];
  };
  portfolio: {
    latest_hourly_snapshot: LatestHourlyPortfolioSnapshot | null;
    latest_daily_snapshot: LatestDailyPortfolioSnapshot | null;
    points_24h: PortfolioSnapshotPoint[];
  };
  watchlist: {
    count: number;
    items: WatchlistAssetRow[];
  };
  transfers: {
    count: number;
    items: TransferRow[];
  };
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
    await this.ensurePortfolioSnapshotSchedule();
    await this.ensureTradeShelfRefreshSchedule();
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

  async getWalletRpc(userId: string): Promise<{ wallet: WalletSummary | null }> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    await this.ensureTradeShelfRefreshSchedule();
    const wallet = this.getWalletSummary();
    if (wallet) {
      await this.ensurePortfolioSnapshotSchedule();
    }
    return { wallet };
  }

  async ensureWalletRpc(userId: string): Promise<{ wallet: WalletSummary }> {
    this.ensureOwner(userId);
    const wallet = await this.ensureWallet();
    await this.ensureDailyDigestJobs();
    await this.ensurePortfolioSnapshotSchedule();
    await this.ensureTradeShelfRefreshSchedule();
    return { wallet };
  }

  async upsertWalletRpc(
    userId: string,
    input: {
      wallet: WalletSummary;
      encryptedPrivateKey: string;
      encryptedProtocolKeys: Partial<Record<WalletProtocol, string>>;
    },
  ): Promise<{ ok: true }> {
    this.ensureOwner(userId);
    this.saveWallet(input.wallet, input.encryptedPrivateKey, input.encryptedProtocolKeys);
    await this.ensureDailyDigestJobs();
    await this.ensurePortfolioSnapshotSchedule();
    await this.ensureTradeShelfRefreshSchedule();
    return { ok: true };
  }

  async ensureWalletWithPrivateKeyRpc(userId: string): Promise<{ wallet: WalletWithPrivateKey }> {
    this.ensureOwner(userId);
    const wallet = await this.ensureWalletWithPrivateKey();
    await this.ensureDailyDigestJobs();
    await this.ensurePortfolioSnapshotSchedule();
    await this.ensureTradeShelfRefreshSchedule();
    return { wallet };
  }

  async deleteWalletRpc(userId: string): Promise<{ ok: true }> {
    this.ensureOwner(userId);
    this.deleteWallet();
    return { ok: true };
  }

  async getPredictionApiKeyRpc(userId: string): Promise<{ creds: PredictionApiKeyCreds | null }> {
    this.ensureOwner(userId);
    return { creds: await this.getPredictionApiKey() };
  }

  async upsertPredictionApiKeyRpc(
    userId: string,
    creds: PredictionApiKeyCreds,
  ): Promise<{ ok: true }> {
    this.ensureOwner(userId);
    await this.savePredictionApiKey(creds);
    return { ok: true };
  }

  async deletePredictionApiKeyRpc(userId: string): Promise<{ ok: true }> {
    this.ensureOwner(userId);
    this.deletePredictionApiKey();
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

  async refreshRecommendationsRpc(
    userId: string,
    options?: { force?: boolean },
  ): Promise<{ ok: true; refreshed: boolean }> {
    this.ensureOwner(userId);
    const refreshed = await this.refreshRecommendationsIfNeeded(options?.force === true);
    return { ok: true, refreshed };
  }

  async listTradeShelfRpc(userId: string): Promise<TradeShelfResponse> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    await this.ensureTradeShelfRefreshSchedule();
    return this.getTradeShelfResponse();
  }

  async refreshTradeShelfRpc(
    userId: string,
    options?: { force?: boolean },
  ): Promise<{ ok: true; refreshed: boolean; shelf: TradeShelfResponse }> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    await this.ensureTradeShelfRefreshSchedule();
    const refreshed = await this.refreshTradeShelfIfNeeded(options?.force === true);
    return {
      ok: true,
      refreshed,
      shelf: this.getTradeShelfResponse(),
    };
  }

  async listArticlesRpc(
    userId: string,
    options?: {
      limit?: number;
      offset?: number;
      articleType?: string;
      createdAfter?: string | null;
      createdBefore?: string | null;
    },
  ): Promise<{ articles: ArticleRow[]; hasMore: boolean; nextOffset: number | null }> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    await this.ensureTradeShelfRefreshSchedule();
    await this.ensureTodayDailyReady();
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const articleType = options?.articleType ?? null;
    return this.getArticles(
      limit,
      offset,
      articleType,
      options?.createdAfter ?? null,
      options?.createdBefore ?? null,
    );
  }

  async getArticleDetailRpc(
    userId: string,
    articleId: string,
  ): Promise<{ article: ArticleRow; markdown: string; relatedAssets: ArticleRelatedAssetRef[] } | null> {
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
    await this.ensureTradeShelfRefreshSchedule();
    const runAt = normalizeOccurredAt(options.runAt);
    const result = await this.enqueueJob(options.jobType, runAt, options.payload ?? {}, options.jobKey ?? null);
    return { ok: true, ...result };
  }

  async runJobsNowRpc(userId: string): Promise<{ ok: true }> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    await this.ensureTradeShelfRefreshSchedule();
    await this.alarm();
    return { ok: true };
  }

  async regenerateTodayDailyRpc(userId: string): Promise<{
    ok: true;
    deletedArticleIds: string[];
    article: ArticleRow | null;
  }> {
    this.ensureOwner(userId);
    await this.ensureTradeShelfRefreshSchedule();
    const dateKey = isoDate(new Date());
    const { deletedArticleIds, article } = await this.regenerateTodayDaily(dateKey, 'manual_regenerate');
    return {
      ok: true,
      deletedArticleIds,
      article,
    };
  }

  async getOpsDashboardRpc(
    userId: string,
    options?: {
      recentJobLimit?: number;
      recentEventLimit?: number;
      recommendationLimit?: number;
      articleLimit?: number;
      watchlistLimit?: number;
      transferLimit?: number;
    },
  ): Promise<AgentOpsDashboardData> {
    this.ensureOwner(userId);
    await this.ensureDailyDigestJobs();
    await this.ensureTradeShelfRefreshSchedule();
    await this.ensureTodayDailyReady();

    const now = new Date();
    const dateKey = isoDate(now);
    const recommendationState = this.getRecommendationState();
    const article = this.getTodayDailyArticle(dateKey);
    const lastReadyArticle = this.getLatestDailyBefore(dateKey);

    return {
      generated_at: now.toISOString(),
      locale: {
        preferred: this.getLocaleByKey(USER_LOCALE_KEY),
        request: this.getLocaleByKey(REQUEST_LOCALE_KEY),
        effective: this.getEffectiveLocale(),
      },
      activity: {
        is_active: this.isUserActive(now.toISOString()),
        active_until: this.getActiveUntil(),
        event_count: this.countEvents(),
        recent_events: this.getLatestEvents(options?.recentEventLimit ?? 12),
      },
      daily: {
        date: dateKey,
        status: article ? 'ready' : this.getTodayDailyJobStatus(dateKey),
        article,
        last_ready_article: lastReadyArticle,
      },
      jobs: {
        counts: this.getJobStatusCounts(),
        next_queued_run_at: this.getNextQueuedJobRunAt(),
        recent: this.getRecentJobs(options?.recentJobLimit ?? 12),
      },
      recommendations: {
        dirty: recommendationState.dirty === true,
        last_refreshed_at: recommendationState.lastRefreshedAt ?? null,
        count: this.countActiveRecommendations(),
        items: this.getRecommendations(options?.recommendationLimit ?? 6),
      },
      articles: {
        items: (await this.getArticles(options?.articleLimit ?? 6)).articles,
      },
      portfolio: {
        latest_hourly_snapshot: this.getLatestHourlyPortfolioSnapshot(),
        latest_daily_snapshot: this.getLatestDailyPortfolioSnapshot(),
        points_24h: this.listPortfolioSnapshots('24h'),
      },
      watchlist: {
        count: this.countWatchlistAssets(),
        items: this.getWatchlistAssets(options?.watchlistLimit ?? 8),
      },
      transfers: {
        count: this.countTransfers(),
        items: this.listTransfers(options?.transferLimit ?? 8),
      },
    };
  }

  async savePortfolioSnapshotRpc(
    userId: string,
    input: { totalUsd: number; holdings: unknown[]; asOf?: string },
  ): Promise<{ ok: true }> {
    this.ensureOwner(userId);
    const asOf = normalizeOccurredAt(input.asOf);
    this.savePortfolioSnapshot(asOf, input.totalUsd, input.holdings ?? []);
    this.markRecommendationsDirty();
    this.markTradeShelfDirty();
    await this.ensurePortfolioSnapshotSchedule(asOf);
    await this.ensureTradeShelfRefreshSchedule(asOf);
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
      networkKey: string;
      chainId: number | null;
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
        network_key,
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
      input.networkKey,
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
    const asset = this.upsertWatchlistAsset(input);
    this.markRecommendationsDirty();
    this.markTradeShelfDirty();
    await this.ensureTradeShelfRefreshSchedule();
    return { asset };
  }

  async removeWatchlistAssetRpc(
    userId: string,
    input: { id?: string | null; chain?: string | null; contract?: string | null },
  ): Promise<{ removed: boolean }> {
    this.ensureOwner(userId);
    const removed = this.removeWatchlistAsset(input.id ?? null, input.chain ?? null, input.contract ?? null);
    this.markRecommendationsDirty();
    this.markTradeShelfDirty();
    await this.ensureTradeShelfRefreshSchedule();
    return { removed };
  }

  async chatRpc(
    userId: string,
    request: {
      sessionId: string;
      page: string;
      pageContext?: Record<string, string>;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    },
  ): Promise<{ reply: string; sessionId: string; actions?: AgentChatAction[] }> {
    this.ensureOwner(userId);

    const pageContext = request.pageContext ?? {};
    const toolDefinitions = this.getAvailableChatToolDefinitions(request.page, pageContext);
    const availableTools = toolDefinitions.map((definition) => definition.name);
    const baseSystemPrompt = this.buildChatSystemPrompt(request.page, pageContext, toolDefinitions);
    const promptConfig = await getAgentPromptConfig(this.env.DB);
    const promptSkills = await getAgentPromptSkills(this.env.DB);
    const configuredPrompt = applyAgentPromptConfig(baseSystemPrompt, promptConfig);
    const systemPrompt = applyAgentPromptSkills(configuredPrompt, promptSkills);
    const llmMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...request.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    let reply: string;
    let actions: AgentChatAction[] = [];
    try {
      for (let attempt = 0; attempt < CHAT_AGENT_STEP_LIMIT; attempt += 1) {
        const result = await generateWithLlm(this.env, {
          messages: llmMessages,
          temperature: 0.5,
          maxTokens: 500,
          retryAttempts: 2,
          maxRetryDelayMs: 5_000,
        });
        const runtimeStep = this.parseAgentRuntimeStep(result.text, request.page, availableTools);
        if (runtimeStep.kind === 'tool_call') {
          if (attempt >= CHAT_AGENT_STEP_LIMIT - 1) {
            reply = this.getToolCallSuppressedReply(request.page);
            actions = [];
            return { reply, sessionId: request.sessionId, actions };
          }

          const toolResult = await this.executeAgentRuntimeTool(runtimeStep.toolCall, pageContext, toolDefinitions);
          llmMessages.push({ role: 'assistant', content: stripJsonFences(result.text) });
          llmMessages.push({ role: 'system', content: toolResult });
          llmMessages.push({
            role: 'system',
            content: 'Continue the same task using the tool result above. Return raw JSON only. Either call another available tool with {"type":"tool_call","tool":"...","arguments":{...}} or finish with {"type":"final","reply":"string","actions":[]}. Never expose the internal tool protocol to the user.',
          });
          continue;
        }

        reply = runtimeStep.reply;
        actions = runtimeStep.actions;
        return { reply, sessionId: request.sessionId, actions };
      }

      reply = this.getFallbackChatReply(request.page);
      actions = [];
    } catch {
      reply = this.getFallbackChatReply(request.page);
      actions = [];
    }

    return { reply, sessionId: request.sessionId, actions };
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
        event_type,
        payload_json,
        dedupe_key,
        occurred_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      event.eventId,
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
      const itemId = typeof payload.itemId === 'string' ? payload.itemId : null;
      const marketType = typeof payload.marketType === 'string' ? payload.marketType : null;
      try {
        this.upsertWatchlistAsset({
          watchType: this.resolveWatchTypeFromFavoriteEvent(marketType),
          chain,
          contract,
          itemId: itemId ?? (chain && contract ? `${chain.trim().toLowerCase()}:${contract.trim().toLowerCase()}` : null),
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
      this.markRecommendationsDirty();
    }
    if (
      event.type === 'asset_viewed'
      || event.type === 'asset_favorited'
      || event.type === 'trade_buy'
      || event.type === 'trade_sell'
    ) {
      this.markTradeShelfDirty();
    }
    await this.ensureDailyDigestJobs();
    await this.ensurePortfolioSnapshotSchedule();
    await this.ensureTradeShelfRefreshSchedule();

    return {
      ok: true,
      eventId: event.eventId,
      deduped: false,
      sequence: this.countEvents(),
    };
  }

  private ensureOwner(userId: string): void {
    const nowIso = new Date().toISOString();
    const row = this.ctx.storage.sql
      .exec('SELECT value_json FROM agent_state WHERE key = ? LIMIT 1', OWNER_KEY)
      .toArray()[0] as Record<string, unknown> | undefined;
    const valueJson = normalizeSqlString(row?.value_json);
    if (!valueJson) {
      this.ctx.storage.sql.exec(
        'INSERT INTO agent_state (key, value_json, updated_at) VALUES (?, ?, ?)',
        OWNER_KEY,
        JSON.stringify({ userId }),
        nowIso,
      );
      this.markUserActive(nowIso);
      return;
    }

    const parsed = JSON.parse(valueJson) as { userId?: string };
    if (parsed.userId !== userId) {
      throw new Error('user_id_mismatch_for_agent');
    }
    this.markUserActive(nowIso);
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

  private normalizeWalletProtocol(raw: string | null | undefined): WalletProtocol | null {
    if (raw === EVM_PROTOCOL || raw === SVM_PROTOCOL || raw === TVM_PROTOCOL || raw === BTC_PROTOCOL) return raw;
    return null;
  }

  private getWalletChainAccounts(): WalletChainAccountRow[] {
    return (this.ctx.storage.sql
      .exec(
        `SELECT network_key, chain_id, protocol, address
         FROM wallet_chain_accounts
         ORDER BY network_key ASC`,
      )
      .toArray() as Array<{
        network_key?: string;
        chain_id?: number | null;
        protocol?: string | null;
        address?: string;
      }>)
      .map((row) => ({
        network_key: normalizeSqlString(row.network_key) ?? '',
        chain_id: row.chain_id == null ? null : Number(row.chain_id),
        protocol: this.normalizeWalletProtocol(normalizeSqlString(row.protocol)) ?? EVM_PROTOCOL,
        address: normalizeSqlString(row.address) ?? '',
      }))
      .filter((row) => Boolean(row.network_key) && Boolean(row.address));
  }

  private getWalletProtocolKeyMap(): Partial<Record<WalletProtocol, string>> {
    const output: Partial<Record<WalletProtocol, string>> = {};
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT protocol, encrypted_key_material
         FROM wallet_protocol_keys`,
      )
      .toArray() as Array<{ protocol?: string | null; encrypted_key_material?: string | null }>;

    for (const row of rows) {
      const protocol = this.normalizeWalletProtocol(normalizeSqlString(row.protocol));
      const encryptedKeyMaterial = normalizeSqlString(row.encrypted_key_material);
      if (!protocol || !encryptedKeyMaterial) continue;
      output[protocol] = encryptedKeyMaterial;
    }
    return output;
  }

  private getWalletSummary(): WalletSummary | null {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT address, provider
         FROM wallet
         LIMIT 1`,
      )
      .toArray()[0] as { address?: string | null; provider?: string | null } | undefined;

    const address = normalizeSqlString(row?.address);
    const provider = normalizeSqlString(row?.provider);
    if (!address || !provider) return null;

    return {
      address,
      provider,
      chainAccounts: this.getWalletChainAccounts().map((account) => ({
        networkKey: account.network_key,
        chainId: account.chain_id,
        protocol: account.protocol,
        address: account.address,
      })),
    };
  }

  private getWalletWithPrivateKey(): WalletWithPrivateKey | null {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT address, provider, encrypted_private_key
         FROM wallet
         LIMIT 1`,
      )
      .toArray()[0] as {
        address?: string | null;
        provider?: string | null;
        encrypted_private_key?: string | null;
      } | undefined;

    const address = normalizeSqlString(row?.address);
    const provider = normalizeSqlString(row?.provider);
    const encryptedPrivateKey = normalizeSqlString(row?.encrypted_private_key);
    if (!address || !provider || !encryptedPrivateKey) return null;

    const protocolKeys = this.getWalletProtocolKeyMap();
    return {
      address,
      provider,
      encryptedPrivateKey: protocolKeys[EVM_PROTOCOL] ?? encryptedPrivateKey,
      encryptedProtocolKeys: protocolKeys,
      chainAccounts: this.getWalletChainAccounts().map((account) => ({
        networkKey: account.network_key,
        chainId: account.chain_id,
        protocol: account.protocol,
        address: account.address,
      })),
    };
  }

  private async getPredictionApiKey(): Promise<PredictionApiKeyCreds | null> {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT encrypted_api_key, encrypted_secret, encrypted_passphrase
         FROM prediction_api_keys
         WHERE account_key = ?
         LIMIT 1`,
        'default',
      )
      .toArray()[0] as {
        encrypted_api_key?: string | null;
        encrypted_secret?: string | null;
        encrypted_passphrase?: string | null;
      } | undefined;

    const encryptedKey = normalizeSqlString(row?.encrypted_api_key);
    const encryptedSecret = normalizeSqlString(row?.encrypted_secret);
    const encryptedPassphrase = normalizeSqlString(row?.encrypted_passphrase);
    if (!encryptedKey || !encryptedSecret || !encryptedPassphrase) return null;

    return {
      key: await decryptString(encryptedKey, this.env.APP_SECRET),
      secret: await decryptString(encryptedSecret, this.env.APP_SECRET),
      passphrase: await decryptString(encryptedPassphrase, this.env.APP_SECRET),
    };
  }

  private async savePredictionApiKey(creds: PredictionApiKeyCreds): Promise<void> {
    const now = new Date().toISOString();
    const [encryptedKey, encryptedSecret, encryptedPassphrase] = await Promise.all([
      encryptString(creds.key, this.env.APP_SECRET),
      encryptString(creds.secret, this.env.APP_SECRET),
      encryptString(creds.passphrase, this.env.APP_SECRET),
    ]);
    this.ctx.storage.sql.exec(
      `INSERT INTO prediction_api_keys (
         account_key, encrypted_api_key, encrypted_secret, encrypted_passphrase, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_key) DO UPDATE SET
         encrypted_api_key = excluded.encrypted_api_key,
         encrypted_secret = excluded.encrypted_secret,
         encrypted_passphrase = excluded.encrypted_passphrase,
         updated_at = excluded.updated_at`,
      'default',
      encryptedKey,
      encryptedSecret,
      encryptedPassphrase,
      now,
      now,
    );
  }

  private deletePredictionApiKey(): void {
    this.ctx.storage.sql.exec('DELETE FROM prediction_api_keys');
  }

  private saveWallet(
    wallet: WalletSummary,
    encryptedPrivateKey: string,
    encryptedProtocolKeys: Partial<Record<WalletProtocol, string>>,
  ): void {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec('DELETE FROM wallet');
    this.ctx.storage.sql.exec('DELETE FROM wallet_chain_accounts');
    this.ctx.storage.sql.exec('DELETE FROM wallet_protocol_keys');
    this.ctx.storage.sql.exec(
      `INSERT INTO wallet (
         address, provider, encrypted_private_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
      wallet.address,
      wallet.provider,
      encryptedPrivateKey,
      now,
      now,
    );

    for (const chain of wallet.chainAccounts) {
      this.ctx.storage.sql.exec(
        `INSERT INTO wallet_chain_accounts (
           network_key, chain_id, protocol, address, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        chain.networkKey,
        chain.chainId,
        chain.protocol,
        chain.address,
        now,
        now,
      );
    }

    const protocolKeyEntries = Object.entries(encryptedProtocolKeys) as Array<[WalletProtocol, string]>;
    for (const [protocol, encryptedKeyMaterial] of protocolKeyEntries) {
      if (!encryptedKeyMaterial) continue;
      const keyFormat = protocol === SVM_PROTOCOL ? 'solana_secret_key_base64' : 'hex_private_key';
      this.ctx.storage.sql.exec(
        `INSERT INTO wallet_protocol_keys (
           protocol, encrypted_key_material, key_format, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
        protocol,
        encryptedKeyMaterial,
        keyFormat,
        now,
        now,
      );
    }
  }

  private deleteWallet(): void {
    this.ctx.storage.sql.exec('DELETE FROM wallet');
    this.ctx.storage.sql.exec('DELETE FROM wallet_chain_accounts');
    this.ctx.storage.sql.exec('DELETE FROM wallet_protocol_keys');
    this.ctx.storage.sql.exec('DELETE FROM prediction_api_keys');
  }

  private async createWallet(): Promise<WalletWithPrivateKey> {
    const privateKey = generatePrivateKeyHex();
    const evmAccount = privateKeyToAccount(privateKey);
    const bitcoinAddress = privateKeyToBitcoinSegwitAddress(privateKey);
    const tronAddress = evmAddressToTronAddress(evmAccount.address);
    const solanaKeypair = Keypair.generate();
    const solanaSecretKey = encodeBase64(solanaKeypair.secretKey);
    const encryptedPrivateKey = await encryptString(privateKey, this.env.APP_SECRET);
    const encryptedSolanaKey = await encryptString(solanaSecretKey, this.env.APP_SECRET);

    const chainAccounts: WalletSummary['chainAccounts'] = [
      { networkKey: ETHEREUM_NETWORK_KEY, chainId: mainnet.id, protocol: EVM_PROTOCOL, address: evmAccount.address },
      { networkKey: BASE_NETWORK_KEY, chainId: base.id, protocol: EVM_PROTOCOL, address: evmAccount.address },
      { networkKey: BNB_NETWORK_KEY, chainId: bsc.id, protocol: EVM_PROTOCOL, address: evmAccount.address },
      { networkKey: ARBITRUM_NETWORK_KEY, chainId: arbitrum.id, protocol: EVM_PROTOCOL, address: evmAccount.address },
      { networkKey: OPTIMISM_NETWORK_KEY, chainId: optimism.id, protocol: EVM_PROTOCOL, address: evmAccount.address },
      { networkKey: POLYGON_NETWORK_KEY, chainId: polygon.id, protocol: EVM_PROTOCOL, address: evmAccount.address },
      { networkKey: TRON_NETWORK_KEY, chainId: null, protocol: TVM_PROTOCOL, address: tronAddress },
      { networkKey: SOLANA_NETWORK_KEY, chainId: null, protocol: SVM_PROTOCOL, address: solanaKeypair.publicKey.toBase58() },
      { networkKey: BITCOIN_NETWORK_KEY, chainId: null, protocol: BTC_PROTOCOL, address: bitcoinAddress },
    ];
    const primaryAddress =
      chainAccounts.find((chain) => chain.networkKey === ETHEREUM_NETWORK_KEY)?.address ?? chainAccounts[0]?.address ?? evmAccount.address;

    const wallet: WalletWithPrivateKey = {
      address: primaryAddress,
      provider: EVM_WALLET_PROVIDER,
      encryptedPrivateKey,
      encryptedProtocolKeys: {
        [EVM_PROTOCOL]: encryptedPrivateKey,
        [TVM_PROTOCOL]: encryptedPrivateKey,
        [BTC_PROTOCOL]: encryptedPrivateKey,
        [SVM_PROTOCOL]: encryptedSolanaKey,
      },
      chainAccounts,
    };
    this.saveWallet(wallet, encryptedPrivateKey, wallet.encryptedProtocolKeys);
    return wallet;
  }

  private async ensureWallet(): Promise<WalletSummary> {
    const wallet = this.getWalletSummary();
    if (wallet) return wallet;
    return this.createWallet();
  }

  private async ensureWalletWithPrivateKey(): Promise<WalletWithPrivateKey> {
    const wallet = this.getWalletWithPrivateKey();
    if (wallet) return wallet;
    return this.createWallet();
  }

  private getAgentState<T>(key: string): T | null {
    const row = this.ctx.storage.sql
      .exec('SELECT value_json FROM agent_state WHERE key = ? LIMIT 1', key)
      .toArray()[0] as Record<string, unknown> | undefined;
    const valueJson = normalizeSqlString(row?.value_json);
    if (!valueJson) return null;
    return safeJsonParse<T>(valueJson) ?? null;
  }

  private setAgentState(key: string, value: unknown): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_state (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      new Date().toISOString(),
    );
  }

  private markUserActive(referenceIso?: string): void {
    const referenceDate = referenceIso ? new Date(referenceIso) : new Date();
    if (!Number.isFinite(referenceDate.getTime())) return;
    const activeUntil = new Date(referenceDate.getTime() + ACTIVE_USER_WINDOW_MS).toISOString();
    this.setAgentState(ACTIVE_UNTIL_KEY, { activeUntil });
  }

  private isUserActive(referenceIso?: string): boolean {
    const state = this.getAgentState<{ activeUntil?: string | null }>(ACTIVE_UNTIL_KEY);
    const activeUntil = normalizeSqlString(state?.activeUntil);
    if (!activeUntil) return false;
    const activeUntilMs = Date.parse(activeUntil);
    if (!Number.isFinite(activeUntilMs)) return false;
    const referenceMs = referenceIso ? Date.parse(referenceIso) : Date.now();
    if (!Number.isFinite(referenceMs)) return false;
    return activeUntilMs > referenceMs;
  }

  private getActiveUntil(): string | null {
    const state = this.getAgentState<{ activeUntil?: string | null }>(ACTIVE_UNTIL_KEY);
    return normalizeSqlString(state?.activeUntil);
  }

  private getRecommendationState(): RecommendationState {
    return this.getAgentState<RecommendationState>(RECOMMENDATION_STATE_KEY) ?? { dirty: true, lastRefreshedAt: null };
  }

  private setRecommendationState(next: RecommendationState): void {
    this.setAgentState(RECOMMENDATION_STATE_KEY, next);
  }

  private markRecommendationsDirty(): void {
    const state = this.getRecommendationState();
    this.setRecommendationState({
      ...state,
      dirty: true,
    });
  }

  private async refreshRecommendationsIfNeeded(force: boolean): Promise<boolean> {
    const state = this.getRecommendationState();
    const hasRecommendations = this.getRecommendations(1).length > 0;
    const lastRefreshedAtMs = state.lastRefreshedAt ? Date.parse(state.lastRefreshedAt) : Number.NaN;
    const withinCooldown =
      Number.isFinite(lastRefreshedAtMs) && Date.now() - lastRefreshedAtMs < RECOMMENDATION_REFRESH_COOLDOWN_MS;
    if (!force && hasRecommendations && !state.dirty) return false;
    if (!force && hasRecommendations && withinCooldown) return false;

    await this.refreshRecommendations({ trigger: force ? 'manual' : 'direct' });
    this.setRecommendationState({
      dirty: false,
      lastRefreshedAt: new Date().toISOString(),
    });
    return true;
  }

  private getTradeShelfState(): TradeShelfState {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          dirty,
          last_refreshed_at,
          generated_at,
          updated_at
         FROM trade_shelf_state
         WHERE id = ?
         LIMIT 1`,
        TRADE_SHELF_STATE_ROW_ID,
      )
      .toArray()[0] as TradeShelfStateRow | undefined;

    return {
      dirty: Number(row?.dirty ?? 1) === 1,
      lastRefreshedAt: normalizeSqlString(row?.last_refreshed_at),
      generatedAt: normalizeSqlString(row?.generated_at),
    };
  }

  private setTradeShelfState(next: TradeShelfState): void {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO trade_shelf_state (
        id,
        dirty,
        last_refreshed_at,
        generated_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dirty = excluded.dirty,
        last_refreshed_at = excluded.last_refreshed_at,
        generated_at = excluded.generated_at,
        updated_at = excluded.updated_at`,
      TRADE_SHELF_STATE_ROW_ID,
      next.dirty ? 1 : 0,
      next.lastRefreshedAt,
      next.generatedAt,
      now,
    );
  }

  private markTradeShelfDirty(): void {
    const state = this.getTradeShelfState();
    this.setTradeShelfState({
      ...state,
      dirty: true,
    });
  }

  private hasTradeShelfItems(): boolean {
    const row = this.ctx.storage.sql
      .exec('SELECT id FROM trade_shelf_items LIMIT 1')
      .toArray()[0] as Record<string, unknown> | undefined;
    return Boolean(normalizeSqlString(row?.id));
  }

  private getTradeShelfNeedsRefresh(state: TradeShelfState): boolean {
    if (state.dirty) return true;
    const lastRefreshedAtMs = state.lastRefreshedAt ? Date.parse(state.lastRefreshedAt) : Number.NaN;
    if (!Number.isFinite(lastRefreshedAtMs)) return true;
    return Date.now() - lastRefreshedAtMs >= TRADE_SHELF_REFRESH_INTERVAL_MS;
  }

  private getTradeShelfSections(): TradeShelfSection[] {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          section_id,
          section_title,
          item_rank,
          item_kind,
          item_id,
          symbol,
          title,
          image,
          chain,
          contract,
          current_price,
          change_24h,
          probability,
          volume_24h,
          reason_tag,
          score,
          created_at,
          updated_at
         FROM trade_shelf_items
         ORDER BY
           CASE section_id
             WHEN 'holdings' THEN 0
             WHEN 'behavior' THEN 1
             WHEN 'fresh' THEN 2
             ELSE 9
           END ASC,
           item_rank ASC`,
      )
      .toArray() as TradeShelfItemRow[];

    const sections = new Map<TradeShelfSectionId, TradeShelfSection>();
    for (const row of rows) {
      const sectionId = row.section_id;
      if (!sections.has(sectionId)) {
        sections.set(sectionId, {
          id: sectionId,
          title: row.section_title,
          items: [],
        });
      }
      sections.get(sectionId)?.items.push({
        id: row.id,
        kind: row.item_kind,
        itemId: row.item_id,
        symbol: row.symbol,
        title: row.title,
        image: row.image ?? null,
        chain: row.chain ?? null,
        contract: row.contract ?? null,
        currentPrice: row.current_price ?? null,
        change24h: row.change_24h ?? null,
        probability: row.probability ?? null,
        volume24h: row.volume_24h ?? null,
        reasonTag: row.reason_tag,
      } satisfies TradeShelfItem);
    }

    return ['holdings', 'behavior', 'fresh']
      .map((sectionId) => sections.get(sectionId as TradeShelfSectionId))
      .filter((section): section is TradeShelfSection => Boolean(section));
  }

  private replaceTradeShelfItems(generatedAt: string, sections: TradeShelfSection[]): void {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec('DELETE FROM trade_shelf_items');
    for (const section of sections) {
      for (let index = 0; index < section.items.length; index += 1) {
        const item = section.items[index];
        this.ctx.storage.sql.exec(
          `INSERT INTO trade_shelf_items (
            id,
            section_id,
            section_title,
            item_rank,
            item_kind,
            item_id,
            symbol,
            title,
            image,
            chain,
            contract,
            current_price,
            change_24h,
            probability,
            volume_24h,
            reason_tag,
            score,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          item.id,
          section.id,
          section.title,
          index,
          item.kind,
          item.itemId,
          item.symbol,
          item.title,
          item.image,
          item.chain,
          item.contract,
          item.currentPrice,
          item.change24h,
          item.probability,
          item.volume24h,
          item.reasonTag,
          0,
          generatedAt,
          now,
        );
      }
    }
  }

  private getTradeShelfResponse(): TradeShelfResponse {
    const state = this.getTradeShelfState();
    return {
      generatedAt: state.generatedAt,
      refreshState: {
        dirty: state.dirty,
        lastRefreshedAt: state.lastRefreshedAt,
        needsRefresh: this.getTradeShelfNeedsRefresh(state),
      },
      sections: this.getTradeShelfSections(),
    };
  }

  private async refreshTradeShelfIfNeeded(force: boolean): Promise<boolean> {
    const state = this.getTradeShelfState();
    const hasShelfItems = this.hasTradeShelfItems();
    if (!force && hasShelfItems && !this.getTradeShelfNeedsRefresh(state)) return false;

    const { generatedAt, sections } = await buildTradeShelfContent({
      env: this.env,
      sql: this.ctx.storage.sql,
      getOwnerUserId: () => this.getOwnerUserId(),
      getLatestEvents: (limit = 20) => this.getLatestEvents(limit),
      getWatchlistAssets: (limit = 20) => this.getWatchlistAssets(limit),
    });
    this.replaceTradeShelfItems(generatedAt, sections);
    this.setTradeShelfState({
      dirty: false,
      lastRefreshedAt: new Date().toISOString(),
      generatedAt,
    });
    return true;
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

  private countActiveRecommendations(): number {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT COUNT(*) as count
         FROM recommendations
         WHERE valid_until IS NULL
            OR valid_until > ?`,
        new Date().toISOString(),
      )
      .toArray()[0] as Record<string, unknown> | undefined;
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
    const sanitizedLimit = sanitizeLimit(limit, 1, MAX_WATCHLIST_SIZE);
    const candidateLimit = Math.min(MAX_WATCHLIST_SIZE, Math.max(sanitizedLimit * 3, sanitizedLimit));
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT
          id,
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
        candidateLimit,
      )
      .toArray() as WatchlistAssetRow[];

    return rows
      .filter((row) => !this.isLegacySyntheticCryptoMarketWatch(row))
      .slice(0, sanitizedLimit);
  }

  private countWatchlistAssets(): number {
    return this.getWatchlistAssets(MAX_WATCHLIST_SIZE).length;
  }

  private countTransfers(): number {
    const row = this.ctx.storage.sql
      .exec('SELECT COUNT(*) as count FROM transfers')
      .toArray()[0] as Record<string, unknown> | undefined;
    return normalizeSqlNumber(row?.count);
  }

  private getRecentJobs(limit = 12): JobHistoryRow[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          job_type,
          run_at,
          status,
          payload_json,
          result_json,
          retry_count,
          job_key,
          created_at,
          updated_at
         FROM jobs
         ORDER BY updated_at DESC, created_at DESC
         LIMIT ?`,
        sanitizeLimit(limit, 1, 50),
      )
      .toArray() as JobHistoryRow[];
  }

  private getJobStatusCounts(): JobStatusCounts {
    const counts: JobStatusCounts = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
    };
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT status, COUNT(*) as count
         FROM jobs
         GROUP BY status`,
      )
      .toArray() as Array<{ status?: string | null; count?: number | null }>;

    for (const row of rows) {
      const status = normalizeSqlString(row.status);
      if (!status) continue;
      if (status === JOB_STATUS_QUEUED) counts.queued = normalizeSqlNumber(row.count);
      if (status === JOB_STATUS_RUNNING) counts.running = normalizeSqlNumber(row.count);
      if (status === JOB_STATUS_SUCCEEDED) counts.succeeded = normalizeSqlNumber(row.count);
      if (status === JOB_STATUS_FAILED) counts.failed = normalizeSqlNumber(row.count);
    }

    return counts;
  }

  private getNextQueuedJobRunAt(): string | null {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT run_at
         FROM jobs
         WHERE status = ?
         ORDER BY run_at ASC
         LIMIT 1`,
        JOB_STATUS_QUEUED,
      )
      .toArray()[0] as Record<string, unknown> | undefined;
    return normalizeSqlString(row?.run_at);
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

  private upsertWatchlistAsset(input: WatchlistAssetUpsertInput): WatchlistAssetRow {
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
    const existing = this.ctx.storage.sql
      .exec(
        `SELECT
          id,
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
         WHERE chain = ?
           AND contract = ?
         LIMIT 1`,
        chain,
        contract,
      )
      .toArray()[0] as WatchlistAssetRow | undefined;

    const symbol = symbolValue
      ?? existing?.symbol
      ?? (nameValue ? nameValue.slice(0, 24).toUpperCase() : contract.slice(0, 24).toUpperCase());
    const name = nameValue ?? existing?.name ?? symbol;
    const image = this.normalizeOptional(input.image, 512) ?? existing?.image ?? null;
    const source = this.normalizeOptional(input.source, 64) ?? existing?.source ?? null;
    const externalUrl = this.normalizeOptional(input.externalUrl, 1024) ?? existing?.external_url ?? null;
    const change24h = this.normalizeWatchChange(input.change24h) ?? existing?.change_24h ?? null;
    const resolvedItemId = itemId ?? existing?.item_id ?? null;
    const now = new Date().toISOString();

    this.ctx.storage.sql.exec(
      `INSERT INTO user_watchlist_assets (
         id,
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
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain, contract) DO UPDATE SET
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
      watchType,
      resolvedItemId,
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
         WHERE chain = ?
           AND contract = ?
         LIMIT 1`,
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
           WHERE id = ?
           LIMIT 1`,
          id,
        )
        .toArray()[0] as { id?: string } | undefined;
      if (!row?.id) return false;
      this.ctx.storage.sql.exec(
        `DELETE FROM user_watchlist_assets
         WHERE id = ?`,
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
         WHERE chain = ?
           AND contract = ?
         LIMIT 1`,
        chain,
        contract,
      )
      .toArray()[0] as { id?: string } | undefined;
    if (!row?.id) return false;

    this.ctx.storage.sql.exec(
      `DELETE FROM user_watchlist_assets
       WHERE chain = ?
         AND contract = ?`,
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
         WHERE valid_until IS NULL
            OR valid_until > ?
         ORDER BY generated_at DESC
         LIMIT ?`,
        new Date().toISOString(),
        sanitizeLimit(limit, 1, 100),
      )
      .toArray() as RecommendationRow[];
  }

  private async getArticles(
    limit = 20,
    offset = 0,
    articleType: string | null = null,
    createdAfter: string | null = null,
    createdBefore: string | null = null,
  ): Promise<{ articles: ArticleRow[]; hasMore: boolean; nextOffset: number | null }> {
    const safeLimit = sanitizeLimit(limit, 1, 100);
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    const normalizedType = articleType?.trim().toLowerCase() ?? null;

    if (normalizedType === 'topic') {
      return this.getPersonalizedTopicArticles(safeLimit, safeOffset, createdAfter, createdBefore);
    }

    if (normalizedType) {
      const localRows = this.getLocalArticles(safeLimit + 1, safeOffset, normalizedType, createdAfter, createdBefore);
      const articles = localRows.slice(0, safeLimit);
      return {
        articles,
        hasMore: localRows.length > safeLimit,
        nextOffset: localRows.length > safeLimit ? safeOffset + articles.length : null,
      };
    }

    const mergeLimit = Math.min(100, Math.max((safeLimit + safeOffset + 1) * 2, 20));
    const [localArticles, topicArticles] = await Promise.all([
      Promise.resolve(this.getLocalArticles(mergeLimit, 0, null, createdAfter, createdBefore)),
      this.getPersonalizedTopicArticles(mergeLimit, 0, createdAfter, createdBefore).then((result) => result.articles),
    ]);

    const deduped = new Map<string, ArticleRow>();
    for (const article of [...localArticles, ...topicArticles]) {
      if (!deduped.has(article.id)) {
        deduped.set(article.id, article);
      }
    }

    const mergedAll = Array.from(deduped.values())
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(safeOffset, safeOffset + safeLimit + 1);
    const merged = mergedAll.slice(0, safeLimit);
    return {
      articles: merged,
      hasMore: mergedAll.length > safeLimit,
      nextOffset: mergedAll.length > safeLimit ? safeOffset + merged.length : null,
    };
  }

  private getLocalArticles(
    limit = 20,
    offset = 0,
    articleType: string | null = null,
    createdAfter: string | null = null,
    createdBefore: string | null = null,
  ): ArticleRow[] {
    const safeLimit = sanitizeLimit(limit, 1, 100);
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    const normalizedType = articleType?.trim();
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (normalizedType) {
      conditions.push('article_type = ?');
      bindings.push(normalizedType);
    }
    if (createdAfter) {
      conditions.push('created_at >= ?');
      bindings.push(createdAfter);
    }
    if (createdBefore) {
      conditions.push('created_at < ?');
      bindings.push(createdBefore);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
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
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?
         OFFSET ?`,
        ...bindings,
        safeLimit,
        safeOffset,
      )
      .toArray() as ArticleRow[];
  }

  private async getPersonalizedTopicArticles(
    limit = 20,
    offset = 0,
    createdAfter: string | null = null,
    createdBefore: string | null = null,
  ): Promise<{ articles: ArticleRow[]; hasMore: boolean; nextOffset: number | null }> {
    if (!(await this.ensureTopicSpecialSchemaReady())) {
      return { articles: [], hasMore: false, nextOffset: null };
    }
    const safeLimit = Math.min(TOPIC_FEED_LIMIT_MAX, sanitizeLimit(limit, 1, TOPIC_FEED_LIMIT_MAX));
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    await this.materializeNewTopicFeedEntries();
    return this.getFrozenTopicFeedArticles(safeLimit, safeOffset, createdAfter, createdBefore);
  }

  private async materializeNewTopicFeedEntries(): Promise<void> {
    const latestDeliveredAt = this.getLatestDeliveredTopicGeneratedAt();
    const recentCutoff = new Date(Date.now() - TOPIC_FEED_RECENT_WINDOW_MS).toISOString();
    const latestNewRows = await this.listAllTopicSpecialRows({
      generatedAfterExclusive: latestDeliveredAt,
    });
    const recentRows = latestNewRows.filter((row) => row.generated_at >= recentCutoff);
    const olderRows = latestNewRows.filter((row) => row.generated_at < recentCutoff);
    const selected = [
      ...this.rankTopicRowsForUser(recentRows).map((item) => item.row),
      ...olderRows,
    ];

    if (selected.length > 0) {
      this.insertTopicFeedRows(selected);
    }
  }

  private async getFrozenTopicFeedArticles(
    limit: number,
    offset: number,
    createdAfter: string | null,
    createdBefore: string | null,
  ): Promise<{ articles: ArticleRow[]; hasMore: boolean; nextOffset: number | null }> {
    const feedRows = this.getTopicFeedRows(limit + 1, offset, createdAfter, createdBefore);
    if (feedRows.length === 0) {
      return { articles: [], hasMore: false, nextOffset: null };
    }

    const topicRowsById = await this.getTopicSpecialRowsByIds(feedRows.map((row) => row.article_id));
    const articles: ArticleRow[] = [];
    for (const feedRow of feedRows.slice(0, limit)) {
      const topicRow = topicRowsById.get(feedRow.article_id);
      if (!topicRow) continue;
      articles.push(this.toTopicArticleRow(topicRow, this.parseRelatedAssets(topicRow.related_assets_json)));
    }
    const hasMore = feedRows.length > limit;
    return {
      articles,
      hasMore,
      nextOffset: hasMore ? offset + articles.length : null,
    };
  }

  private getLatestDeliveredTopicGeneratedAt(): string | null {
    const row = this.ctx.storage.sql
      .exec('SELECT MAX(generated_at) as generated_at FROM user_topic_feed')
      .toArray()[0] as Record<string, unknown> | undefined;
    return normalizeSqlString(row?.generated_at);
  }

  private getTopicFeedRows(
    limit: number,
    offset: number,
    createdAfter: string | null,
    createdBefore: string | null,
  ): TopicFeedRow[] {
    const safeLimit = sanitizeLimit(limit, 1, 100);
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    const conditions: string[] = [];
    const bindings: unknown[] = [];
    if (createdAfter) {
      conditions.push('generated_at >= ?');
      bindings.push(createdAfter);
    }
    if (createdBefore) {
      conditions.push('generated_at < ?');
      bindings.push(createdBefore);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.ctx.storage.sql
      .exec(
        `SELECT
          article_id,
          feed_rank,
          delivered_at,
          generated_at
         FROM user_topic_feed
         ${whereClause}
         ORDER BY feed_rank ASC
         LIMIT ?
         OFFSET ?`,
        ...bindings,
        safeLimit,
        safeOffset,
      )
      .toArray() as TopicFeedRow[];
  }

  private insertTopicFeedRows(rows: TopicSpecialArticleIndexRow[]): void {
    const uniqueRows = new Map<string, TopicSpecialArticleIndexRow>();
    for (const row of rows) {
      if (!uniqueRows.has(row.id)) uniqueRows.set(row.id, row);
    }
    const items = Array.from(uniqueRows.values());
    if (items.length === 0) return;

    const minRankRow = this.ctx.storage.sql
      .exec('SELECT MIN(feed_rank) as min_rank FROM user_topic_feed')
      .toArray()[0] as Record<string, unknown> | undefined;
    const minRank = Number.isFinite(Number(minRankRow?.min_rank)) ? Number(minRankRow?.min_rank) : 1;
    const startRank = minRank - items.length;
    const deliveredAt = new Date().toISOString();

    for (const [index, row] of items.entries()) {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO user_topic_feed (
          article_id,
          feed_rank,
          delivered_at,
          generated_at
        ) VALUES (?, ?, ?, ?)`,
        row.id,
        startRank + index,
        deliveredAt,
        row.generated_at,
      );
    }
  }

  private async listTopicSpecialRows(
    limit: number,
    options?: {
      createdAfter?: string | null;
      createdBefore?: string | null;
      generatedAfterExclusive?: string | null;
      generatedAfterInclusive?: string | null;
      generatedBeforeExclusive?: string | null;
    },
  ): Promise<TopicSpecialArticleIndexRow[]> {
    let rows: { results?: TopicSpecialArticleIndexRow[] };
    try {
      const conditions = [`status = 'ready'`];
      const bindings: unknown[] = [];
      if (options?.createdAfter) {
        conditions.push('generated_at >= ?');
        bindings.push(options.createdAfter);
      }
      if (options?.createdBefore) {
        conditions.push('generated_at < ?');
        bindings.push(options.createdBefore);
      }
      if (options?.generatedAfterExclusive) {
        conditions.push('generated_at > ?');
        bindings.push(options.generatedAfterExclusive);
      }
      if (options?.generatedAfterInclusive) {
        conditions.push('generated_at >= ?');
        bindings.push(options.generatedAfterInclusive);
      }
      if (options?.generatedBeforeExclusive) {
        conditions.push('generated_at < ?');
        bindings.push(options.generatedBeforeExclusive);
      }
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
         WHERE ${conditions.join(' AND ')}
         ORDER BY generated_at DESC
         LIMIT ?`,
      )
        .bind(...bindings, Math.min(100, Math.max(1, limit)))
        .all<TopicSpecialArticleIndexRow>();
    } catch (error) {
      console.error('topic_special_query_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    return rows.results ?? [];
  }

  private async listAllTopicSpecialRows(options?: {
    createdAfter?: string | null;
    createdBefore?: string | null;
    generatedAfterExclusive?: string | null;
    generatedAfterInclusive?: string | null;
    generatedBeforeExclusive?: string | null;
  }): Promise<TopicSpecialArticleIndexRow[]> {
    const output: TopicSpecialArticleIndexRow[] = [];
    let cursorBefore = options?.createdBefore ?? options?.generatedBeforeExclusive ?? null;

    while (true) {
      const batch = await this.listTopicSpecialRows(TOPIC_FEED_MATERIALIZE_BATCH_SIZE, {
        createdAfter: options?.createdAfter ?? null,
        createdBefore: cursorBefore,
        generatedAfterExclusive: options?.generatedAfterExclusive ?? null,
        generatedAfterInclusive: options?.generatedAfterInclusive ?? null,
      });
      if (batch.length === 0) break;
      output.push(...batch);
      if (batch.length < TOPIC_FEED_MATERIALIZE_BATCH_SIZE) break;
      const lastGeneratedAt = batch[batch.length - 1]?.generated_at ?? null;
      if (!lastGeneratedAt || lastGeneratedAt === cursorBefore) break;
      cursorBefore = lastGeneratedAt;
    }

    return output;
  }

  private async getTopicSpecialRowsByIds(articleIds: string[]): Promise<Map<string, TopicSpecialArticleIndexRow>> {
    const uniqueIds = Array.from(new Set(articleIds.map((value) => value.trim()).filter(Boolean)));
    if (uniqueIds.length === 0) return new Map();
    try {
      const placeholders = uniqueIds.map(() => '?').join(', ');
      const result = await this.env.DB.prepare(
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
           AND id IN (${placeholders})`,
      )
        .bind(...uniqueIds)
        .all<TopicSpecialArticleIndexRow>();
      return new Map((result.results ?? []).map((row) => [row.id, row]));
    } catch (error) {
      console.error('topic_special_feed_detail_query_failed', {
        message: error instanceof Error ? error.message : String(error),
        articleIdCount: uniqueIds.length,
      });
      return new Map();
    }
  }

  private rankTopicRowsForUser(rows: TopicSpecialArticleIndexRow[]): Array<{
    row: TopicSpecialArticleIndexRow;
    relatedAssets: string[];
    rankScore: number;
  }> {
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

    const scored = rows.map((row, index) => {
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

    return scored;
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
    if (normalized === 'crypto' || normalized === 'perps' || normalized === 'prediction') {
      return normalized;
    }
    return null;
  }

  private resolveWatchTypeFromFavoriteEvent(value: unknown): WatchlistType {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'perp') return 'perps';
    if (normalized === 'prediction') return normalized;
    return 'crypto';
  }

  private isLegacySyntheticCryptoMarketWatch(row: WatchlistAssetRow): boolean {
    return row.watch_type === 'crypto'
      && row.chain === 'watch:crypto'
      && row.source === 'trade_market_detail';
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

  private parseRelatedAssetRefs(raw: string): ArticleRelatedAssetRef[] {
    const parsed = safeJsonParse<unknown[]>(raw) ?? [];
    if (!Array.isArray(parsed)) return [];
    const refs: ArticleRelatedAssetRef[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const ref = this.normalizeRelatedAssetRef(item);
      if (!ref || seen.has(ref.symbol)) continue;
      seen.add(ref.symbol);
      refs.push(ref);
      if (refs.length >= 8) break;
    }
    return refs;
  }

  private parseRelatedAssets(raw: string): string[] {
    return this.parseRelatedAssetRefs(raw).map((item) => item.symbol);
  }

  private normalizeRelatedAssetRef(input: unknown): ArticleRelatedAssetRef | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const row = input as Record<string, unknown>;
    const symbol = this.normalizeAssetSymbol(row.symbol);
    if (!symbol) return null;
    const chain = typeof row.chain === 'string' ? row.chain.trim().toLowerCase() || null : null;
    const contract = typeof row.contract === 'string'
      ? (chain === 'sol' ? row.contract.trim() : row.contract.trim().toLowerCase()) || null
      : null;
    const priceChange = Number(row.price_change_percentage_24h);
    return {
      symbol,
      market_type:
        row.market_type === 'spot' || row.market_type === 'perp' || row.market_type === 'prediction'
          ? row.market_type
          : null,
      market_item_id: typeof row.market_item_id === 'string' ? row.market_item_id.trim() || null : null,
      asset_id: typeof row.asset_id === 'string' ? row.asset_id.trim() || null : null,
      chain,
      contract,
      name: typeof row.name === 'string' ? row.name.trim() || null : null,
      image: typeof row.image === 'string' ? row.image.trim() || null : null,
      price_change_percentage_24h: Number.isFinite(priceChange) ? priceChange : null,
    };
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

  private async getArticleDetail(articleId: string): Promise<{
    article: ArticleRow;
    markdown: string;
    relatedAssets: ArticleRelatedAssetRef[];
  } | null> {
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
      if (!markdown && article.article_type === 'daily' && article.created_at.slice(0, 10) === isoDate(new Date())) {
        const regenerated = await this.regenerateTodayDaily(article.created_at.slice(0, 10), 'missing_markdown_repair');
        if (regenerated.article) {
          const regeneratedMarkdown = await this.getArticleMarkdown(regenerated.article.id, regenerated.article.r2_key);
          if (regeneratedMarkdown) {
            return {
              article: regenerated.article,
              markdown: regeneratedMarkdown,
              relatedAssets: [],
            };
          }
          return {
            article: regenerated.article,
            markdown: buildMissingArticleMarkdownFallback({
              title: regenerated.article.title,
              summary: regenerated.article.summary,
              articleType: regenerated.article.article_type,
              createdAt: regenerated.article.created_at,
            }),
            relatedAssets: [],
          };
        }
      }
      return {
        article,
        markdown: markdown || buildMissingArticleMarkdownFallback({
          title: article.title,
          summary: article.summary,
          articleType: article.article_type,
          createdAt: article.created_at,
        }),
        relatedAssets: [],
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

    const relatedAssetRefs = this.parseRelatedAssetRefs(topicRow.related_assets_json);
    const topicArticle = this.toTopicArticleRow(topicRow, relatedAssetRefs.map((item) => item.symbol));
    const markdown = await getArticleMarkdownContent(this.env, topicArticle.id, topicRow.r2_key);
    return {
      article: topicArticle,
      markdown: markdown || buildMissingArticleMarkdownFallback({
        title: topicArticle.title,
        summary: topicArticle.summary,
        articleType: topicArticle.article_type,
        createdAt: topicArticle.created_at,
      }),
      relatedAssets: relatedAssetRefs,
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

  private async ensurePortfolioSnapshotSchedule(referenceIso?: string): Promise<void> {
    if (!this.getOwnerUserId()) return;
    if (!this.getWalletSummary()) return;
    if (!this.isUserActive(referenceIso)) return;

    const referenceDate = referenceIso ? new Date(referenceIso) : new Date();
    if (!Number.isFinite(referenceDate.getTime())) return;

    const nextRun = new Date(referenceDate);
    nextRun.setUTCMinutes(0, 0, 0);
    nextRun.setUTCHours(nextRun.getUTCHours() + 1);
    const jobKey = `portfolio_snapshot:${nextRun.toISOString().slice(0, 13)}`;
    await this.enqueueJob('portfolio_snapshot', nextRun.toISOString(), {}, jobKey);
  }

  private async ensureTradeShelfRefreshSchedule(referenceIso?: string): Promise<void> {
    if (!this.getOwnerUserId()) return;
    if (!this.isUserActive(referenceIso)) return;

    const referenceDate = referenceIso ? new Date(referenceIso) : new Date();
    if (!Number.isFinite(referenceDate.getTime())) return;

    const nextRun = new Date(referenceDate);
    nextRun.setUTCMinutes(0, 0, 0);
    const nextHour = nextRun.getUTCHours() - (nextRun.getUTCHours() % 4) + 4;
    nextRun.setUTCHours(nextHour, 0, 0, 0);
    if (nextRun.getTime() <= referenceDate.getTime()) {
      nextRun.setUTCHours(nextRun.getUTCHours() + 4, 0, 0, 0);
    }
    const jobKey = `trade_shelf_refresh:${nextRun.toISOString().slice(0, 13)}`;
    await this.enqueueJob('trade_shelf_refresh', nextRun.toISOString(), {}, jobKey);
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

  private getDailyArticlesForDate(dateKey: string): ArticleRow[] {
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
         WHERE article_type = 'daily'
           AND created_at >= ?
           AND created_at < ?
         ORDER BY created_at DESC`,
        `${dateKey}T00:00:00.000Z`,
        `${tomorrowDate(dateKey)}T00:00:00.000Z`,
      )
      .toArray() as ArticleRow[];
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

  private async deleteDailyArticlesForDate(dateKey: string): Promise<string[]> {
    const articles = this.getDailyArticlesForDate(dateKey);
    for (const article of articles) {
      try {
        await deleteArticleMarkdownContent(this.env, article.r2_key);
      } catch (error) {
        console.error('article_markdown_delete_failed', {
          articleId: article.id,
          r2Key: article.r2_key,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.ctx.storage.sql.exec(
      `DELETE FROM article_index
       WHERE article_type = 'daily'
         AND created_at >= ?
         AND created_at < ?`,
      `${dateKey}T00:00:00.000Z`,
      `${tomorrowDate(dateKey)}T00:00:00.000Z`,
    );
    return articles.map((article) => article.id);
  }

  private deleteTodayDailyJobs(dateKey: string): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM jobs
       WHERE job_type = 'daily_digest'
         AND (job_key = ? OR job_key = ?)`,
      `daily_digest:${dateKey}`,
      `manual_daily_digest:${dateKey}`,
    );
  }

  private async regenerateTodayDaily(
    dateKey: string,
    trigger: 'manual_regenerate' | 'missing_markdown_repair',
  ): Promise<{ deletedArticleIds: string[]; article: ArticleRow | null }> {
    const deletedArticleIds = await this.deleteDailyArticlesForDate(dateKey);
    this.deleteTodayDailyJobs(dateKey);
    await this.generateDailyDigest({ trigger });
    return {
      deletedArticleIds,
      article: this.getTodayDailyArticle(dateKey),
    };
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

  private async executeJob(jobType: JobType, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    switch (jobType) {
      case 'daily_digest':
        return this.generateDailyDigest(payload);
      case 'portfolio_snapshot':
        return this.capturePortfolioSnapshot();
      case 'trade_shelf_refresh':
        return this.refreshTradeShelf(payload);
      default:
        throw new Error(`unsupported_job_type_${jobType}`);
    }
  }

  private async generateDailyDigest(_payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return generateDailyDigestContent(_payload, {
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

  private async refreshTradeShelf(_payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const refreshed = await this.refreshTradeShelfIfNeeded(true);
    await this.ensureTradeShelfRefreshSchedule();
    return {
      kind: 'trade_shelf_refresh',
      refreshed,
      generatedAt: this.getTradeShelfState().generatedAt,
      sectionCount: this.getTradeShelfSections().length,
    };
  }

  private async capturePortfolioSnapshot(): Promise<Record<string, unknown>> {
    const wallet = this.getWalletSummary();
    const walletAddress = wallet?.address ?? wallet?.chainAccounts?.[0]?.address ?? null;
    if (!wallet) {
      return {
        kind: 'portfolio_snapshot',
        skipped: true,
        reason: 'wallet_missing',
        walletAddress,
      };
    }
    if (!this.isUserActive()) {
      return {
        kind: 'portfolio_snapshot',
        skipped: true,
        reason: 'user_inactive',
        walletAddress,
      };
    }
    const result = await fetchWalletPortfolio(this.env, wallet);
    this.savePortfolioSnapshot(result.asOf, result.totalUsd, result.holdings);
    this.markRecommendationsDirty();
    this.markTradeShelfDirty();
    await this.ensurePortfolioSnapshotSchedule(result.asOf);
    await this.ensureTradeShelfRefreshSchedule(result.asOf);
    return {
      kind: 'portfolio_snapshot',
      skipped: false,
      walletAddress,
      asOf: result.asOf,
      totalUsd: result.totalUsd,
      holdingsCount: Array.isArray(result.holdings) ? result.holdings.length : 0,
    };
  }

  private async getArticleMarkdown(articleId: string, r2Key: string): Promise<string> {
    return getArticleMarkdownContent(this.env, articleId, r2Key);
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

  private getLatestHourlyPortfolioSnapshot(): LatestHourlyPortfolioSnapshot | null {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT
          bucket_hour_utc,
          total_usd,
          holdings_json,
          as_of,
          created_at
         FROM portfolio_snapshots_hourly
         ORDER BY bucket_hour_utc DESC
         LIMIT 1`,
      )
      .toArray()[0] as
      | {
          bucket_hour_utc?: string | null;
          total_usd?: number | null;
          holdings_json?: string | null;
          as_of?: string | null;
          created_at?: string | null;
        }
      | undefined;

    if (!row) return null;
    const holdings = safeJsonParse<unknown[]>(normalizeSqlString(row.holdings_json) ?? '[]') ?? [];
    return {
      bucket_hour_utc: normalizeSqlString(row.bucket_hour_utc) ?? '',
      total_usd: normalizeSqlNumber(row.total_usd),
      holdings_count: Array.isArray(holdings) ? holdings.length : 0,
      as_of: normalizeSqlString(row.as_of) ?? '',
      created_at: normalizeSqlString(row.created_at) ?? '',
    };
  }

  private getLatestDailyPortfolioSnapshot(): LatestDailyPortfolioSnapshot | null {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT
          bucket_date_utc,
          total_usd,
          as_of,
          created_at
         FROM portfolio_snapshots_daily
         ORDER BY bucket_date_utc DESC
         LIMIT 1`,
      )
      .toArray()[0] as
      | {
          bucket_date_utc?: string | null;
          total_usd?: number | null;
          as_of?: string | null;
          created_at?: string | null;
        }
      | undefined;

    if (!row) return null;
    return {
      bucket_date_utc: normalizeSqlString(row.bucket_date_utc) ?? '',
      total_usd: normalizeSqlNumber(row.total_usd),
      as_of: normalizeSqlString(row.as_of) ?? '',
      created_at: normalizeSqlString(row.created_at) ?? '',
    };
  }

  private getAvailableChatToolDefinitions(
    page: string,
    pageContext: Record<string, string>,
  ): AgentRuntimeToolDefinition[] {
    const availableTools = getAvailableAgentRuntimeTools(page, pageContext);
    const tokenContext = getRuntimeTokenContext(pageContext);

    const registry: Record<AgentRuntimeToolName, AgentRuntimeToolDefinition> = {
      read_article: {
        name: 'read_article',
        buildPromptLines: () => [
          '- Hidden tool available: read_article.',
          '- Use read_article when the user asks for a summary, explanation, verification, or details from the current article.',
          `- Tool contract: {"type":"tool_call","tool":"read_article","arguments":{}}. Current article id: ${pageContext.articleId}.`,
        ],
        execute: (args, context) => this.executeReadArticleTool(args, context),
      },
      read_token_context: {
        name: 'read_token_context',
        buildPromptLines: () => [
          '- Hidden tool available: read_token_context.',
          '- Use read_token_context when you need price, risk, trend, watchlist status, or the user position for the current token.',
          `- Tool contract: {"type":"tool_call","tool":"read_token_context","arguments":{}}. Current token: ${tokenContext.tokenSymbol ?? tokenContext.tokenName ?? 'current token'} on ${tokenContext.tokenChain ?? 'unknown'} ${tokenContext.tokenContract ?? ''}.`,
        ],
        execute: (args, context) => this.executeReadTokenContextTool(args, context),
      },
      read_wallet_context: {
        name: 'read_wallet_context',
        buildPromptLines: () => [
          '- Hidden tool available: read_wallet_context.',
          '- Use read_wallet_context when you need live portfolio context, top holdings, concentration, or address coverage.',
          '- Tool contract: {"type":"tool_call","tool":"read_wallet_context","arguments":{}}.',
        ],
        execute: () => this.executeReadWalletContextTool(),
      },
      read_receive_addresses: {
        name: 'read_receive_addresses',
        buildPromptLines: () => [
          '- Hidden tool available: read_receive_addresses.',
          '- Use read_receive_addresses when the user asks which receive address to share or which chain maps to which address.',
          '- Tool contract: {"type":"tool_call","tool":"read_receive_addresses","arguments":{}}.',
        ],
        execute: () => this.executeReadReceiveAddressesTool(),
      },
    };

    return availableTools.map((tool) => registry[tool]);
  }

  private buildChatSystemPrompt(
    page: string,
    pageContext: Record<string, string>,
    toolDefinitions: AgentRuntimeToolDefinition[],
  ): string {
    const isReceiveFlow = pageContext.receiveMode === 'true';
    const tokenContext = getRuntimeTokenContext(pageContext);
    const pageDescriptions: Record<string, string> = {
      home: 'the home screen showing daily digest, recommendations, and wallet entry points',
      trade: 'the trading screen with market overview, top movers, perps, and predictions',
      wallet: 'the wallet screen showing balances, holdings, and transfer tools',
      article: 'reading a content article generated by the agent',
      token: `viewing token details${tokenContext.tokenSymbol ? ` for ${tokenContext.tokenSymbol}` : ''}${tokenContext.tokenChain ? ` on ${tokenContext.tokenChain}` : ''}`,
      market: `viewing market details for a ${pageContext.marketType ?? 'market'} item`,
    };
    const pageDesc = isReceiveFlow
      ? 'the wallet receive flow where the user is choosing which receive address to share'
      : pageDescriptions[page] ?? `the ${page} page`;

    const ambientContextLines = [
      tokenContext.tokenName ? `Current token name: ${tokenContext.tokenName}.` : '',
      tokenContext.tokenChain ? `Current token chain: ${tokenContext.tokenChain}.` : '',
      tokenContext.tokenContract ? `Current token contract: ${tokenContext.tokenContract}.` : '',
      pageContext.articleId ? `Current article id: ${pageContext.articleId}.` : '',
      pageContext.marketType ? `Current market type: ${pageContext.marketType}.` : '',
      pageContext.marketItemId ? `Current market item id: ${pageContext.marketItemId}.` : '',
      isReceiveFlow ? 'Receive mode is active for this chat.' : '',
      pageContext.receiveSupportedChains ? `Configured supported receive chains: ${pageContext.receiveSupportedChains}.` : '',
      pageContext.receiveSupportedEvmChains ? `Configured EVM receive chains: ${pageContext.receiveSupportedEvmChains}.` : '',
      pageContext.receiveSupportedTronChains ? `Configured Tron receive chains: ${pageContext.receiveSupportedTronChains}.` : '',
      pageContext.receiveSupportedSolanaChains ? `Configured Solana receive chains: ${pageContext.receiveSupportedSolanaChains}.` : '',
      pageContext.receiveSupportedBitcoinChains ? `Configured Bitcoin receive chains: ${pageContext.receiveSupportedBitcoinChains}.` : '',
      pageContext.receiveAddressEvm ? `EVM receive address: ${pageContext.receiveAddressEvm}.` : '',
      pageContext.receiveAddressTron ? `Tron receive address: ${pageContext.receiveAddressTron}.` : '',
      pageContext.receiveAddressSolana ? `Solana receive address: ${pageContext.receiveAddressSolana}.` : '',
      pageContext.receiveAddressBitcoin ? `Bitcoin receive address: ${pageContext.receiveAddressBitcoin}.` : '',
    ].filter(Boolean);

    const locale = this.getEffectiveLocale();
    const langHint = locale?.startsWith('zh')
      ? 'Respond in Chinese (中文).'
      : locale?.startsWith('ar')
        ? 'Respond in Arabic (العربية).'
        : 'Respond in the same language as the user.';

    return [
      'You are a helpful AI assistant for umi wallet, a crypto wallet and trading app.',
      `The user is currently on ${pageDesc}.`,
      ...ambientContextLines,
      'Guidelines:',
      '- Be concise and direct (2-3 sentences max per response).',
      '- Offer actionable suggestions related to the current page.',
      '- If asked about specific assets, provide general guidance and avoid financial guarantees.',
      '- If the user gives a short affirmative reply after you offered help on the token page, treat it as a request to analyze the current token immediately.',
      '- This chat runs in an internal multi-step agent runtime. Return raw JSON only and do not wrap it in markdown fences.',
      '- When you are ready to answer the user, return {"type":"final","reply":"string","actions":[]}.',
      '- When you need a tool before answering, return {"type":"tool_call","tool":"tool_name","arguments":{}}.',
      '- Never expose internal tool JSON, tool names, or protocol details to the user.',
      '- After a tool result arrives, continue the same task and either call another hidden tool or finish with a final response.',
      `- Supported transfer network keys: ${ETHEREUM_NETWORK_KEY} (Ethereum), ${BASE_NETWORK_KEY} (Base), ${BNB_NETWORK_KEY} (BNB Chain), ${TRON_NETWORK_KEY} (Tron), ${SOLANA_NETWORK_KEY} (Solana), ${BITCOIN_NETWORK_KEY} (Bitcoin).`,
      '- When it would help the user choose a next step, you may include one quick reply action like {"type":"quick_replies","options":[{"label":"Analyze risks","message":"Analyze the main risks of this token."},{"label":"Compare with BTC","message":"Compare this token with BTC."}]}.',
      '- Keep quick reply labels short, useful, and tappable. Prefer 2-4 options, and do not repeat the exact same wording as the reply sentence.',
      '- When you ask the user to choose from a small known set, include quick_replies instead of only listing the choices in plain text.',
      '- Actions are only for user-facing UI actions such as quick_replies or transfer_preview.',
      '- Never place hidden tools inside actions.',
      '- Only include a transfer_preview action when the transfer recipient, network, asset, and amount are all explicit or clearly implied by the current page context.',
      '- When transfer details are incomplete, ask for exactly one missing field at a time in this order: recipient address, then network, then asset, then amount.',
      '- If the user refers to the current token on the token page, you may use the current token symbol and contract from context as the asset.',
      '- If the asset is the native asset for that network, set tokenAddress to null.',
      '- When all required transfer details are present, include one action like {"type":"transfer_preview","networkKey":"...","toAddress":"...","amount":"...","tokenSymbol":"ETH","tokenAddress":null,"tokenDecimals":null}.',
      '- Never invent recipient addresses, contract addresses, token decimals, amounts, or unsupported assets. Ask a concise follow-up question when details are missing or ambiguous.',
      '- For receive-address guidance, first use any receive chains and addresses already present in the current context.',
      '- If the correct receive network is clear from the user message and current context, give the exact matching receive address directly.',
      '- If multiple receive addresses are available, explain which network maps to which address and do not ask the user to provide their own receive address.',
      '- Use the hidden receive-address tool only when the current context is missing the needed receive mapping or you need to double-check it.',
      ...toolDefinitions.flatMap((definition) => definition.buildPromptLines(pageContext)),
      `- ${langHint}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private parseAgentRuntimeStep(
    text: string,
    page: string,
    availableTools: AgentRuntimeToolName[],
  ): AgentRuntimeStep {
    const toolCall = parseAgentRuntimeToolCall(text, availableTools);
    if (toolCall) {
      return {
        kind: 'tool_call',
        toolCall,
      };
    }

    const parsed = this.parseChatLlmOutput(text, page, availableTools);
    return {
      kind: 'final',
      reply: parsed.reply,
      actions: parsed.actions,
    };
  }

  private async executeAgentRuntimeTool(
    toolCall: AgentChatToolCall,
    pageContext: Record<string, string>,
    toolDefinitions: AgentRuntimeToolDefinition[],
  ): Promise<string> {
    const definition = toolDefinitions.find((candidate) => candidate.name === toolCall.tool) ?? null;
    if (!definition) return `Tool result: unsupported tool ${toolCall.tool}.`;
    return definition.execute(toolCall.arguments, pageContext);
  }

  private async executeReadArticleTool(
    args: Record<string, string | null | undefined>,
    pageContext: Record<string, string>,
  ): Promise<string> {
    const articleId = args.articleId?.trim() || pageContext.articleId?.trim() || '';
    if (!articleId) {
      return 'Tool result for read_article: unavailable because no article id was provided.';
    }

    const detail = await this.getArticleDetail(articleId);
    if (!detail) {
      return `Tool result for read_article: article ${articleId} was not found.`;
    }

    const relatedAssets = detail.relatedAssets
      .slice(0, 8)
      .map((asset) => {
        const symbol = asset.symbol?.trim() || asset.name?.trim() || 'unknown';
        const chain = asset.chain?.trim();
        const contract = asset.contract?.trim();
        const priceChange = Number.isFinite(Number(asset.price_change_percentage_24h))
          ? ` (${Number(asset.price_change_percentage_24h).toFixed(2)}% 24h)`
          : '';
        const location = chain
          ? contract
            ? ` on ${chain} ${contract}`
            : ` on ${chain}`
          : '';
        return `${symbol}${location}${priceChange}`;
      })
      .filter(Boolean)
      .join(', ');

    const markdown = this.buildArticleExcerptForChat(detail.markdown);

    return [
      `Tool result for read_article (${articleId}):`,
      `Title: ${detail.article.title}`,
      `Summary: ${detail.article.summary}`,
      `Article type: ${detail.article.article_type}`,
      `Created at: ${detail.article.created_at}`,
      relatedAssets ? `Related assets: ${relatedAssets}` : '',
      'Article body excerpt:',
      markdown,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildArticleExcerptForChat(markdown: string): string {
    const normalized = markdown.replace(/\r\n/g, '\n').trim();
    if (!normalized) return '(empty article body)';

    const withoutLeadingHeading = normalized.replace(/^\uFEFF?(?:\s*\n)*#(?!#)[ \t]+[^\n]+(?:\n+|$)/, '').trimStart();
    if (withoutLeadingHeading.length <= READ_ARTICLE_EXCERPT_CHAR_LIMIT) {
      return withoutLeadingHeading;
    }

    return `${withoutLeadingHeading.slice(0, READ_ARTICLE_EXCERPT_CHAR_LIMIT).trimEnd()}\n\n[article excerpt truncated]`;
  }

  private async executeReadTokenContextTool(
    args: Record<string, string | null | undefined>,
    pageContext: Record<string, string>,
  ): Promise<string> {
    const tokenContext = getRuntimeTokenContext(pageContext);
    const tokenChain = args.tokenChain?.trim() || tokenContext.tokenChain || '';
    const tokenContract = args.tokenContract?.trim() || tokenContext.tokenContract || '';
    const tokenSymbol = args.tokenSymbol?.trim() || tokenContext.tokenSymbol || null;
    const tokenName = args.tokenName?.trim() || tokenContext.tokenName || null;
    if (!tokenChain || !tokenContract) {
      return 'Tool result for read_token_context: unavailable because the current token identity is incomplete.';
    }

    const normalizedChain = normalizeMarketChain(tokenChain);
    const normalizedContract = toContractKey(tokenContract, normalizedChain);
    const [detail, audit, candles, wallet, watchlistAssets] = await Promise.all([
      this.resolveTokenDetailForTool(normalizedChain, normalizedContract, tokenSymbol).catch(() => null),
      fetchBitgetTokenSecurityAudit(this.env, normalizedChain, normalizedContract).catch(() => null),
      fetchBitgetTokenKline(this.env, { chain: normalizedChain, contract: normalizedContract, period: '1h', size: 24 }).catch(() => []),
      Promise.resolve(this.getWalletSummary()),
      Promise.resolve(this.getWatchlistAssets(MAX_WATCHLIST_SIZE)),
    ]);

    let holding: {
      symbol: string | null;
      valueUsd: number;
      portfolioWeightPct: number | null;
      networkCount: number;
    } | null = null;
    if (wallet) {
      const portfolio = await fetchWalletPortfolio(this.env, wallet).catch(() => null);
      if (portfolio) {
        const merged = await buildMergedPortfolioHoldings(this.env, portfolio.holdings).catch(() => []);
        const matched = merged.find((item) => item.variants.some((variant) => (
          variant.market_chain === normalizedChain && variant.contract_key === normalizedContract
        ))) ?? null;
        if (matched) {
          holding = {
            symbol: matched.symbol,
            valueUsd: matched.total_value_usd,
            portfolioWeightPct: portfolio.totalUsd > 0 ? (matched.total_value_usd / portfolio.totalUsd) * 100 : null,
            networkCount: matched.variants.length,
          };
        }
      }
    }

    const isInWatchlist = watchlistAssets.some((asset) => (
      normalizeMarketChain(asset.chain) === normalizedChain && toContractKey(asset.contract, normalizedChain) === normalizedContract
    ));

    return buildTokenContextToolResult({
      requestedChain: normalizedChain,
      requestedContract: normalizedContract,
      requestedSymbol: tokenSymbol,
      requestedName: tokenName,
      detail: detail
        ? {
            ...detail,
            volume24h: null,
            fdv: null,
          }
        : null,
      audit,
      candles,
      isInWatchlist,
      holding,
    });
  }

  private async resolveTokenDetailForTool(
    tokenChain: string,
    tokenContract: string,
    tokenSymbol?: string | null,
  ): Promise<BitgetTokenDetail | null> {
    const normalizedChain = normalizeMarketChain(tokenChain);
    const normalizedContract = toContractKey(tokenContract, normalizedChain);

    if (normalizedChain === 'sol') {
      const details = await fetchSolanaTokenDetails(this.env, [normalizedContract || 'native']);
      const detail = details.get(normalizedContract || 'native') ?? details.get('native') ?? null;
      if (!detail) return null;
      return {
        asset_id: detail.asset_id,
        chain_asset_id: detail.chain_asset_id,
        chain: detail.chain,
        contract: detail.contract,
        symbol: detail.symbol,
        name: detail.name,
        image: detail.image,
        priceChange24h: detail.priceChange24h,
        currentPriceUsd: detail.currentPriceUsd,
        holders: null,
        totalSupply: null,
        liquidityUsd: null,
        top10HolderPercent: null,
        devHolderPercent: null,
        lockLpPercent: null,
      };
    }

    if (normalizedContract === 'native') {
      const assets = await fetchTopMarketAssets(this.env, {
        source: 'coingecko',
        name: 'marketCap',
        limit: 80,
        chains: [normalizedChain],
      }).catch(() => []);
      const expectedSymbol = tokenSymbol?.trim().toUpperCase() ?? '';
      const matched = assets.find((asset) => (
        normalizeMarketChain(asset.chain) === normalizedChain && toContractKey(asset.contract || 'native', normalizedChain) === 'native'
      )) ?? assets.find((asset) => expectedSymbol && asset.symbol.trim().toUpperCase() === expectedSymbol) ?? null;
      if (!matched) return null;
      return {
        asset_id: matched.asset_id,
        chain_asset_id: matched.chain_asset_id,
        chain: matched.chain,
        contract: matched.contract,
        symbol: matched.symbol,
        name: matched.name,
        image: matched.image ?? null,
        priceChange24h: matched.price_change_percentage_24h ?? null,
        currentPriceUsd: matched.current_price ?? null,
        holders: null,
        totalSupply: null,
        liquidityUsd: null,
        top10HolderPercent: null,
        devHolderPercent: null,
        lockLpPercent: null,
      };
    }

    return fetchBitgetTokenDetail(this.env, normalizedChain, normalizedContract);
  }

  private async executeReadWalletContextTool(): Promise<string> {
    const wallet = this.getWalletSummary();
    if (!wallet) {
      return buildWalletContextToolResult({
        walletAddress: null,
        chainAccounts: [],
        totalUsd: null,
        topHoldings: [],
        watchlistSymbols: [],
        recentEventTypes: [],
      });
    }

    const portfolio = await fetchWalletPortfolio(this.env, wallet).catch(() => null);
    const merged = portfolio ? await buildMergedPortfolioHoldings(this.env, portfolio.holdings).catch(() => []) : [];
    const topHoldings = merged.slice(0, 5).map((item) => ({
      symbol: item.symbol,
      name: item.name,
      valueUsd: item.total_value_usd,
      portfolioWeightPct: portfolio && portfolio.totalUsd > 0 ? (item.total_value_usd / portfolio.totalUsd) * 100 : null,
    }));

    return buildWalletContextToolResult({
      walletAddress: wallet.address,
      chainAccounts: wallet.chainAccounts.map((account) => ({
        networkKey: account.networkKey,
        protocol: account.protocol,
        address: account.address,
      })),
      totalUsd: portfolio?.totalUsd ?? null,
      topHoldings,
      watchlistSymbols: this.getWatchlistAssets(8).map((item) => item.symbol).filter(Boolean),
      recentEventTypes: this.getLatestEvents(6).map((item) => item.event_type).filter(Boolean),
    });
  }

  private async executeReadReceiveAddressesTool(): Promise<string> {
    const wallet = this.getWalletSummary();
    if (!wallet) {
      return 'Tool result for read_receive_addresses: unavailable because the wallet has not been initialized.';
    }

    const groups = [
      {
        protocol: 'evm' as const,
        label: 'EVM receive address',
        address: wallet.chainAccounts.find((item) => item.protocol === 'evm')?.address ?? wallet.address,
        chainNames: APP_CONFIG.supportedChains.filter((item) => item.protocol === 'evm').map((item) => item.name),
      },
      {
        protocol: 'tvm' as const,
        label: 'Tron receive address',
        address: wallet.chainAccounts.find((item) => item.protocol === 'tvm')?.address ?? '',
        chainNames: APP_CONFIG.supportedChains.filter((item) => item.protocol === 'tvm').map((item) => item.name),
      },
      {
        protocol: 'svm' as const,
        label: 'Solana receive address',
        address: wallet.chainAccounts.find((item) => item.protocol === 'svm')?.address ?? '',
        chainNames: APP_CONFIG.supportedChains.filter((item) => item.protocol === 'svm').map((item) => item.name),
      },
      {
        protocol: 'btc' as const,
        label: 'Bitcoin receive address',
        address: wallet.chainAccounts.find((item) => item.protocol === 'btc')?.address ?? '',
        chainNames: APP_CONFIG.supportedChains.filter((item) => item.protocol === 'btc').map((item) => item.name),
      },
    ].filter((group) => Boolean(group.address));

    return buildReceiveAddressesToolResult({ groups });
  }

  private getToolCallSuppressedReply(page: string): string {
    if (page === 'article') {
      return 'I checked the article context, but the summary step did not finish cleanly. Please ask again and I will summarize it directly.';
    }
    return 'I had trouble finishing that step cleanly. Please try again.';
  }

  private extractReplyTextFromJsonish(text: string): string | null {
    const match = text.match(/"reply"\s*:\s*"((?:\\.|[^"\\])*)"/s);
    if (!match?.[1]) return null;

    const normalized = match[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
      .trim();
    return normalized || null;
  }

  private parseChatLlmOutput(
    text: string,
    page: string,
    availableTools: AgentRuntimeToolName[],
  ): { reply: string; actions: AgentChatAction[] } {
    if (parseAgentRuntimeToolCall(text, availableTools)) {
      return {
        reply: this.getToolCallSuppressedReply(page),
        actions: [],
      };
    }

    const candidate = extractJsonObject(text);
    const parsed = safeJsonParse<Record<string, unknown>>(candidate);
    if (parsed) {
      const normalized = this.normalizeChatPayload(parsed);
      if (normalized) return normalized;
    }

    const extractedReply = this.extractReplyTextFromJsonish(text);
    if (extractedReply) {
      return {
        reply: extractedReply,
        actions: [],
      };
    }

    return {
      reply: stripJsonFences(text) || this.getFallbackChatReply(page),
      actions: [],
    };
  }

  private normalizeChatPayload(payload: Record<string, unknown>): { reply: string; actions: AgentChatAction[] } | null {
    return normalizeAgentChatPayload(payload);
  }

  private normalizeChatAction(input: unknown): AgentChatAction | null {
    return normalizeAgentChatAction(input);
  }

  private normalizeChatQuickReplyOption(input: unknown): AgentChatQuickReplyOption | null {
    return normalizeAgentChatQuickReplyOption(input);
  }

  private getFallbackChatReply(page: string): string {
    const locale = this.getEffectiveLocale();
    const isZh = locale?.startsWith('zh');
    const isAr = locale?.startsWith('ar');

    const fallbacks: Record<string, { en: string; zh: string; ar: string }> = {
      home: {
        en: 'I can help you explore today\'s market highlights and check your personalized recommendations. What interests you?',
        zh: '我可以帮你查看今日市场亮点和个性化推荐，你对什么感兴趣？',
        ar: 'يمكنني مساعدتك في استكشاف أبرز أحداث السوق اليوم والتحقق من التوصيات المخصصة لك. ما الذي يثير اهتمامك؟',
      },
      trade: {
        en: 'I can help you find trading opportunities or analyze market trends. What would you like to explore?',
        zh: '我可以帮你寻找交易机会或分析市场趋势，你想了解什么？',
        ar: 'يمكنني مساعدتك في العثور على فرص التداول أو تحليل اتجاهات السوق. ماذا تريد أن تستكشف؟',
      },
      wallet: {
        en: 'I can help you with transfers, portfolio analysis, or explain your holdings. How can I assist?',
        zh: '我可以帮你处理转账、分析投资组合或解释持仓情况，有什么需要帮助的？',
        ar: 'يمكنني مساعدتك في التحويلات أو تحليل المحفظة أو شرح ممتلكاتك. كيف يمكنني المساعدة؟',
      },
      token: {
        en: 'I can help you analyze this token\'s fundamentals, risk profile, and market trends. What would you like to know?',
        zh: '我可以帮你分析这个代币的基本面、风险状况和市场趋势，你想了解什么？',
        ar: 'يمكنني مساعدتك في تحليل أساسيات هذا الرمز وملف المخاطر واتجاهات السوق. ماذا تريد أن تعرف؟',
      },
      article: {
        en: 'Have questions about this article? I can summarize key points or provide additional context.',
        zh: '对这篇文章有疑问？我可以总结要点或提供更多背景信息。',
        ar: 'هل لديك أسئلة حول هذا المقال؟ يمكنني تلخيص النقاط الرئيسية أو تقديم سياق إضافي.',
      },
      market: {
        en: 'I can help you understand this market, explain the data, or discuss trends. What interests you?',
        zh: '我可以帮你理解这个市场、解释数据或讨论趋势，你对什么感兴趣？',
        ar: 'يمكنني مساعدتك في فهم هذا السوق أو شرح البيانات أو مناقشة الاتجاهات. ما الذي يثير اهتمامك؟',
      },
    };

    const fb = fallbacks[page] ?? fallbacks.home;
    if (isZh) return fb.zh;
    if (isAr) return fb.ar;
    return fb.en;
  }

  private getTransfer(transferId: string): TransferRow | null {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT
          id,
          network_key,
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
            network_key,
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
          network_key,
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
