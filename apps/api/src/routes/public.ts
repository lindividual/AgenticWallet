import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import type { Hono } from 'hono';
import { APP_CONFIG } from '../config/appConfig';
import { getWebAuthnConfig, sanitizeDisplayName } from '../config/webauthn';
import { saveChallenge, getChallenge } from '../services/challenge';
import { createSession } from '../services/session';
import { getUserSummary } from '../services/user';
import { deleteWalletForUser, tryEnsureWalletForUser } from '../services/wallet';
import type {
  AppEnv,
  LoginVerifyRequest,
  RegisterOptionsRequest,
  RegisterVerifyRequest,
} from '../types';
import { safeJsonParse } from '../utils/json';
import { nowIso } from '../utils/time';

const IMAGE_PROXY_CACHE_CONTROL = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000';
const BLOCKED_PROXY_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const IMAGE_SNIFF_BYTES = 512;

function isUniqueConstraintError(error: unknown, field: string): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('unique') && message.includes(field.toLowerCase());
}

function normalizeOptionalText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value || null;
}

function isSupportedProxyProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:';
}

function startsWithBytes(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function sniffImageContentType(bytes: Uint8Array): string | null {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }

  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }

  if (startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return 'image/gif';
  }

  if (
    bytes.length >= 12 &&
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  if (startsWithBytes(bytes, [0x42, 0x4d])) {
    return 'image/bmp';
  }

  if (startsWithBytes(bytes, [0x00, 0x00, 0x01, 0x00])) {
    return 'image/x-icon';
  }

  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70 &&
    ((bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && (bytes[11] === 0x66 || bytes[11] === 0x73)) ||
      (bytes[8] === 0x6d && bytes[9] === 0x69 && bytes[10] === 0x66 && bytes[11] === 0x31))
  ) {
    return 'image/avif';
  }

  const probe = new TextDecoder().decode(bytes.subarray(0, IMAGE_SNIFF_BYTES)).replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[\s\S]*?\?>\s*)?<svg[\s>]/i.test(probe)) {
    return 'image/svg+xml';
  }

  return null;
}

async function cleanupPartialRegistration(env: AppEnv['Bindings'], userId: string): Promise<void> {
  await deleteWalletForUser(env, userId);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM wallet_chain_accounts WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM wallet_protocol_keys WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM wallets WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}

