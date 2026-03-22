import type { TransferStatus } from '../types';
import type { TransferHistoryFilters } from './transferHistoryTypes';

const VALID_TRANSFER_STATUS = new Set<TransferStatus>(['created', 'submitted', 'confirmed', 'failed']);

export type TransferHistoryQueryInput = {
  limit?: string | undefined;
  status?: string | undefined;
  networkKey?: string | undefined;
  chainId?: string | undefined;
  tokenAddress?: string | undefined;
  tokenSymbol?: string | undefined;
  assetType?: string | undefined;
};

export function clampTransferHistoryLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 20;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

export function normalizeTransferHistoryStatus(raw: string | undefined): TransferStatus | undefined {
  if (!raw) return undefined;
  const value = raw.trim() as TransferStatus;
  return VALID_TRANSFER_STATUS.has(value) ? value : undefined;
}

function normalizeTransferHistoryChainId(raw: string | undefined): number | undefined {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function normalizeTransferHistoryNetworkKey(raw: string | undefined): string | undefined {
  const value = raw?.trim().toLowerCase();
  return value || undefined;
}

function normalizeTransferHistoryTokenAddress(raw: string | undefined): string | null | undefined {
  if (raw == null) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (value.toLowerCase() === 'native' || value === '0x0000000000000000000000000000000000000000') return null;
  if (/^0x[a-f0-9]{40}$/i.test(value)) return value.toLowerCase();
  return value;
}

function normalizeTransferHistoryTokenSymbol(raw: string | undefined): string | undefined {
  const value = raw?.trim().toUpperCase();
  return value || undefined;
}

function normalizeTransferHistoryAssetType(raw: string | undefined): TransferHistoryFilters['assetType'] | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === 'native' || value === 'erc20') return value;
  return undefined;
}

export function createTransferHistoryFilters(query: TransferHistoryQueryInput): TransferHistoryFilters {
  return {
    limit: clampTransferHistoryLimit(Number(query.limit)),
    status: normalizeTransferHistoryStatus(query.status),
    networkKey: normalizeTransferHistoryNetworkKey(query.networkKey),
    chainId: normalizeTransferHistoryChainId(query.chainId),
    tokenAddress: normalizeTransferHistoryTokenAddress(query.tokenAddress),
    tokenSymbol: normalizeTransferHistoryTokenSymbol(query.tokenSymbol),
    assetType: normalizeTransferHistoryAssetType(query.assetType),
  };
}

export function resolveLocalTransferHistoryLimit(filters: TransferHistoryFilters): number {
  const isFiltered = Boolean(
    filters.networkKey
      || filters.chainId
      || filters.tokenAddress !== undefined
      || filters.tokenSymbol
      || filters.assetType,
  );
  return isFiltered ? 100 : filters.limit;
}
