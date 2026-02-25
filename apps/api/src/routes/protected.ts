import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { Hono } from 'hono';
import { getWebAuthnConfig } from '../config/webauthn';
import { requireAuth } from '../middleware/auth';
import { registerAgentRoutes } from './agent';
import { getChallenge, saveChallenge } from '../services/challenge';
import { getUserSummary } from '../services/user';
import { getWallet } from '../services/wallet';
import { fetchWalletPortfolio, upsertTokenMetadataFromPortfolio } from '../services/market';
import { listUserPortfolioSnapshots, saveUserPortfolioSnapshot } from '../services/agent';
import type { AppEnv, PayVerifyConfirmRequest } from '../types';
import { safeJsonParse } from '../utils/json';
import { nowIso } from '../utils/time';
import { registerMarketRoutes } from './market';

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

    let result;
    try {
      result = await fetchWalletPortfolio(c.env, walletAddress);
    } catch (error) {
      return c.json(
        {
          error: 'portfolio_fetch_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }
    const holdings = result.holdings;
    const totalUsd = result.totalUsd;
    const sample = holdings
      .slice(0, 3)
      .map((row) => `${row.chain_id}:${row.symbol ?? row.name ?? 'unknown'}:${row.amount}:$${row.value_usd ?? 'null'}`)
      .join('|');
    console.log(
      `[wallet/portfolio] sim_ok filtered=${holdings.length} totalUsd=${totalUsd} sample=${sample || 'none'}`,
    );
    await upsertTokenMetadataFromPortfolio(c.env, holdings, result.asOf);
    await saveUserPortfolioSnapshot(c.env, userId, {
      totalUsd,
      holdings,
      asOf: result.asOf,
    });

    return c.json({
      walletAddress,
      totalUsd,
      holdings,
    });
  });

  app.get('/v1/wallet/portfolio/snapshots', async (c) => {
    const userId = c.get('userId');
    const periodRaw = c.req.query('period');
    const period = periodRaw === '7d' || periodRaw === '30d' ? periodRaw : '24h';
    let points = await listUserPortfolioSnapshots(c.env, userId, period);

    if (!points.length) {
      const wallet = await getWallet(c.env.DB, userId);
      const walletAddress = wallet?.address;
      if (!walletAddress) {
        return c.json({ error: 'wallet_not_found' }, 404);
      }

      const result = await fetchWalletPortfolio(c.env, walletAddress);
      await upsertTokenMetadataFromPortfolio(c.env, result.holdings, result.asOf);
      await saveUserPortfolioSnapshot(c.env, userId, {
        totalUsd: result.totalUsd,
        holdings: result.holdings,
        asOf: result.asOf,
      });
      points = await listUserPortfolioSnapshots(c.env, userId, period);
    }

    return c.json({ period, points });
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
  registerMarketRoutes(app);
  registerAgentRoutes(app);
}
