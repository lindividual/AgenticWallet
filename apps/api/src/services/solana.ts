import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Bindings } from '../types';
import { buildAssetId, buildChainAssetId, contractKeyToUpstreamContract } from './assetIdentity';
import { ensureWalletWithPrivateKey, SOLANA_NETWORK_KEY, SVM_PROTOCOL } from './wallet';
import { decodeBase64, encodeBase64 } from '../utils/crypto';
import { decryptString } from '../utils/crypto';

const SOLANA_RPC_DEFAULT = 'https://api.mainnet-beta.solana.com';
const JUPITER_API_DEFAULT = 'https://lite-api.jup.ag';
const JUPITER_SWAP_API_DEFAULT = 'https://api.jup.ag';
const TOKEN_PROGRAM_IDS = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()];

export const SOLANA_MARKET_CHAIN = 'sol';
export const SOLANA_NATIVE_SYMBOL = 'SOL';
export const SOLANA_NATIVE_NAME = 'Solana';
export const SOLANA_NATIVE_DECIMALS = 9;
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

type RpcEnvelope<T> = {
  result?: T;
  error?: {
    code?: number;
    message?: string;
  };
};

type JupiterTokenSearchRow = {
  id?: string;
  address?: string;
  symbol?: string;
  name?: string;
  icon?: string;
  logoURI?: string;
  decimals?: number;
};

type JupiterPriceRow = {
  usdPrice?: number | string;
  price?: number | string;
  blockId?: number | string;
  decimals?: number | string;
  priceChange24h?: number | string;
};

export type SolanaPortfolioHolding = {
  protocol: 'svm';
  network_key: string;
  chain: string;
  chain_id: number | null;
  address: string;
  asset_id: string;
  chain_asset_id: string;
  amount: string;
  symbol: string;
  name: string;
  decimals: number;
  price_usd: number | null;
  value_usd: number | null;
  logo: string | null;
  logo_uri: string | null;
  url: string | null;
};

type SolanaTokenMetadata = {
  contract: string;
  symbol: string;
  name: string;
  decimals: number;
  image: string | null;
};

export type SolanaTokenDetail = {
  asset_id: string;
  chain_asset_id: string;
  chain: string;
  contract: string;
  symbol: string;
  name: string;
  image: string | null;
  decimals: number;
  priceChange24h: number | null;
  currentPriceUsd: number | null;
};

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value || null;
}

function normalizeFiniteNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizePositiveInt(raw: unknown, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

export function getSolanaRpcUrl(env: Bindings): string {
  return env.SOLANA_RPC_URL?.trim() || SOLANA_RPC_DEFAULT;
}

function getJupiterTokenApiBaseUrl(env: Bindings): string {
  return env.JUPITER_API_BASE_URL?.trim() || JUPITER_API_DEFAULT;
}

function getJupiterSwapApiBaseUrl(env: Bindings): string {
  return env.JUPITER_API_BASE_URL?.trim() || JUPITER_SWAP_API_DEFAULT;
}

export function normalizeSolanaAddress(raw: string, field: string): string {
  const value = normalizeText(raw);
  if (!value) {
    throw new Error(`invalid_${field}`);
  }
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new Error(`invalid_${field}`);
  }
}

export function isSolanaSignature(raw: string): boolean {
  try {
    return normalizeSolanaAddress(raw, 'signature').length >= 32;
  } catch {
    return false;
  }
}

export function isWrappedSolMint(raw: string | null | undefined): boolean {
  return normalizeText(raw) === WRAPPED_SOL_MINT;
}

function parseDecimalAmount(amount: string, decimals: number): bigint {
  const normalized = amount.trim();
  if (!normalized) throw new Error('invalid_amount');
  const [wholeText, fractionText = ''] = normalized.split('.');
  if (!/^\d+$/.test(wholeText || '0') || !/^\d*$/.test(fractionText)) {
    throw new Error('invalid_amount');
  }
  const whole = BigInt(wholeText || '0');
  const fraction = fractionText.padEnd(decimals, '0').slice(0, decimals);
  const raw = whole * 10n ** BigInt(decimals) + BigInt(fraction || '0');
  if (raw <= 0n) throw new Error('invalid_amount');
  return raw;
}

