import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { Hono } from 'hono';
import { buildAgentEventRecord, isAgentEventType, type AgentEventIngestRequest } from '../agent/events';
import { SUPPORTED_CHAINS } from '../constants';
import { getWebAuthnConfig } from '../config/webauthn';
import { requireAuth } from '../middleware/auth';
import {
  enqueueUserAgentJob,
  getUserAgentArticleDetail,
  ingestUserAgentEvent,
  listUserAgentArticles,
  listUserAgentRecommendations,
  runUserAgentJobsNow,
} from '../services/agent';
import { getChallenge, saveChallenge } from '../services/challenge';
import { getLlmStatus } from '../services/llm';
import { getUserSummary } from '../services/user';
import { getWallet } from '../services/wallet';
import type { AppEnv, PayVerifyConfirmRequest } from '../types';
import { safeJsonParse } from '../utils/json';
import { nowIso } from '../utils/time';

type SimBalanceRow = {
  chain: string;
  chain_id: number;
  address: string;
  amount: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  price_usd?: number;
  value_usd?: number;
  logo?: string;
  url?: string;
};

type SimBalancesResponse = {
  wallet_address: string;
  balances: SimBalanceRow[];
};

function hasPositiveAmount(rawAmount: string | undefined): boolean {
  if (!rawAmount) return false;
  const normalized = rawAmount.trim();
  if (!normalized || normalized === '0') return false;
  if (/^\d+$/.test(normalized)) {
    return BigInt(normalized) > 0n;
  }
  const asNumber = Number(normalized);
  return Number.isFinite(asNumber) && asNumber > 0;
}

