import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import {
  DEFAULT_MEE_VERSION,
  MEEVersion,
  getMEEVersion,
  toMultichainNexusAccount,
} from '@biconomy/abstractjs';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import { http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, bsc, mainnet } from 'viem/chains';

type Bindings = {
  DB: D1Database;
  APP_SECRET: string;
  WEBAUTHN_ORIGIN: string;
  WEBAUTHN_RP_ID: string;
  WEBAUTHN_RP_NAME: string;
  WEBAUTHN_REQUIRE_UV?: string;
  ETHEREUM_RPC_URL?: string;
  BASE_RPC_URL?: string;
  BNB_RPC_URL?: string;
  BICONOMY_MEE_VERSION?: string;
};

type Variables = {
  userId: string;
};

type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

type RegisterOptionsRequest = {
  displayName?: string;
};

type RegisterVerifyRequest = {
  userId: string;
  challengeId: string;
  response: RegistrationResponseJSON;
};

type LoginVerifyRequest = {
  challengeId: string;
  response: AuthenticationResponseJSON;
};

type PayVerifyConfirmRequest = {
  challengeId: string;
  response: AuthenticationResponseJSON;
};

type WebAuthnConfig = {
  origin: string;
  rpId: string;
  rpName: string;
  requireUserVerification: boolean;
};

const app = new Hono<AppEnv>();

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.get('/', (c) => c.json({ ok: true, service: 'agentic-wallet-api', version: 'mvp-passkey' }));

app.post('/v1/auth/register/options', async (c) => {
  const webauthn = getWebAuthnConfig(c.env);
  let body: RegisterOptionsRequest = {};
  try {
    body = await c.req.json<RegisterOptionsRequest>();
  } catch {
    body = {};
  }
  const now = nowIso();
  const userId = crypto.randomUUID();
  const handle = `user_${userId.slice(0, 8)}`;
  const displayName = sanitizeDisplayName(body.displayName) ?? handle;

  await c.env.DB.prepare(
    'INSERT INTO users (id, handle, display_name, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(userId, handle, displayName, now)
    .run();

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
  const webauthn = getWebAuthnConfig(c.env);
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

  const wallet = await bootstrapWalletForUser(c.env, body.userId);
  const session = await createSession(c.env.DB, body.userId);
  const user = await getUserSummary(c.env.DB, body.userId);

  return c.json({
    verified: true,
    accessToken: session.id,
    sessionExpiresAt: session.expiresAt,
    user,
    wallet,
  });
});

app.post('/v1/auth/login/options', async (c) => {
  const webauthn = getWebAuthnConfig(c.env);
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
  const webauthn = getWebAuthnConfig(c.env);
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
  const wallet = await getWallet(c.env.DB, passkey.user_id);

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
    chains: [
      { chainId: 1, name: 'Ethereum', symbol: 'ETH' },
      { chainId: 8453, name: 'Base', symbol: 'ETH' },
      { chainId: 56, name: 'BNB Chain', symbol: 'BNB' },
    ],
  });
});

app.use('/v1/*', async (c, next) => {
  const authHeader = c.req.header('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'missing_bearer_token' }, 401);
  }

  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return c.json({ error: 'invalid_bearer_token' }, 401);
  }

  const session = await c.env.DB.prepare(
    'SELECT user_id, expires_at FROM sessions WHERE id = ? LIMIT 1',
  )
    .bind(token)
    .first<{ user_id: string; expires_at: string }>();

  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    return c.json({ error: 'session_expired' }, 401);
  }

  c.set('userId', session.user_id);
  await next();
});

app.get('/v1/me', async (c) => {
  const userId = c.get('userId');
  const user = await getUserSummary(c.env.DB, userId);
  const wallet = await getWallet(c.env.DB, userId);

  return c.json({ user, wallet });
});