export function registerPublicRoutes(app: Hono<AppEnv>): void {
  app.get('/', (c) => c.json({ ok: true, service: 'agentic-wallet-api', version: 'mvp-passkey' }));

  app.get('/v1/image', async (c) => {
    const rawUrl = normalizeOptionalText(c.req.query('url'));
    if (!rawUrl) {
      return c.json({ error: 'invalid_image_url' }, 400);
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(rawUrl);
    } catch {
      return c.json({ error: 'invalid_image_url' }, 400);
    }

    if (!isSupportedProxyProtocol(targetUrl.protocol) || BLOCKED_PROXY_HOSTS.has(targetUrl.hostname.toLowerCase())) {
      return c.json({ error: 'invalid_image_url' }, 400);
    }

    const workerUrl = new URL(c.req.url);
    if (targetUrl.origin === workerUrl.origin && targetUrl.pathname === '/v1/image') {
      return c.json({ error: 'invalid_image_url' }, 400);
    }

    const cacheKey = new Request(c.req.url, { method: 'GET' });
    const cache = await caches.open('image-proxy-v1');
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }

    let upstream: Response;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: 'GET',
        headers: {
          Accept: 'image/*,*/*;q=0.8',
        },
      });
    } catch {
      return c.json({ error: 'image_fetch_failed' }, 502);
    }

    if (!upstream.ok) {
      return c.json({ error: 'image_fetch_failed' }, 502);
    }

    const upstreamContentType = normalizeOptionalText(upstream.headers.get('content-type'));
    let resolvedContentType: string | null = upstreamContentType;
    let responseBody: BodyInit | null = upstream.body;
    let responseContentLength = normalizeOptionalText(upstream.headers.get('content-length'));

    if (!upstreamContentType?.toLowerCase().startsWith('image/')) {
      const buffer = await upstream.arrayBuffer();
      const sniffedContentType = sniffImageContentType(new Uint8Array(buffer));
      if (!sniffedContentType) {
        return c.json({ error: 'invalid_image_content_type' }, 415);
      }
      resolvedContentType = sniffedContentType;
      responseBody = buffer;
      responseContentLength = String(buffer.byteLength);
    }

    if (!resolvedContentType) {
      return c.json({ error: 'invalid_image_content_type' }, 415);
    }

    const headers = new Headers();
    headers.set('Content-Type', resolvedContentType);
    headers.set('Cache-Control', IMAGE_PROXY_CACHE_CONTROL);
    const etag = normalizeOptionalText(upstream.headers.get('etag'));
    if (etag) headers.set('ETag', etag);
    const lastModified = normalizeOptionalText(upstream.headers.get('last-modified'));
    if (lastModified) headers.set('Last-Modified', lastModified);
    if (responseContentLength) headers.set('Content-Length', responseContentLength);

    const response = new Response(responseBody, {
      status: 200,
      headers,
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  });

  app.post('/v1/auth/register/options', async (c) => {
    const webauthn = getWebAuthnConfig(c.env, c.req.url);
    let body: RegisterOptionsRequest = {};
    try {
      body = await c.req.json<RegisterOptionsRequest>();
    } catch {
      body = {};
    }

    const userId = crypto.randomUUID();
    const handle = `user_${userId.slice(0, 8)}`;
    const displayName = sanitizeDisplayName(body.displayName) ?? handle;

    const options = await generateRegistrationOptions({
      rpName: webauthn.rpName,
      rpID: webauthn.rpId,
      userName: handle,
      userDisplayName: displayName,
      userID: isoUint8Array.fromUTF8String(userId),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      supportedAlgorithmIDs: [-7, -257],
    });

    const challengeId = crypto.randomUUID();
    await saveChallenge(c.env.DB, {
      id: challengeId,
      userId,
      challenge: options.challenge,
      ceremony: 'registration',
    });

    return c.json({
      userId,
      challengeId,
      options,
    });
  });

  app.post('/v1/auth/register/verify', async (c) => {
    const webauthn = getWebAuthnConfig(c.env, c.req.url);
    const body = await c.req.json<RegisterVerifyRequest>();
    if (!body.userId || !body.challengeId || !body.response) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const challengeRow = await getChallenge(c.env.DB, body.challengeId, 'registration', body.userId);
    if (!challengeRow) {
      return c.json({ error: 'challenge_not_found' }, 400);
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: webauthn.origin,
        expectedRPID: webauthn.rpId,
        requireUserVerification: webauthn.requireUserVerification,
      });
    } catch (error) {
      return c.json(
        {
          error: 'registration_verification_error',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        400,
      );
    }

    if (!verification.verified || !verification.registrationInfo) {
      return c.json({ error: 'registration_verification_failed' }, 400);
    }

    const credential = verification.registrationInfo.credential;
    const credentialId = credential.id;
    const publicKeyB64 = isoBase64URL.fromBuffer(credential.publicKey);
    const transports = body.response.response.transports ?? [];
    const now = nowIso();
    const handle = `user_${body.userId.slice(0, 8)}`;

    try {
      await c.env.DB.prepare(
        'INSERT INTO users (id, handle, display_name, created_at) VALUES (?, ?, ?, ?)',
      )
        .bind(body.userId, handle, handle, now)
        .run();
    } catch (error) {
      if (isUniqueConstraintError(error, 'users.id') || isUniqueConstraintError(error, 'users.handle')) {
        return c.json({ error: 'registration_user_conflict' }, 409);
      }
      console.error('[auth/register/verify] user_insert_failed', {
        userId: body.userId,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      return c.json(
        {
          error: 'registration_user_insert_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }

    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO passkeys (
            id, user_id, credential_id, public_key_b64, counter, transports_json, device_type, backed_up, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          body.userId,
          credentialId,
          publicKeyB64,
          credential.counter,
          JSON.stringify(transports),
          verification.registrationInfo.credentialDeviceType,
          verification.registrationInfo.credentialBackedUp ? 1 : 0,
          nowIso(),
        ),
        c.env.DB.prepare('DELETE FROM auth_challenges WHERE id = ?').bind(body.challengeId),
      ]);
    } catch (error) {
      await cleanupPartialRegistration(c.env, body.userId);
      if (isUniqueConstraintError(error, 'passkeys.credential_id')) {
        return c.json({ error: 'passkey_already_registered' }, 409);
      }
      console.error('[auth/register/verify] passkey_insert_failed', {
        userId: body.userId,
        credentialId,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      return c.json(
        {
          error: 'registration_passkey_insert_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        502,
      );
    }

    const session = await createSession(c.env.DB, body.userId);
    const user = await getUserSummary(c.env.DB, body.userId);
    const wallet = await tryEnsureWalletForUser(c.env, body.userId, 'auth/register/verify');

    return c.json({
      verified: true,
      accessToken: session.id,
      sessionExpiresAt: session.expiresAt,
      user,
      wallet,
    });
  });

  app.post('/v1/auth/login/options', async (c) => {
    const webauthn = getWebAuthnConfig(c.env, c.req.url);
    const options = await generateAuthenticationOptions({
      rpID: webauthn.rpId,
      userVerification: 'preferred',
    });

    const challengeId = crypto.randomUUID();
    await saveChallenge(c.env.DB, {
      id: challengeId,
      userId: null,
      challenge: options.challenge,
      ceremony: 'authentication',
    });

    return c.json({ challengeId, options });
  });

  app.post('/v1/auth/login/verify', async (c) => {
    const webauthn = getWebAuthnConfig(c.env, c.req.url);
    const body = await c.req.json<LoginVerifyRequest>();
    if (!body.challengeId || !body.response) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const challengeRow = await getChallenge(c.env.DB, body.challengeId, 'authentication', null);
    if (!challengeRow) {
      return c.json({ error: 'challenge_not_found' }, 400);
    }

    const credentialId = body.response.id;
    const passkey = await c.env.DB.prepare(
      `SELECT user_id, credential_id, public_key_b64, counter, transports_json
       FROM passkeys WHERE credential_id = ? LIMIT 1`,
    )
      .bind(credentialId)
      .first<{
        user_id: string;
        credential_id: string;
        public_key_b64: string;
        counter: number;
        transports_json: string | null;
      }>();

    if (!passkey) {
      return c.json({ error: 'passkey_not_found' }, 404);
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: webauthn.origin,
        expectedRPID: webauthn.rpId,
        requireUserVerification: webauthn.requireUserVerification,
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
          error: 'authentication_verification_error',
          message: error instanceof Error ? error.message : 'unknown_error',
        },
        400,
      );
    }

    if (!verification.verified) {
      return c.json({ error: 'authentication_verification_failed' }, 400);
    }

    const now = nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?').bind(
        verification.authenticationInfo.newCounter,
        now,
        credentialId,
      ),
      c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now, passkey.user_id),
      c.env.DB.prepare('DELETE FROM auth_challenges WHERE id = ?').bind(body.challengeId),
    ]);

    const session = await createSession(c.env.DB, passkey.user_id);
    const user = await getUserSummary(c.env.DB, passkey.user_id);
    const wallet = await tryEnsureWalletForUser(c.env, passkey.user_id, 'auth/login/verify');

    return c.json({
      verified: true,
      accessToken: session.id,
      sessionExpiresAt: session.expiresAt,
      user,
      wallet,
    });
  });

  app.get('/v1/chains', (c) => {
    return c.json({
      chains: APP_CONFIG.supportedChains.map(({ networkKey, chainId, name, symbol, marketChain, protocol }) => ({
        networkKey,
        chainId,
        name,
        symbol,
        marketChain,
        protocol,
      })),
    });
  });

  app.get('/v1/app-config', (c) => {
    return c.json({
      supportedChains: APP_CONFIG.supportedChains.map(({ networkKey, chainId, name, symbol, marketChain, protocol }) => ({
        networkKey,
        chainId,
        name,
        symbol,
        marketChain,
        protocol,
      })),
      defaultReceiveTokens: APP_CONFIG.defaultReceiveTokens,
    });
  });
}
