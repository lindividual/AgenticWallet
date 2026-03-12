import { Keypair } from '@solana/web3.js';
import { getMEEVersion, toMultichainNexusAccount } from '@biconomy/abstractjs';
import type { Address } from 'viem';
import { http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, bsc, mainnet } from 'viem/chains';
import type { Bindings, WalletProtocol, WalletSummary } from '../types';
import { decryptString, encodeBase64, encryptString, generatePrivateKeyHex } from '../utils/crypto';
import { resolveMeeVersion } from '../utils/env';
import { nowIso } from '../utils/time';

export const SOLANA_CHAIN_ID = 101;
export const EVM_PROTOCOL: WalletProtocol = 'evm';
export const SVM_PROTOCOL: WalletProtocol = 'svm';
export const EVM_WALLET_PROVIDER = 'eoa-7702';

export type WalletWithPrivateKey = WalletSummary & {
  encryptedPrivateKey: string;
  encryptedProtocolKeys: Partial<Record<WalletProtocol, string>>;
};

export type EvmWalletExecutionContext = {
  wallet: WalletWithPrivateKey;
  privateKey: `0x${string}`;
  signer: ReturnType<typeof privateKeyToAccount>;
  account: Awaited<ReturnType<typeof createBiconomyMultichainAccount>>;
};

type WalletChainAccountRow = {
  chain_id: number;
  protocol: WalletProtocol;
  address: string;
};

async function getWalletChainAccounts(db: D1Database, userId: string): Promise<WalletChainAccountRow[]> {
  const chains = await db
    .prepare(
      `SELECT chain_id, COALESCE(protocol, 'evm') AS protocol, address
       FROM wallet_chain_accounts
       WHERE user_id = ?
       ORDER BY chain_id ASC`,
    )
    .bind(userId)
    .all<WalletChainAccountRow>();

  return chains.results.map((row) => ({
    chain_id: row.chain_id,
    protocol: row.protocol === SVM_PROTOCOL ? SVM_PROTOCOL : EVM_PROTOCOL,
    address: row.address,
  }));
}

async function getProtocolKeyMap(db: D1Database, userId: string): Promise<Partial<Record<WalletProtocol, string>>> {
  const result = await db
    .prepare(
      `SELECT protocol, encrypted_key_material
       FROM wallet_protocol_keys
       WHERE user_id = ?`,
    )
    .bind(userId)
    .all<{ protocol: string; encrypted_key_material: string }>();

  const output: Partial<Record<WalletProtocol, string>> = {};
  for (const row of result.results) {
    const protocol = row.protocol === SVM_PROTOCOL ? SVM_PROTOCOL : row.protocol === EVM_PROTOCOL ? EVM_PROTOCOL : null;
    if (!protocol) continue;
    output[protocol] = row.encrypted_key_material;
  }
  return output;
}

