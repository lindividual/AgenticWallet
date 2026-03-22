import { getMEEVersion, toMultichainNexusAccount } from '@biconomy/abstractjs';
import type { Address } from 'viem';
import { http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base, bsc, mainnet, optimism, polygon } from 'viem/chains';
import type { Bindings, WalletNetworkKey, WalletProtocol, WalletSummary } from '../types';
import { decryptString } from '../utils/crypto';
import { resolveMeeVersion } from '../utils/env';
import { evmAddressToTronAddress } from '../utils/tron';

export const ETHEREUM_NETWORK_KEY: WalletNetworkKey = 'ethereum-mainnet';
export const BASE_NETWORK_KEY: WalletNetworkKey = 'base-mainnet';
export const BNB_NETWORK_KEY: WalletNetworkKey = 'bnb-mainnet';
export const ARBITRUM_NETWORK_KEY: WalletNetworkKey = 'arbitrum-mainnet';
export const OPTIMISM_NETWORK_KEY: WalletNetworkKey = 'optimism-mainnet';
export const POLYGON_NETWORK_KEY: WalletNetworkKey = 'polygon-mainnet';
export const TRON_NETWORK_KEY: WalletNetworkKey = 'tron-mainnet';
export const SOLANA_NETWORK_KEY: WalletNetworkKey = 'solana-mainnet';
export const BITCOIN_NETWORK_KEY: WalletNetworkKey = 'bitcoin-mainnet';
export const EVM_PROTOCOL: WalletProtocol = 'evm';
export const SVM_PROTOCOL: WalletProtocol = 'svm';
export const TVM_PROTOCOL: WalletProtocol = 'tvm';
export const BTC_PROTOCOL: WalletProtocol = 'btc';
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
  network_key: string;
  chain_id: number | null;
  protocol: WalletProtocol;
  address: string;
};

type WalletRpcStub = DurableObjectStub & {
  getWalletRpc(userId: string): Promise<{ wallet: WalletSummary | null }>;
  ensureWalletRpc(userId: string): Promise<{ wallet: WalletSummary }>;
  upsertWalletRpc(
    userId: string,
    input: {
      wallet: WalletSummary;
      encryptedPrivateKey: string;
      encryptedProtocolKeys: Partial<Record<WalletProtocol, string>>;
    },
  ): Promise<{ ok: true }>;
  ensureWalletWithPrivateKeyRpc(userId: string): Promise<{ wallet: WalletWithPrivateKey }>;
  deleteWalletRpc(userId: string): Promise<{ ok: true }>;
};

function normalizeWalletChainAccounts(
  chainAccounts: WalletSummary['chainAccounts'],
  walletAddress: string,
): WalletSummary['chainAccounts'] {
  const hasTronAccount = chainAccounts.some((row) => row.protocol === TVM_PROTOCOL || row.networkKey === TRON_NETWORK_KEY);
  if (hasTronAccount) {
    return chainAccounts;
  }

  const evmAddress =
    chainAccounts.find((row) => row.protocol === EVM_PROTOCOL)?.address?.trim()
    || walletAddress.trim();

  if (!evmAddress) {
    return chainAccounts;
  }

  try {
    return [
      ...chainAccounts,
      {
        networkKey: TRON_NETWORK_KEY,
        chainId: null,
        protocol: TVM_PROTOCOL,
        address: evmAddressToTronAddress(evmAddress),
      },
    ];
  } catch {
    return chainAccounts;
  }
}

function normalizeWalletSummary<T extends WalletSummary>(wallet: T): T {
  return {
    ...wallet,
    chainAccounts: normalizeWalletChainAccounts(wallet.chainAccounts, wallet.address),
  };
}

function normalizeWalletProtocol(raw: string | null | undefined): WalletProtocol | null {
  if (raw === EVM_PROTOCOL || raw === SVM_PROTOCOL || raw === TVM_PROTOCOL || raw === BTC_PROTOCOL) return raw;
  return null;
}

function getWalletStub(env: Bindings, userId: string): WalletRpcStub {
  const id = env.USER_AGENT.idFromName(userId);
  return env.USER_AGENT.get(id) as WalletRpcStub;
}

async function getLegacyWalletChainAccounts(db: D1Database, userId: string): Promise<WalletChainAccountRow[]> {
  const chains = await db
    .prepare(
      `SELECT network_key, chain_id, COALESCE(protocol, 'evm') AS protocol, address
       FROM wallet_chain_accounts
       WHERE user_id = ?
       ORDER BY network_key ASC`,
    )
    .bind(userId)
    .all<WalletChainAccountRow>();

  return chains.results.map((row) => ({
    network_key: row.network_key,
    chain_id: row.chain_id,
    protocol: normalizeWalletProtocol(row.protocol) ?? EVM_PROTOCOL,
    address: row.address,
  }));
}

async function getLegacyProtocolKeyMap(db: D1Database, userId: string): Promise<Partial<Record<WalletProtocol, string>>> {
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
    const protocol = normalizeWalletProtocol(row.protocol);
    if (!protocol) continue;
    output[protocol] = row.encrypted_key_material;
  }
  return output;
}

