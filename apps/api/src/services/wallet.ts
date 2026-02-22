import { getMEEVersion, toMultichainNexusAccount } from '@biconomy/abstractjs';
import { http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, bsc, mainnet } from 'viem/chains';
import type { Bindings, WalletSummary } from '../types';
import { generatePrivateKeyHex, encryptString } from '../utils/crypto';
import { requiredEnv, resolveMeeVersion } from '../utils/env';
import { nowIso } from '../utils/time';

export async function getWallet(db: D1Database, userId: string): Promise<WalletSummary | null> {
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

export async function bootstrapWalletForUser(env: Bindings, userId: string): Promise<WalletSummary> {
  const existing = await getWallet(env.DB, userId);
  if (existing) return existing;

  const privateKey = generatePrivateKeyHex();
  const smartAccount = await createBiconomyMultichainAccount(env, privateKey);
  const chainAccounts = [
    { chainId: mainnet.id, address: smartAccount.addressOn(mainnet.id, true) },
    { chainId: base.id, address: smartAccount.addressOn(base.id, true) },
    { chainId: bsc.id, address: smartAccount.addressOn(bsc.id, true) },
  ];
  const primaryAddress =
    chainAccounts.find((x) => x.chainId === mainnet.id)?.address ?? chainAccounts[0].address;
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

async function createBiconomyMultichainAccount(env: Bindings, privateKey: `0x${string}`) {
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
