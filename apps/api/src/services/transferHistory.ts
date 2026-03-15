import { formatUnits } from 'viem';
import { APP_CONFIG, getChainConfigByChainId, getChainConfigByNetworkKey } from '../config/appConfig';
import type { Bindings, TransferStatus, WalletSummary } from '../types';
import { SOLANA_NETWORK_KEY } from './wallet';

export type TransferHistoryRecord = {
  id: string;
  source: 'app' | 'sim';
  networkKey: string;
  chainId: number | null;
  fromAddress: string;
  toAddress: string;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenDecimals: number;
  amountInput: string;
  amountRaw: string;
  txValue: string;
  txHash: string | null;
  status: TransferStatus;
  errorCode: string | null;
  errorMessage: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
};

export type TransferHistoryFilters = {
  limit: number;
  status?: TransferStatus;
  networkKey?: string;
  chainId?: number;
  tokenAddress?: string | null;
  tokenSymbol?: string | null;
  assetType?: 'native' | 'erc20';
};

type SimActivityResponse = {
  activity?: SimActivityItem[];
  next_offset?: string;
  error?: string;
  message?: string;
};

type SimActivityItem = {
  chain_id?: number;
  block_time?: string;
  tx_hash?: string;
  type?: string;
  asset_type?: string;
  token_address?: string;
  from?: string;
  to?: string;
  value?: string;
  token_metadata?: {
    symbol?: string;
    decimals?: number;
  };
};

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value || null;
}

function normalizeAddress(raw: unknown): string | null {
  const value = normalizeText(raw)?.toLowerCase();
  if (!value) return null;
  if (!/^0x[a-f0-9]{40}$/.test(value)) return null;
  return value;
}

function normalizeAddressForChain(networkKey: string, raw: unknown): string | null {
  if (networkKey === SOLANA_NETWORK_KEY) {
    return normalizeText(raw);
  }
  return normalizeAddress(raw);
}

function normalizeTokenAddress(raw: unknown): string | null {
  const value = normalizeText(raw);
  if (!value) return null;
  if (value.startsWith('0x')) {
    return normalizeAddress(value);
  }
  return value === 'native' ? null : value;
}