async function getLegacyWallet(db: D1Database, userId: string): Promise<WalletSummary | null> {
  const wallet = await db
    .prepare('SELECT address, provider FROM wallets WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first<{ address: string; provider: string }>();

  if (!wallet) return null;

  const chains = await getLegacyWalletChainAccounts(db, userId);

  return {
    address: wallet.address,
    provider: wallet.provider,
    chainAccounts: chains.map((row) => ({
      networkKey: row.network_key,
      chainId: row.chain_id,
      protocol: row.protocol,
      address: row.address,
    })),
  };
}

async function readLegacyWalletWithPrivateKey(
  db: D1Database,
  userId: string,
): Promise<WalletWithPrivateKey | null> {
  const wallet = await db
    .prepare('SELECT address, provider, encrypted_private_key FROM wallets WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first<{ address: string; provider: string; encrypted_private_key: string }>();

  if (!wallet) return null;

  const [chains, protocolKeys] = await Promise.all([
    getLegacyWalletChainAccounts(db, userId),
    getLegacyProtocolKeyMap(db, userId),
  ]);

  return {
    address: wallet.address,
    provider: wallet.provider,
    encryptedPrivateKey: protocolKeys[EVM_PROTOCOL] ?? wallet.encrypted_private_key,
    encryptedProtocolKeys: protocolKeys,
    chainAccounts: chains.map((row) => ({
      networkKey: row.network_key,
      chainId: row.chain_id,
      protocol: row.protocol,
      address: row.address,
    })),
  };
}

async function migrateLegacyWalletToDo(env: Bindings, userId: string): Promise<WalletWithPrivateKey | null> {
  const legacyWallet = await readLegacyWalletWithPrivateKey(env.DB, userId);
  if (!legacyWallet) return null;
  const stub = getWalletStub(env, userId);
  await stub.upsertWalletRpc(userId, {
    wallet: {
      address: legacyWallet.address,
      provider: legacyWallet.provider,
      chainAccounts: legacyWallet.chainAccounts,
    },
    encryptedPrivateKey: legacyWallet.encryptedPrivateKey,
    encryptedProtocolKeys: legacyWallet.encryptedProtocolKeys,
  });
  await clearLegacyWallet(env.DB, userId);
  return legacyWallet;
}

async function clearLegacyWallet(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM wallet_chain_accounts WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM wallet_protocol_keys WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM wallets WHERE user_id = ?').bind(userId),
  ]);
}

export async function getWallet(env: Bindings, userId: string): Promise<WalletSummary | null> {
  const stub = getWalletStub(env, userId);
  const current = await stub.getWalletRpc(userId);
  if (current.wallet) {
    await clearLegacyWallet(env.DB, userId);
    return normalizeWalletSummary(current.wallet);
  }

  const migrated = await migrateLegacyWalletToDo(env, userId);
  if (migrated) {
    return normalizeWalletSummary({
      address: migrated.address,
      provider: migrated.provider,
      chainAccounts: migrated.chainAccounts,
    });
  }
  return null;
}

export async function bootstrapWalletForUser(env: Bindings, userId: string): Promise<WalletSummary> {
  return ensureWalletForUser(env, userId);
}

export async function ensureWalletForUser(env: Bindings, userId: string): Promise<WalletSummary> {
  const existing = await getWallet(env, userId);
  if (existing) return existing;
  const stub = getWalletStub(env, userId);
  const data = await stub.ensureWalletRpc(userId);
  return data.wallet;
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
  env: Bindings,
  userId: string,
): Promise<WalletWithPrivateKey | null> {
  const stub = getWalletStub(env, userId);
  const current = await stub.getWalletRpc(userId);
  if (current.wallet) {
    await clearLegacyWallet(env.DB, userId);
    const withKeys = await stub.ensureWalletWithPrivateKeyRpc(userId);
    return normalizeWalletSummary(withKeys.wallet);
  }
  const migrated = await migrateLegacyWalletToDo(env, userId);
  return migrated ? normalizeWalletSummary(migrated) : null;
}

export async function ensureWalletWithPrivateKey(env: Bindings, userId: string): Promise<WalletWithPrivateKey> {
  const existing = await getWalletWithPrivateKey(env, userId);
  if (existing) return existing;
  const stub = getWalletStub(env, userId);
  const data = await stub.ensureWalletWithPrivateKeyRpc(userId);
  return data.wallet;
}

export async function deleteWalletForUser(env: Bindings, userId: string): Promise<void> {
  const stub = getWalletStub(env, userId);
  await stub.deleteWalletRpc(userId).catch(() => undefined);
  await clearLegacyWallet(env.DB, userId);
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
  networkKey: WalletNetworkKey,
  protocol: WalletProtocol = EVM_PROTOCOL,
): Address | string | null {
  const found = wallet.chainAccounts.find((row) => row.networkKey === networkKey && row.protocol === protocol)?.address;
  if (found) return found;
  if (protocol === EVM_PROTOCOL) return wallet.address;
  if (protocol === TVM_PROTOCOL || networkKey === TRON_NETWORK_KEY) {
    try {
      const evmAddress = wallet.chainAccounts.find((row) => row.protocol === EVM_PROTOCOL)?.address ?? wallet.address;
      return evmAddress ? evmAddressToTronAddress(evmAddress) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function createBiconomyMultichainAccount(env: Bindings, privateKey: `0x${string}`) {
  const ethereumRpcUrl = env.ETHEREUM_RPC_URL?.trim() || undefined;
  const baseRpcUrl = env.BASE_RPC_URL?.trim() || undefined;
  const bnbRpcUrl = env.BNB_RPC_URL?.trim() || undefined;
  const arbitrumRpcUrl = env.ARBITRUM_RPC_URL?.trim() || undefined;
  const optimismRpcUrl = env.OPTIMISM_RPC_URL?.trim() || undefined;
  const polygonRpcUrl = env.POLYGON_RPC_URL?.trim() || undefined;
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
      {
        chain: arbitrum,
        transport: http(arbitrumRpcUrl),
        version: getMEEVersion(version),
      },
      {
        chain: optimism,
        transport: http(optimismRpcUrl),
        version: getMEEVersion(version),
      },
      {
        chain: polygon,
        transport: http(polygonRpcUrl),
        version: getMEEVersion(version),
      },
    ],
  });
}
