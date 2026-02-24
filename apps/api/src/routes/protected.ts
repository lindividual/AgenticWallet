import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { Hono } from 'hono';
import { SUPPORTED_CHAINS } from '../constants';
import { getWebAuthnConfig } from '../config/webauthn';
import { requireAuth } from '../middleware/auth';
import { registerAgentRoutes } from './agent';
import { getChallenge, saveChallenge } from '../services/challenge';
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
  registerAgentRoutes(app);
}