export async function getWallet(db: D1Database, userId: string): Promise<WalletSummary | null> {
  const wallet = await db
    .prepare('SELECT address, provider FROM wallets WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first<{ address: string; provider: string }>();

  if (!wallet) return null;

  const chains = await getWalletChainAccounts(db, userId);

  return {
    address: wallet.address,
    provider: wallet.provider,
    chainAccounts: chains.map((row) => ({
      chainId: row.chain_id,
      protocol: row.protocol,
      address: row.address,
    })),
  };
}

async function readWalletWithPrivateKey(
  db: D1Database,
  userId: string,
): Promise<WalletWithPrivateKey | null> {
  const wallet = await db
    .prepare('SELECT address, provider, encrypted_private_key FROM wallets WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first<{ address: string; provider: string; encrypted_private_key: string }>();

  if (!wallet) return null;

  const [chains, protocolKeys] = await Promise.all([
    getWalletChainAccounts(db, userId),
    getProtocolKeyMap(db, userId),
  ]);

  return {
    address: wallet.address,
    provider: wallet.provider,
    encryptedPrivateKey: protocolKeys[EVM_PROTOCOL] ?? wallet.encrypted_private_key,
    encryptedProtocolKeys: protocolKeys,
    chainAccounts: chains.map((row) => ({
      chainId: row.chain_id,
      protocol: row.protocol,
      address: row.address,
    })),
  };
}

export async function bootstrapWalletForUser(env: Bindings, userId: string): Promise<WalletSummary> {
  const existing = await getWallet(env.DB, userId);
  if (existing) return existing;

  const privateKey = generatePrivateKeyHex();
  const evmAccount = privateKeyToAccount(privateKey);
  const solanaKeypair = Keypair.generate();
  const solanaSecretKey = encodeBase64(solanaKeypair.secretKey);
  const chainAccounts: WalletSummary['chainAccounts'] = [
    { chainId: mainnet.id, protocol: EVM_PROTOCOL, address: evmAccount.address },
    { chainId: base.id, protocol: EVM_PROTOCOL, address: evmAccount.address },
    { chainId: bsc.id, protocol: EVM_PROTOCOL, address: evmAccount.address },
    { chainId: SOLANA_CHAIN_ID, protocol: SVM_PROTOCOL, address: solanaKeypair.publicKey.toBase58() },
  ];
  const primaryAddress =
    chainAccounts.find((x) => x.chainId === mainnet.id)?.address ?? chainAccounts[0].address;
  const encryptedPrivateKey = await encryptString(privateKey, env.APP_SECRET);
  const encryptedSolanaKey = await encryptString(solanaSecretKey, env.APP_SECRET);

  const now = nowIso();
  const statements = [
    env.DB.prepare(
      'INSERT INTO wallets (user_id, address, encrypted_private_key, provider, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(userId, primaryAddress, encryptedPrivateKey, EVM_WALLET_PROVIDER, now),
    ...chainAccounts.map((chain) =>
      env.DB.prepare(
        'INSERT INTO wallet_chain_accounts (user_id, chain_id, protocol, address, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(userId, chain.chainId, chain.protocol, chain.address, now),
    ),
    env.DB.prepare(
      'INSERT INTO wallet_protocol_keys (user_id, protocol, encrypted_key_material, key_format, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(userId, EVM_PROTOCOL, encryptedPrivateKey, 'hex_private_key', now),
    env.DB.prepare(
      'INSERT INTO wallet_protocol_keys (user_id, protocol, encrypted_key_material, key_format, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(userId, SVM_PROTOCOL, encryptedSolanaKey, 'solana_secret_key_base64', now),
  ];
  await env.DB.batch(statements);

  return {
    address: primaryAddress,
    provider: EVM_WALLET_PROVIDER,
    chainAccounts,
  };
}

export async function ensureWalletForUser(env: Bindings, userId: string): Promise<WalletSummary> {
  const existing = await getWallet(env.DB, userId);
  if (existing) return existing;
  return bootstrapWalletForUser(env, userId);
}

export async function tryEnsureWalletForUser(
  env: Bindings,
  userId: string,
  context: string,
): Promise<WalletSummary | null> {
  try {
    return await ensureWalletForUser(env, userId);
  } catch (error) {
    console.error(`[${context}] wallet_bootstrap_deferred`, {
      userId,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
    return null;
  }
}

export async function getWalletWithPrivateKey(
  db: D1Database,
  userId: string,
): Promise<WalletWithPrivateKey | null> {
  return readWalletWithPrivateKey(db, userId);
}

export async function ensureWalletWithPrivateKey(env: Bindings, userId: string): Promise<WalletWithPrivateKey> {
  const existing = await readWalletWithPrivateKey(env.DB, userId);
  if (existing) return existing;

  await ensureWalletForUser(env, userId);

  const wallet = await readWalletWithPrivateKey(env.DB, userId);
  if (!wallet) {
    throw new Error('wallet_not_found');
  }
  return wallet;
}

export async function buildEvmWalletExecutionContext(
  env: Bindings,
  userId: string,
): Promise<EvmWalletExecutionContext> {
  const wallet = await ensureWalletWithPrivateKey(env, userId);

  let privateKey: string;
  try {
    privateKey = await decryptString(wallet.encryptedPrivateKey, env.APP_SECRET);
  } catch {
    throw new Error('wallet_key_decryption_failed');
  }

  const signer = privateKeyToAccount(privateKey as `0x${string}`);
  const account = await createBiconomyMultichainAccount(env, privateKey as `0x${string}`);

  return {
    wallet,
    privateKey: privateKey as `0x${string}`,
    signer,
    account,
  };
}

export function getWalletChainAddress(
  wallet: WalletSummary | WalletWithPrivateKey,
  chainId: number,
  protocol: WalletProtocol = EVM_PROTOCOL,
): Address | string | null {
  const found = wallet.chainAccounts.find((row) => row.chainId === chainId && row.protocol === protocol)?.address;
  if (found) return found;
  if (protocol === EVM_PROTOCOL) return wallet.address;
  return null;
}

export async function createBiconomyMultichainAccount(env: Bindings, privateKey: `0x${string}`) {
  const ethereumRpcUrl = env.ETHEREUM_RPC_URL?.trim() || undefined;
  const baseRpcUrl = env.BASE_RPC_URL?.trim() || undefined;
  const bnbRpcUrl = env.BNB_RPC_URL?.trim() || undefined;
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