function normalizeTokenSymbol(raw: unknown): string | null {
  const value = normalizeText(raw)?.toUpperCase();
  return value || null;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 20;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function buildExternalRowId(activity: SimActivityItem, walletAddress: string): string {
  const chainId = Number(activity.chain_id ?? 0);
  const networkKey = getChainConfigByChainId(chainId)?.networkKey ?? `evm:${chainId}`;
  const txHash = normalizeText(activity.tx_hash) ?? 'unknown';
  const type = normalizeText(activity.type) ?? 'unknown';
  const tokenAddress = normalizeTokenAddress(activity.token_address) ?? 'native';
  const value = normalizeText(activity.value) ?? '0';
  return `sim:${networkKey}:${walletAddress}:${txHash}:${type}:${tokenAddress}:${value}`;
}

function getChainNativeSymbol(networkKey: string, chainId: number | null): string | null {
  return getChainConfigByNetworkKey(networkKey)?.symbol ?? (chainId != null ? getChainConfigByChainId(chainId)?.symbol ?? null : null);
}

function getChainAccountMap(wallet: WalletSummary | null | undefined): Map<number, string> {
  const byChainId = new Map<number, string>();
  for (const account of wallet?.chainAccounts ?? []) {
    if (account.protocol !== 'evm') continue;
    if (!Number.isFinite(account.chainId)) continue;
    const address = normalizeAddress(account.address);
    if (!address) continue;
    byChainId.set(account.chainId as number, address);
  }
  const primaryAddress = normalizeAddress(wallet?.address);
  if (primaryAddress && !byChainId.has(1)) {
    byChainId.set(1, primaryAddress);
  }
  return byChainId;
}

function getOwnedAddresses(wallet: WalletSummary | null | undefined): Set<string> {
  const owned = new Set<string>();
  const primary = normalizeAddress(wallet?.address);
  if (primary) owned.add(primary);
  for (const account of wallet?.chainAccounts ?? []) {
    const address = account.protocol === 'svm' || account.protocol === 'tvm'
      ? normalizeText(account.address)
      : normalizeAddress(account.address);
    if (address) owned.add(address);
  }
  return owned;
}

function matchesDirection(type: string | null | undefined): type is 'send' | 'receive' {
  return type === 'send' || type === 'receive';
}

function formatAmountInput(rawAmount: string, decimals: number): string {
  try {
    return formatUnits(BigInt(rawAmount), decimals);
  } catch {
    return rawAmount;
  }
}

export function matchesTransferHistoryFilters(
  row: Pick<TransferHistoryRecord, 'networkKey' | 'chainId' | 'tokenAddress' | 'tokenSymbol' | 'status'>,
  filters: TransferHistoryFilters,
): boolean {
  if (filters.status && row.status !== filters.status) {
    return false;
  }
  if (filters.networkKey && row.networkKey !== filters.networkKey) {
    return false;
  }
  if (filters.chainId && row.chainId !== filters.chainId) {
    return false;
  }

  if (filters.assetType === 'native') {
    return normalizeTokenAddress(row.tokenAddress) == null;
  }

  const normalizedTokenAddress = normalizeTokenAddress(filters.tokenAddress);
  if (normalizedTokenAddress) {
    return normalizeTokenAddress(row.tokenAddress) === normalizedTokenAddress;
  }

  const normalizedTokenSymbol = normalizeTokenSymbol(filters.tokenSymbol);
  if (normalizedTokenSymbol) {
    return normalizeTokenSymbol(row.tokenSymbol) === normalizedTokenSymbol;
  }

  return true;
}

function buildDeduplicationKey(row: TransferHistoryRecord, ownedAddresses: Set<string>): string {
  const normalizedTo = normalizeAddressForChain(row.networkKey, row.toAddress) ?? '';
  const normalizedFrom = normalizeAddressForChain(row.networkKey, row.fromAddress) ?? '';
  const direction = ownedAddresses.has(normalizedTo)
    ? 'receive'
    : ownedAddresses.has(normalizedFrom)
      ? 'send'
      : 'unknown';
  const tokenKey = row.networkKey === SOLANA_NETWORK_KEY
    ? (normalizeText(row.tokenAddress) ?? 'native')
    : (normalizeTokenAddress(row.tokenAddress) ?? 'native');
  const amountKey = normalizeText(row.amountRaw) ?? normalizeText(row.txValue) ?? '0';
  const txKey = normalizeText(row.txHash) ?? row.id;
  return [row.networkKey, txKey.toLowerCase(), direction, tokenKey, amountKey].join(':');
}

function getSortTimestamp(row: TransferHistoryRecord): number {
  const candidate = row.confirmedAt ?? row.submittedAt ?? row.updatedAt ?? row.createdAt;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function mergeTransferHistory(
  localRows: TransferHistoryRecord[],
  externalRows: TransferHistoryRecord[],
  wallet: WalletSummary | null | undefined,
  filters: TransferHistoryFilters,
): TransferHistoryRecord[] {
  const ownedAddresses = getOwnedAddresses(wallet);
  const deduped = new Map<string, TransferHistoryRecord>();

  for (const row of [...localRows, ...externalRows]) {
    if (!matchesTransferHistoryFilters(row, filters)) continue;
    const key = buildDeduplicationKey(row, ownedAddresses);
    if (!deduped.has(key)) {
      deduped.set(key, row);
    }
  }

  return [...deduped.values()]
    .sort((a, b) => getSortTimestamp(b) - getSortTimestamp(a))
    .slice(0, clampLimit(filters.limit));
}

export async function fetchExternalTransferHistory(
  env: Bindings,
  wallet: WalletSummary | null | undefined,
  filters: TransferHistoryFilters,
): Promise<TransferHistoryRecord[]> {
  const simApiKey = normalizeText(env.SIM_API_KEY);
  if (!simApiKey) return [];

  const chainAccountMap = getChainAccountMap(wallet);
  if (!chainAccountMap.size) return [];

  const requestedLimit = clampLimit(filters.limit);
  const requestedChains = filters.networkKey
    ? APP_CONFIG.supportedChains
        .filter((item) => item.protocol === 'evm' && item.networkKey === filters.networkKey && item.chainId != null)
        .map((item) => item.chainId as number)
    : filters.chainId
      ? [filters.chainId]
      : [...new Set(APP_CONFIG.supportedChains.filter((item) => item.protocol === 'evm' && item.chainId != null).map((item) => item.chainId as number))];
  const assetType = filters.assetType === 'native'
    ? 'native'
    : filters.tokenAddress
      ? 'erc20'
      : filters.assetType;

  const rows = await Promise.all(
    requestedChains.map(async (chainId) => {
      const walletAddress = chainAccountMap.get(chainId);
      if (!walletAddress) return [];

      const query = new URLSearchParams();
      query.set('chain_ids', String(chainId));
      query.set('activity_type', 'send,receive');
      query.set('limit', String(requestedLimit));
      if (assetType) {
        query.set('asset_type', assetType);
      }
      if (assetType !== 'native') {
        const tokenAddress = normalizeTokenAddress(filters.tokenAddress);
        if (tokenAddress) {
          query.set('token_address', tokenAddress);
        }
      }

      const response = await fetch(`https://api.sim.dune.com/v1/evm/activity/${walletAddress}?${query.toString()}`, {
        method: 'GET',
        headers: {
          'X-Sim-Api-Key': simApiKey,
        },
      });
      const data = (await response.json()) as SimActivityResponse;

      if (!response.ok) {
        console.warn('[transfer/history][sim] request_failed', {
          chainId,
          walletAddress,
          status: response.status,
          error: data.message ?? data.error ?? 'unknown_error',
        });
        return [];
      }

      return (data.activity ?? [])
        .filter((item) => matchesDirection(normalizeText(item.type)))
        .map<TransferHistoryRecord | null>((item) => {
          const activityType = normalizeText(item.type);
          if (!matchesDirection(activityType)) return null;

          const rowChainId = Number(item.chain_id ?? chainId);
          const rowNetworkKey = getChainConfigByChainId(rowChainId)?.networkKey ?? `evm:${rowChainId}`;
          const tokenDecimals = Number.isFinite(Number(item.token_metadata?.decimals))
            ? Number(item.token_metadata?.decimals)
            : 18;
          const amountRaw = normalizeText(item.value) ?? '0';
          const occurredAt = normalizeText(item.block_time) ?? new Date().toISOString();
          const tokenAddress = normalizeTokenAddress(item.token_address);
          const fromAddress = normalizeAddress(item.from) ?? (activityType === 'send' ? walletAddress : '');
          const toAddress = normalizeAddress(item.to) ?? (activityType === 'receive' ? walletAddress : '');
          const tokenSymbol = normalizeTokenSymbol(item.token_metadata?.symbol) ?? (
            tokenAddress == null ? getChainNativeSymbol(rowNetworkKey, rowChainId) : null
          );

          return {
            id: buildExternalRowId(item, walletAddress),
            source: 'sim',
            networkKey: rowNetworkKey,
            chainId: rowChainId,
            fromAddress,
            toAddress,
            tokenAddress,
            tokenSymbol,
            tokenDecimals,
            amountInput: formatAmountInput(amountRaw, tokenDecimals),
            amountRaw,
            txValue: tokenAddress == null ? amountRaw : '0',
            txHash: normalizeText(item.tx_hash),
            status: 'confirmed',
            errorCode: null,
            errorMessage: null,
            idempotencyKey: null,
            createdAt: occurredAt,
            updatedAt: occurredAt,
            submittedAt: occurredAt,
            confirmedAt: occurredAt,
          };
        })
        .filter((item): item is TransferHistoryRecord => item != null);
    }),
  );

  return rows.flat().sort((a, b) => getSortTimestamp(b) - getSortTimestamp(a));
}
