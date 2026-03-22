import { formatUnits } from 'viem';
import { getChainConfigByChainId, getChainConfigByNetworkKey } from '../config/appConfig';
import type { WalletSummary } from '../types';
import { SOLANA_NETWORK_KEY } from './wallet';
import type { TransferHistoryFilters, TransferHistoryRecord } from './transferHistoryTypes';

export type SimActivityItem = {
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

export function normalizeTransferHistoryTokenAddress(raw: unknown): string | null {
  const value = normalizeText(raw);
  if (!value) return null;
  if (value.startsWith('0x')) {
    return normalizeAddress(value);
  }
  return value === 'native' ? null : value;
}

function normalizeTransferHistoryTokenSymbol(raw: unknown): string | null {
  const value = normalizeText(raw)?.toUpperCase();
  return value || null;
}

function buildExternalRowId(activity: SimActivityItem, walletAddress: string): string {
  const chainId = Number(activity.chain_id ?? 0);
  const networkKey = getChainConfigByChainId(chainId)?.networkKey ?? `evm:${chainId}`;
  const txHash = normalizeText(activity.tx_hash) ?? 'unknown';
  const type = normalizeText(activity.type) ?? 'unknown';
  const tokenAddress = normalizeTransferHistoryTokenAddress(activity.token_address) ?? 'native';
  const value = normalizeText(activity.value) ?? '0';
  return `sim:${networkKey}:${walletAddress}:${txHash}:${type}:${tokenAddress}:${value}`;
}

function getChainNativeSymbol(networkKey: string, chainId: number | null): string | null {
  return getChainConfigByNetworkKey(networkKey)?.symbol ?? (chainId != null ? getChainConfigByChainId(chainId)?.symbol ?? null : null);
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
    return normalizeTransferHistoryTokenAddress(row.tokenAddress) == null;
  }

  const normalizedTokenAddress = normalizeTransferHistoryTokenAddress(filters.tokenAddress);
  if (normalizedTokenAddress) {
    return normalizeTransferHistoryTokenAddress(row.tokenAddress) === normalizedTokenAddress;
  }

  const normalizedTokenSymbol = normalizeTransferHistoryTokenSymbol(filters.tokenSymbol);
  if (normalizedTokenSymbol) {
    return normalizeTransferHistoryTokenSymbol(row.tokenSymbol) === normalizedTokenSymbol;
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
    : (normalizeTransferHistoryTokenAddress(row.tokenAddress) ?? 'native');
  const amountKey = normalizeText(row.amountRaw) ?? normalizeText(row.txValue) ?? '0';
  const txKey = normalizeText(row.txHash) ?? row.id;
  return [row.networkKey, txKey.toLowerCase(), direction, tokenKey, amountKey].join(':');
}

function getSortTimestamp(row: TransferHistoryRecord): number {
  const candidate = row.confirmedAt ?? row.submittedAt ?? row.updatedAt ?? row.createdAt;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function sortTransferHistoryRows(rows: TransferHistoryRecord[]): TransferHistoryRecord[] {
  return [...rows].sort((a, b) => getSortTimestamp(b) - getSortTimestamp(a));
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

  return sortTransferHistoryRows([...deduped.values()]).slice(0, filters.limit);
}

export function mapSimActivityToTransferHistoryRow(
  item: SimActivityItem,
  chainId: number,
  walletAddress: string,
  nowIso: string,
): TransferHistoryRecord | null {
  const activityType = normalizeText(item.type);
  if (!matchesDirection(activityType)) return null;

  const rowChainId = Number(item.chain_id ?? chainId);
  const rowNetworkKey = getChainConfigByChainId(rowChainId)?.networkKey ?? `evm:${rowChainId}`;
  const tokenDecimals = Number.isFinite(Number(item.token_metadata?.decimals))
    ? Number(item.token_metadata?.decimals)
    : 18;
  const amountRaw = normalizeText(item.value) ?? '0';
  const occurredAt = normalizeText(item.block_time) ?? nowIso;
  const tokenAddress = normalizeTransferHistoryTokenAddress(item.token_address);
  const fromAddress = normalizeAddress(item.from) ?? (activityType === 'send' ? walletAddress : '');
  const toAddress = normalizeAddress(item.to) ?? (activityType === 'receive' ? walletAddress : '');
  const tokenSymbol = normalizeTransferHistoryTokenSymbol(item.token_metadata?.symbol) ?? (
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
}