function bigintToDecimalString(value: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = value % divisor;
  if (fraction === 0n) return whole.toString();
  return `${whole.toString()}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

async function solanaRpc<T>(env: Bindings, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(getSolanaRpcUrl(env), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`solana_rpc_http_${response.status}`);
  }

  const payload = (await response.json()) as RpcEnvelope<T>;
  if (payload.error) {
    throw new Error(`solana_rpc_${payload.error.code ?? 'error'}:${payload.error.message ?? 'unknown'}`);
  }
  if (payload.result === undefined) {
    throw new Error(`solana_rpc_${method}_missing_result`);
  }
  return payload.result;
}

function getSolanaChainAccountAddress(
  wallet: Awaited<ReturnType<typeof ensureWalletWithPrivateKey>>,
): string {
  const address = wallet?.chainAccounts.find((row) => row.networkKey === SOLANA_NETWORK_KEY)?.address;
  if (!address) {
    throw new Error('wallet_not_found');
  }
  return address;
}

export async function getSolanaKeypair(env: Bindings, userId: string): Promise<{
  wallet: Awaited<ReturnType<typeof ensureWalletWithPrivateKey>>;
  address: string;
  keypair: Keypair;
}> {
  const wallet = await ensureWalletWithPrivateKey(env, userId);

  const encrypted = wallet.encryptedProtocolKeys[SVM_PROTOCOL];
  if (!encrypted) {
    throw new Error('wallet_key_decryption_failed');
  }

  let decrypted: string;
  try {
    decrypted = await decryptString(encrypted, env.APP_SECRET);
  } catch {
    throw new Error('wallet_key_decryption_failed');
  }

  try {
    const secretKey = decodeBase64(decrypted);
    return {
      wallet,
      address: getSolanaChainAccountAddress(wallet),
      keypair: Keypair.fromSecretKey(secretKey),
    };
  } catch {
    throw new Error('wallet_key_decryption_failed');
  }
}

export async function getSolanaNativeBalanceLamports(env: Bindings, owner: string): Promise<bigint> {
  const result = await solanaRpc<{ value?: number | string }>(env, 'getBalance', [owner, { commitment: 'confirmed' }]);
  return BigInt(result.value ?? 0);
}

export async function getSolanaTokenAccountsByOwner(env: Bindings, owner: string): Promise<Array<{
  mint: string;
  amountRaw: string;
  decimals: number;
}>> {
  const rows = await Promise.all(
    TOKEN_PROGRAM_IDS.map(async (programId) => {
      const result = await solanaRpc<{
        value?: Array<{
          pubkey?: string;
          account?: {
            data?: {
              parsed?: {
                info?: {
                  mint?: string;
                  tokenAmount?: {
                    amount?: string;
                    decimals?: number;
                  };
                };
              };
            };
          };
        }>;
      }>(env, 'getTokenAccountsByOwner', [
        owner,
        { programId },
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
        },
      ]);

      return (result.value ?? [])
        .map((item) => ({
          mint: normalizeText(item.account?.data?.parsed?.info?.mint) ?? '',
          amountRaw: normalizeText(item.account?.data?.parsed?.info?.tokenAmount?.amount) ?? '0',
          decimals: normalizePositiveInt(item.account?.data?.parsed?.info?.tokenAmount?.decimals, SOLANA_NATIVE_DECIMALS),
        }))
        .filter((item) => item.mint && BigInt(item.amountRaw) > 0n);
    }),
  );

  return rows.flat();
}

export async function getSolanaMintDecimals(env: Bindings, mint: string): Promise<number> {
  if (isWrappedSolMint(mint)) return SOLANA_NATIVE_DECIMALS;
  const result = await solanaRpc<{ value?: { decimals?: number } }>(env, 'getTokenSupply', [mint, { commitment: 'confirmed' }]);
  return normalizePositiveInt(result.value?.decimals, SOLANA_NATIVE_DECIMALS);
}

export async function getSolanaSplBalanceRaw(env: Bindings, owner: string, mint: string): Promise<bigint> {
  if (isWrappedSolMint(mint)) {
    return getSolanaNativeBalanceLamports(env, owner);
  }
  const rows = await getSolanaTokenAccountsByOwner(env, owner);
  return rows
    .filter((row) => row.mint === mint)
    .reduce((total, row) => total + BigInt(row.amountRaw), 0n);
}

export async function getSolanaRentExemptionLamports(env: Bindings, size = 165): Promise<bigint> {
  const result = await solanaRpc<number>(env, 'getMinimumBalanceForRentExemption', [size, { commitment: 'confirmed' }]);
  return BigInt(result ?? 0);
}

export async function getSolanaLatestBlockhash(env: Bindings): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const result = await solanaRpc<{
    value?: {
      blockhash?: string;
      lastValidBlockHeight?: number;
    };
  }>(env, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const blockhash = normalizeText(result.value?.blockhash);
  if (!blockhash) throw new Error('solana_blockhash_unavailable');
  return {
    blockhash,
    lastValidBlockHeight: normalizePositiveInt(result.value?.lastValidBlockHeight, 0),
  };
}

export async function getSolanaAccountInfo(env: Bindings, address: string): Promise<unknown | null> {
  const result = await solanaRpc<{ value?: unknown | null }>(env, 'getAccountInfo', [
    address,
    {
      encoding: 'base64',
      commitment: 'confirmed',
    },
  ]);
  return result.value ?? null;
}

export async function sendSignedSolanaTransaction(env: Bindings, transactionBytes: Uint8Array): Promise<string> {
  return solanaRpc<string>(env, 'sendTransaction', [
    encodeBase64(transactionBytes),
    {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    },
  ]);
}

export async function getSolanaSignatureStatus(
  env: Bindings,
  signature: string,
): Promise<'confirmed' | 'failed' | 'pending'> {
  const result = await solanaRpc<{
    value?: Array<{
      confirmationStatus?: string | null;
      err?: unknown;
    } | null>;
  }>(env, 'getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);

  const status = result.value?.[0] ?? null;
  if (!status) return 'pending';
  if (status.err) return 'failed';
  if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
    return 'confirmed';
  }
  return 'pending';
}

export async function waitForSolanaSignature(
  env: Bindings,
  signature: string,
  timeoutMs = 120_000,
): Promise<'confirmed' | 'failed' | 'pending'> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await getSolanaSignatureStatus(env, signature);
    if (status !== 'pending') return status;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return 'pending';
}

async function fetchJupiterTokenMetadata(env: Bindings, contract: string): Promise<SolanaTokenMetadata | null> {
  if (contract === 'native' || isWrappedSolMint(contract)) {
    return {
      contract,
      symbol: SOLANA_NATIVE_SYMBOL,
      name: SOLANA_NATIVE_NAME,
      decimals: SOLANA_NATIVE_DECIMALS,
      image: null,
    };
  }

  const url = new URL('/tokens/v2/search', getJupiterTokenApiBaseUrl(env));
  url.searchParams.set('query', contract);
  url.searchParams.set('limit', '10');
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    return null;
  }
  const rows = (await response.json()) as JupiterTokenSearchRow[];
  const matched = rows.find((row) => normalizeText(row.id ?? row.address) === contract) ?? rows[0];
  if (!matched) return null;
  return {
    contract,
    symbol: normalizeText(matched.symbol) ?? contract.slice(0, 6),
    name: normalizeText(matched.name) ?? contract,
    decimals: normalizePositiveInt(matched.decimals, SOLANA_NATIVE_DECIMALS),
    image: normalizeText(matched.icon) ?? normalizeText(matched.logoURI),
  };
}

async function fetchJupiterPrices(
  env: Bindings,
  contracts: string[],
): Promise<Map<string, { priceUsd: number | null; priceChange24h: number | null }>> {
  const normalizedContracts = [...new Set(contracts.map((item) => normalizeText(item)).filter((item): item is string => Boolean(item)))];
  if (!normalizedContracts.length) return new Map();

  const url = new URL('/price/v3', getJupiterTokenApiBaseUrl(env));
  url.searchParams.set('ids', normalizedContracts.join(','));
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    return new Map();
  }
  const payload = (await response.json()) as Record<string, JupiterPriceRow> | { data?: Record<string, JupiterPriceRow> };
  const data = (typeof payload === 'object' && payload && 'data' in payload && payload.data
    ? payload.data
    : payload) as Record<string, JupiterPriceRow>;
  return new Map(
    normalizedContracts.map((contract) => {
      const row = data[contract];
      return [
        contract,
        {
          priceUsd: normalizeFiniteNumber(row?.usdPrice ?? row?.price),
          priceChange24h: normalizeFiniteNumber(row?.priceChange24h),
        },
      ] as const;
    }),
  );
}

export async function fetchSolanaTokenDetails(
  env: Bindings,
  contracts: string[],
): Promise<Map<string, SolanaTokenDetail>> {
  const normalizedContracts = [...new Set(contracts.map((item) => contractKeyToUpstreamContract(item, SOLANA_MARKET_CHAIN) || 'native'))];
  const [metadataRows, priceRows] = await Promise.all([
    Promise.all(normalizedContracts.map((contract) => fetchJupiterTokenMetadata(env, contract))),
    fetchJupiterPrices(env, normalizedContracts.map((contract) => (contract === 'native' ? WRAPPED_SOL_MINT : contract))),
  ]);

  const output = new Map<string, SolanaTokenDetail>();
  for (let index = 0; index < normalizedContracts.length; index += 1) {
    const contract = normalizedContracts[index];
    const metadata = metadataRows[index];
    if (!metadata) continue;
    const priceLookupKey = contract === 'native' ? WRAPPED_SOL_MINT : contract;
    const price = priceRows.get(priceLookupKey);
    const detail: SolanaTokenDetail = {
      asset_id: buildAssetId(SOLANA_MARKET_CHAIN, contract),
      chain_asset_id: buildChainAssetId(SOLANA_MARKET_CHAIN, contract),
      chain: SOLANA_MARKET_CHAIN,
      contract,
      symbol: metadata.symbol,
      name: metadata.name,
      image: metadata.image,
      decimals: metadata.decimals,
      currentPriceUsd: price?.priceUsd ?? null,
      priceChange24h: price?.priceChange24h ?? null,
    };
    output.set(contract, detail);
  }

  if (!output.has('native')) {
    const nativePrice = priceRows.get(WRAPPED_SOL_MINT);
    output.set('native', {
      asset_id: buildAssetId(SOLANA_MARKET_CHAIN, 'native'),
      chain_asset_id: buildChainAssetId(SOLANA_MARKET_CHAIN, 'native'),
      chain: SOLANA_MARKET_CHAIN,
      contract: 'native',
      symbol: SOLANA_NATIVE_SYMBOL,
      name: SOLANA_NATIVE_NAME,
      image: null,
      decimals: SOLANA_NATIVE_DECIMALS,
      currentPriceUsd: nativePrice?.priceUsd ?? null,
      priceChange24h: nativePrice?.priceChange24h ?? null,
    });
  }

  return output;
}

export async function fetchSolanaPortfolio(env: Bindings, owner: string): Promise<SolanaPortfolioHolding[]> {
  const [nativeBalance, tokenAccounts] = await Promise.all([
    getSolanaNativeBalanceLamports(env, owner),
    getSolanaTokenAccountsByOwner(env, owner),
  ]);

  const contracts = ['native', ...tokenAccounts.map((row) => row.mint)];
  const details = await fetchSolanaTokenDetails(env, contracts);

  const holdings: SolanaPortfolioHolding[] = [];
  const nativeDetail = details.get('native');
  if (nativeBalance > 0n && nativeDetail) {
    const amount = nativeBalance.toString();
    const priceUsd = nativeDetail.currentPriceUsd ?? null;
    holdings.push({
      protocol: 'svm',
      chain: SOLANA_MARKET_CHAIN,
      network_key: SOLANA_NETWORK_KEY,
      chain_id: null,
      address: 'native',
      asset_id: nativeDetail.asset_id,
      chain_asset_id: nativeDetail.chain_asset_id,
      amount,
      symbol: nativeDetail.symbol,
      name: nativeDetail.name,
      decimals: nativeDetail.decimals,
      price_usd: priceUsd,
      value_usd: priceUsd == null ? null : Number(bigintToDecimalString(nativeBalance, nativeDetail.decimals)) * priceUsd,
      logo: nativeDetail.image,
      logo_uri: nativeDetail.image,
      url: null,
    });
  }

  for (const token of tokenAccounts) {
    const detail = details.get(token.mint);
    if (!detail) continue;
    const amount = BigInt(token.amountRaw);
    if (amount <= 0n) continue;
    const priceUsd = detail.currentPriceUsd ?? null;
    holdings.push({
      protocol: 'svm',
      chain: SOLANA_MARKET_CHAIN,
      network_key: SOLANA_NETWORK_KEY,
      chain_id: null,
      address: token.mint,
      asset_id: detail.asset_id,
      chain_asset_id: detail.chain_asset_id,
      amount: token.amountRaw,
      symbol: detail.symbol,
      name: detail.name,
      decimals: token.decimals,
      price_usd: priceUsd,
      value_usd: priceUsd == null ? null : Number(bigintToDecimalString(amount, token.decimals)) * priceUsd,
      logo: detail.image,
      logo_uri: detail.image,
      url: null,
    });
  }

  return holdings.sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
}

export async function buildSignedSolanaTransfer(env: Bindings, userId: string, input: {
  toAddress: string;
  tokenAddress: string | null;
  amountRaw: bigint;
}): Promise<{
  fromAddress: string;
  transactionBytes: Uint8Array;
  estimatedFeeLamports: bigint;
  destinationAtaCreated: boolean;
}> {
  const { address, keypair } = await getSolanaKeypair(env, userId);
  const fromPubkey = new PublicKey(address);
  const toPubkey = new PublicKey(input.toAddress);
  const latestBlockhash = await getSolanaLatestBlockhash(env);
  const transaction = new Transaction({
    feePayer: fromPubkey,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });

  let estimatedFeeLamports = 5_000n;
  let destinationAtaCreated = false;

  if (!input.tokenAddress) {
    transaction.add(SystemProgram.transfer({
      fromPubkey,
      toPubkey,
      lamports: input.amountRaw,
    }));
  } else {
    const mint = new PublicKey(input.tokenAddress);
    const sourceAta = getAssociatedTokenAddressSync(mint, fromPubkey, false);
    const destinationAta = getAssociatedTokenAddressSync(mint, toPubkey, true);
    const destinationInfo = await getSolanaAccountInfo(env, destinationAta.toBase58());
    if (!destinationInfo) {
      destinationAtaCreated = true;
      estimatedFeeLamports += await getSolanaRentExemptionLamports(env);
      transaction.add(createAssociatedTokenAccountInstruction(fromPubkey, destinationAta, toPubkey, mint));
    }
    transaction.add(createTransferInstruction(sourceAta, destinationAta, fromPubkey, input.amountRaw));
  }

  transaction.sign(keypair);
  return {
    fromAddress: address,
    transactionBytes: transaction.serialize(),
    estimatedFeeLamports,
    destinationAtaCreated,
  };
}

export async function fetchJupiterQuote(
  env: Bindings,
  input: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
  },
): Promise<Record<string, unknown>> {
  const url = new URL('/swap/v1/quote', getJupiterSwapApiBaseUrl(env));
  url.searchParams.set('inputMint', input.inputMint);
  url.searchParams.set('outputMint', input.outputMint);
  url.searchParams.set('amount', input.amount);
  url.searchParams.set('slippageBps', String(input.slippageBps));
  url.searchParams.set('restrictIntermediateTokens', 'true');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`trade_provider_http_${response.status}:${detail.slice(0, 300)}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function buildSignedJupiterSwap(env: Bindings, userId: string, quoteResponse: Record<string, unknown>): Promise<{
  fromAddress: string;
  transactionBytes: Uint8Array;
  prioritizationFeeLamports: bigint | null;
}> {
  const { address, keypair } = await getSolanaKeypair(env, userId);
  const response = await fetch(new URL('/swap/v1/swap', getJupiterSwapApiBaseUrl(env)).toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: address,
      dynamicComputeUnitLimit: true,
      wrapAndUnwrapSol: true,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`trade_provider_http_${response.status}:${detail.slice(0, 300)}`);
  }

  const payload = await response.json() as {
    swapTransaction?: string;
    prioritizationFeeLamports?: number | string;
  };
  const swapTransaction = normalizeText(payload.swapTransaction);
  if (!swapTransaction) {
    throw new Error('trade_provider_invalid_response');
  }

  const transaction = VersionedTransaction.deserialize(decodeBase64(swapTransaction));
  transaction.sign([keypair]);
  return {
    fromAddress: address,
    transactionBytes: transaction.serialize(),
    prioritizationFeeLamports: payload.prioritizationFeeLamports == null ? null : BigInt(payload.prioritizationFeeLamports),
  };
}

export function parseSolanaAmountInput(amount: string, decimals: number): { amountRaw: bigint; amountInput: string } {
  return {
    amountRaw: parseDecimalAmount(amount, decimals),
    amountInput: amount.trim(),
  };
}

export function formatLamports(amount: bigint): string {
  return bigintToDecimalString(amount, SOLANA_NATIVE_DECIMALS);
}

export function getSolanaNativeDisplayContract(tokenAddress: string | null | undefined): string | null {
  if (tokenAddress == null || tokenAddress === '') return null;
  return tokenAddress;
}

export function resolveSolanaTradeMint(raw: string): string {
  const normalized = normalizeSolanaAddress(raw, 'token_address');
  return normalized;
}

export function resolveSolanaTokenContract(raw: string | null | undefined): string {
  if (!normalizeText(raw) || raw === 'native') return 'native';
  return normalizeSolanaAddress(raw ?? '', 'token_address');
}

export function getSolanaWrappedMintForTrade(raw: string): string {
  const normalized = resolveSolanaTokenContract(raw);
  return normalized === 'native' ? WRAPPED_SOL_MINT : normalized;
}

export function formatSolanaUiAmount(raw: string, decimals: number): string {
  return bigintToDecimalString(BigInt(raw), decimals);
}