app.post('/v1/pay/verify/options', async (c) => {
  const webauthn = getWebAuthnConfig(c.env);
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
  const webauthn = getWebAuthnConfig(c.env);
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

app.get('/v1/agent/recommendations', async (c) => {
  const userId = c.get('userId');
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
    recommendations: rows.results,
  });
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

export default app;

function getWebAuthnConfig(env: Bindings): WebAuthnConfig {
  const origin = env.WEBAUTHN_ORIGIN?.trim() || 'http://localhost:5173';
  const rpId = env.WEBAUTHN_RP_ID?.trim() || 'localhost';
  const rpName = env.WEBAUTHN_RP_NAME?.trim() || 'Agentic Wallet MVP';
  const requireUserVerification = env.WEBAUTHN_REQUIRE_UV?.trim() === 'true';

  if (!origin || !rpId || !rpName) {
    throw new Error('invalid_webauthn_config');
  }

  return { origin, rpId, rpName, requireUserVerification };
}

function sanitizeDisplayName(displayName?: string): string | null {
  if (!displayName) return null;
  const trimmed = displayName.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 64);
}

function nowIso(): string {
  return new Date().toISOString();
}

async function saveChallenge(
  db: D1Database,
  input: { id: string; userId: string | null; challenge: string; ceremony: string },
): Promise<void> {
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await db.prepare(
    'INSERT INTO auth_challenges (id, user_id, ceremony, challenge, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(input.id, input.userId, input.ceremony, input.challenge, expiresAt, now)
    .run();
}

async function getChallenge(
  db: D1Database,
  challengeId: string,
  ceremony: string,
  userId: string | null,
): Promise<{ challenge: string } | null> {
  const row = await db
    .prepare(
      `SELECT challenge, expires_at FROM auth_challenges
       WHERE id = ? AND ceremony = ? AND (? IS NULL OR user_id = ?)
       LIMIT 1`,
    )
    .bind(challengeId, ceremony, userId, userId)
    .first<{ challenge: string; expires_at: string }>();

  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  return { challenge: row.challenge };
}

async function createSession(
  db: D1Database,
  userId: string,
): Promise<{ id: string; expiresAt: string }> {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, userId, expiresAt, nowIso())
    .run();
  return { id, expiresAt };
}

async function getUserSummary(db: D1Database, userId: string): Promise<{
  id: string;
  handle: string;
  displayName: string;
}> {
  const user = await db
    .prepare('SELECT id, handle, display_name FROM users WHERE id = ? LIMIT 1')
    .bind(userId)
    .first<{ id: string; handle: string; display_name: string }>();

  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  return {
    id: user.id,
    handle: user.handle,
    displayName: user.display_name,
  };
}

async function getWallet(db: D1Database, userId: string): Promise<{
  address: string;
  provider: string;
  chainAccounts: Array<{
    chainId: number;
    address: string;
  }>;
} | null> {
  const wallet = await db
    .prepare('SELECT address, provider FROM wallets WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first<{ address: string; provider: string }>();

  if (!wallet) return null;

  const chains = await db
    .prepare(
      `SELECT chain_id, address
       FROM wallet_chain_accounts
       WHERE user_id = ?
       ORDER BY chain_id ASC`,
    )
    .bind(userId)
    .all<{ chain_id: number; address: string }>();

  return {
    address: wallet.address,
    provider: wallet.provider,
    chainAccounts: chains.results.map((row) => ({
      chainId: row.chain_id,
      address: row.address,
    })),
  };
}

async function bootstrapWalletForUser(
  env: Bindings,
  userId: string,
): Promise<{ address: string; provider: string; chainAccounts: Array<{ chainId: number; address: string }> }> {
  const existing = await getWallet(env.DB, userId);
  if (existing) return existing;

  const privateKey = generatePrivateKeyHex();
  const smartAccount = await createBiconomyMultichainAccount(env, privateKey);
  const chainAccounts = [
    { chainId: mainnet.id, address: smartAccount.addressOn(mainnet.id, true) },
    { chainId: base.id, address: smartAccount.addressOn(base.id, true) },
    { chainId: bsc.id, address: smartAccount.addressOn(bsc.id, true) },
  ];
  const primaryAddress = chainAccounts.find((x) => x.chainId === mainnet.id)?.address ?? chainAccounts[0].address;
  const encryptedPrivateKey = await encryptString(privateKey, env.APP_SECRET);

  const now = nowIso();
  const statements = [
    env.DB.prepare(
      'INSERT INTO wallets (user_id, address, encrypted_private_key, provider, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(userId, primaryAddress, encryptedPrivateKey, 'biconomy-abstractjs', now),
    ...chainAccounts.map((chain) =>
      env.DB.prepare(
        'INSERT INTO wallet_chain_accounts (user_id, chain_id, address, created_at) VALUES (?, ?, ?, ?)',
      ).bind(userId, chain.chainId, chain.address, now),
    ),
  ];
  await env.DB.batch(statements);

  return {
    address: primaryAddress,
    provider: 'biconomy-abstractjs',
    chainAccounts,
  };
}

async function createBiconomyMultichainAccount(
  env: Bindings,
  privateKey: `0x${string}`,
) {
  const ethereumRpcUrl = requiredEnv(env.ETHEREUM_RPC_URL, 'ETHEREUM_RPC_URL');
  const baseRpcUrl = requiredEnv(env.BASE_RPC_URL, 'BASE_RPC_URL');
  const bnbRpcUrl = requiredEnv(env.BNB_RPC_URL, 'BNB_RPC_URL');
  const version = resolveMeeVersion(env.BICONOMY_MEE_VERSION);
  const signer = privateKeyToAccount(privateKey);

  return toMultichainNexusAccount({
    signer,
    chainConfigurations: [
      {
        chain: mainnet,
        transport: http(ethereumRpcUrl),
        version: getMEEVersion(version),
      },
      {
        chain: base,
        transport: http(baseRpcUrl),
        version: getMEEVersion(version),
      },
      {
        chain: bsc,
        transport: http(bnbRpcUrl),
        version: getMEEVersion(version),
      },
    ],
  });
}

function generatePrivateKeyHex(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `0x${hex}`;
}

async function encryptString(plainText: string, secret: string): Promise<string> {
  const key = await deriveAesGcmKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(plainText);

  const cipherBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);

  return `${toBase64(iv)}.${toBase64(new Uint8Array(cipherBuffer))}`;
}

async function deriveAesGcmKey(secret: string): Promise<CryptoKey> {
  const secretBytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest('SHA-256', secretBytes);

  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
}

function toBase64(input: Uint8Array): string {
  let str = '';
  for (const b of input) {
    str += String.fromCharCode(b);
  }
  return btoa(str);
}

function safeJsonParse<T>(input: string | null): T | null {
  if (!input) return null;
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

function requiredEnv(value: string | undefined, key: string): string {
  const resolved = value?.trim();
  if (!resolved) {
    throw new Error(`${key}_is_required`);
  }
  return resolved;
}

function resolveMeeVersion(raw: string | undefined): MEEVersion {
  const normalized = raw?.trim();
  if (!normalized) return DEFAULT_MEE_VERSION;

  const matched = Object.values(MEEVersion).find((v) => v === normalized);
  if (!matched) {
    throw new Error(`invalid_BICONOMY_MEE_VERSION_${normalized}`);
  }
  return matched;
}