function resolvePortfolioChainIds(raw: string | undefined): string {
  const defaultChainIds = SUPPORTED_CHAINS.map((chain) => chain.chainId).join(',');
  const normalized = raw?.trim();
  if (!normalized) {
    return defaultChainIds;
  }

  if (normalized === 'mainnet' || normalized === 'testnet') {
    return normalized;
  }

  const isValidList = /^[0-9,\s]+$/.test(normalized);
  if (!isValidList) {
    return defaultChainIds;
  }

  const list = normalized
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (!list.length) {
    return defaultChainIds;
  }

  return list.join(',');
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export function registerProtectedRoutes(app: Hono<AppEnv>): void {
  app.use('/v1/*', requireAuth);

  app.get('/v1/me', async (c) => {
    const userId = c.get('userId');
    const user = await getUserSummary(c.env.DB, userId);
    const wallet = await getWallet(c.env.DB, userId);

    return c.json({ user, wallet });
  });

  app.get('/v1/wallet/portfolio', async (c) => {
    const userId = c.get('userId');
    const wallet = await getWallet(c.env.DB, userId);
    const walletAddress = wallet?.address;

    if (!walletAddress) {
      return c.json({ error: 'wallet_not_found' }, 404);
    }

    const simApiKey = c.env.SIM_API_KEY?.trim();
    if (!simApiKey) {
      return c.json({ error: 'sim_api_key_not_configured' }, 500);
    }
    const chainIds = resolvePortfolioChainIds(c.env.PORTFOLIO_CHAIN_IDS);
    console.log(
      `[wallet/portfolio] start userId=${userId} walletAddress=${walletAddress} chainIds=${chainIds}`,
    );

    const simResponse = await fetch(
      `https://api.sim.dune.com/v1/evm/balances/${walletAddress}?metadata=logo,url&chain_ids=${encodeURIComponent(chainIds)}`,
      {
        method: 'GET',
        headers: {
          'X-Sim-Api-Key': simApiKey,
        },
      },
    );

    const simData = (await simResponse.json()) as SimBalancesResponse & { error?: string; message?: string };
    if (!simResponse.ok) {
      console.log(
        `[wallet/portfolio] sim_error status=${simResponse.status} error=${simData.error ?? 'unknown'} message=${simData.message ?? 'n/a'}`,
      );
      return c.json(
        {
          error: simData.error ?? 'sim_request_failed',
          message: simData.message ?? 'failed_to_fetch_portfolio',
        },
        502,
      );
    }

    const holdings = (simData.balances ?? [])
      .filter((row) => Number(row.value_usd ?? 0) > 0 || hasPositiveAmount(row.amount))
      .sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
    const totalUsd = holdings.reduce((acc, row) => acc + Number(row.value_usd ?? 0), 0);
    const sample = holdings
      .slice(0, 3)
      .map((row) => `${row.chain_id}:${row.symbol ?? row.name ?? 'unknown'}:${row.amount}:$${row.value_usd ?? 'null'}`)
      .join('|');
    console.log(
      `[wallet/portfolio] sim_ok raw=${simData.balances?.length ?? 0} filtered=${holdings.length} totalUsd=${totalUsd} sample=${sample || 'none'}`,
    );

    return c.json({
      walletAddress,
      totalUsd,
      holdings,
    });
  });

  app.post('/v1/pay/verify/options', async (c) => {
    const webauthn = getWebAuthnConfig(c.env, c.req.url);
    const userId = c.get('userId');
    const passkeys = await c.env.DB.prepare(
      `SELECT credential_id, transports_json
       FROM passkeys
       WHERE user_id = ?`,
    )
      .bind(userId)
      .all<{
        credential_id: string;
        transports_json: string | null;
      }>();

    if (!passkeys.results.length) {
      return c.json({ error: 'no_passkeys_for_user' }, 404);
    }

    const options = await generateAuthenticationOptions({
      rpID: webauthn.rpId,
      userVerification: 'required',
      allowCredentials: passkeys.results.map((p) => ({
        id: p.credential_id,
        transports: (safeJsonParse<string[]>(p.transports_json) ?? []) as any,
      })),
    });

    const challengeId = crypto.randomUUID();
    await saveChallenge(c.env.DB, {
      id: challengeId,
      userId,
      challenge: options.challenge,
      ceremony: 'payment_uv',
    });

    return c.json({ challengeId, options });
  });

  app.post('/v1/pay/verify/confirm', async (c) => {
    const webauthn = getWebAuthnConfig(c.env, c.req.url);
    const userId = c.get('userId');
    const body = await c.req.json<PayVerifyConfirmRequest>();
    if (!body.challengeId || !body.response) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const challengeRow = await getChallenge(c.env.DB, body.challengeId, 'payment_uv', userId);
    if (!challengeRow) {
      return c.json({ error: 'challenge_not_found' }, 400);
    }

    const passkey = await c.env.DB.prepare(
      `SELECT user_id, credential_id, public_key_b64, counter, transports_json
       FROM passkeys
       WHERE credential_id = ?
       LIMIT 1`,
    )
      .bind(body.response.id)
      .first<{
        user_id: string;
        credential_id: string;
        public_key_b64: string;
        counter: number;
        transports_json: string | null;
      }>();

    if (!passkey || passkey.user_id !== userId) {
      return c.json({ error: 'passkey_not_found_for_user' }, 404);
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: webauthn.origin,
        expectedRPID: webauthn.rpId,
        requireUserVerification: true,
        credential: {
          id: passkey.credential_id,
          publicKey: isoBase64URL.toBuffer(passkey.public_key_b64),
          counter: passkey.counter,
          transports: (safeJsonParse<string[]>(passkey.transports_json) ?? []) as any,
        },
      });
    } catch (error) {
      return c.json(
        {
          error: 'payment_verification_error',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        400,
      );
    }

    if (!verification.verified) {
      return c.json({ error: 'payment_verification_failed' }, 400);
    }

    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?').bind(
        verification.authenticationInfo.newCounter,
        nowIso(),
        passkey.credential_id,
      ),
      c.env.DB.prepare('DELETE FROM auth_challenges WHERE id = ?').bind(body.challengeId),
    ]);

    return c.json({
      verified: true,
      verifiedAt: nowIso(),
      scope: 'payment',
    });
  });

  app.post('/v1/agent/events', async (c) => {
    const userId = c.get('userId');
    let body: AgentEventIngestRequest | null = null;
    try {
      body = await c.req.json<AgentEventIngestRequest>();
    } catch {
      body = null;
    }

    if (!body || !isAgentEventType(body.type)) {
      return c.json({ error: 'invalid_event_type' }, 400);
    }

    if (body.payload !== undefined && !isRecord(body.payload)) {
      return c.json({ error: 'invalid_payload' }, 400);
    }

    const event = buildAgentEventRecord(userId, body);

    try {
      const result = await ingestUserAgentEvent(c.env, userId, event);
      return c.json(result);
    } catch (error) {
      return c.json(
        {
          error: 'agent_event_ingest_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
  });

  app.get('/v1/agent/recommendations', async (c) => {
    const userId = c.get('userId');
    const doRecommendations = await listUserAgentRecommendations(c.env, userId, 10);
    if (doRecommendations.length > 0) {
      return c.json({
        recommendations: doRecommendations.map((row) => ({
          id: row.id,
          kind: row.category,
          title: row.asset_name,
          content: row.reason,
          score: row.score,
          created_at: row.generated_at,
          valid_until: row.valid_until,
          source: 'do',
        })),
      });
    }

    const rows = await c.env.DB.prepare(
      `SELECT id, kind, title, content, created_at
       FROM recommendations
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 10`,
    )
      .bind(userId)
      .all<{
        id: string;
        kind: string;
        title: string;
        content: string;
        created_at: string;
      }>();

    return c.json({
      recommendations: rows.results.map((row) => ({ ...row, source: 'd1' })),
    });
  });

  app.get('/v1/agent/articles', async (c) => {
    const userId = c.get('userId');
    const articleType = c.req.query('type') ?? undefined;
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Number(limitRaw) : 20;
    const articles = await listUserAgentArticles(c.env, userId, {
      articleType,
      limit: Number.isFinite(limit) ? limit : 20,
    });

    return c.json({
      articles: articles.map((row) => ({
        id: row.id,
        type: row.article_type,
        title: row.title,
        summary: row.summary,
        mdKey: row.r2_key,
        tags: safeJsonParse<string[]>(row.tags_json) ?? [],
        created_at: row.created_at,
        status: row.status,
      })),
    });
  });

  app.get('/v1/agent/articles/:articleId', async (c) => {
    const userId = c.get('userId');
    const articleId = c.req.param('articleId');
    const detail = await getUserAgentArticleDetail(c.env, userId, articleId);
    if (!detail) {
      return c.json({ error: 'article_not_found' }, 404);
    }
    return c.json({
      article: {
        id: detail.article.id,
        type: detail.article.article_type,
        title: detail.article.title,
        summary: detail.article.summary,
        mdKey: detail.article.r2_key,
        tags: safeJsonParse<string[]>(detail.article.tags_json) ?? [],
        created_at: detail.article.created_at,
        status: detail.article.status,
      },
      markdown: detail.markdown,
    });
  });

  app.get('/v1/agent/llm/status', async (c) => {
    return c.json(getLlmStatus(c.env));
  });

  app.post('/v1/agent/jobs/daily-digest/run', async (c) => {
    const userId = c.get('userId');
    const today = new Date().toISOString().slice(0, 10);
    const result = await enqueueUserAgentJob(c.env, userId, {
      jobType: 'daily_digest',
      runAt: new Date().toISOString(),
      jobKey: `manual_daily_digest:${today}`,
      payload: { trigger: 'manual' },
    });
    await runUserAgentJobsNow(c.env, userId);
    return c.json(result);
  });

  app.post('/v1/agent/jobs/recommendations/run', async (c) => {
    const userId = c.get('userId');
    const today = new Date().toISOString().slice(0, 10);
    const result = await enqueueUserAgentJob(c.env, userId, {
      jobType: 'recommendation_refresh',
      runAt: new Date().toISOString(),
      jobKey: `manual_recommendation_refresh:${today}`,
      payload: { trigger: 'manual' },
    });
    await runUserAgentJobsNow(c.env, userId);
    return c.json(result);
  });

  app.post('/v1/agent/jobs/topic/run', async (c) => {
    const userId = c.get('userId');
    const body = await c.req.json<{ topic?: string }>().catch(
      () =>
        ({
          topic: undefined,
        }) satisfies { topic?: string },
    );
    const normalizedTopic = typeof body.topic === 'string' ? body.topic.trim() : '';
    const result = await enqueueUserAgentJob(c.env, userId, {
      jobType: 'topic_generation',
      runAt: new Date().toISOString(),
      jobKey: `manual_topic_generation:${new Date().toISOString().slice(0, 16)}:${normalizedTopic || 'default'}`,
      payload: normalizedTopic ? { topic: normalizedTopic } : { trigger: 'manual' },
    });
    await runUserAgentJobsNow(c.env, userId);
    return c.json(result);
  });

  app.post('/v1/agent/recommendations/mock', async (c) => {
    const userId = c.get('userId');
    await c.env.DB.prepare(
      'INSERT INTO recommendations (id, user_id, kind, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        crypto.randomUUID(),
        userId,
        'code',
        'Transfer Script Suggestion',
        'Use viem walletClient.writeContract to execute an ERC20 transfer and add simulation before submit.',
        nowIso(),
      )
      .run();

    return c.json({ ok: true });
  });
}
