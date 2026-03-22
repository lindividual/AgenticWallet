import { APP_CONFIG } from '../config/appConfig';
import type { Bindings, WalletSummary } from '../types';
import { clampTransferHistoryLimit } from './transferHistoryFilters';
import {
  mapSimActivityToTransferHistoryRow,
  mergeTransferHistory,
  normalizeTransferHistoryTokenAddress,
  sortTransferHistoryRows,
  type SimActivityItem,
} from './transferHistoryRows';
import type { TransferHistoryFilters, TransferHistoryRecord } from './transferHistoryTypes';

export type { TransferHistoryFilters, TransferHistoryRecord } from './transferHistoryTypes';
export { matchesTransferHistoryFilters, mergeTransferHistory } from './transferHistoryRows';

type SimActivityResponse = {
  activity?: SimActivityItem[];
  next_offset?: string;
  error?: string;
  message?: string;
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
  if (primaryAddress) {
    for (const chainId of APP_CONFIG.supportedChains
      .filter((item) => item.protocol === 'evm' && item.chainId != null)
      .map((item) => item.chainId as number)) {
      if (!byChainId.has(chainId)) {
        byChainId.set(chainId, primaryAddress);
      }
    }
  }
  return byChainId;
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

  const requestedLimit = clampTransferHistoryLimit(filters.limit);
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
        const tokenAddress = normalizeTransferHistoryTokenAddress(filters.tokenAddress);
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

      const fetchedAt = new Date().toISOString();
      return (data.activity ?? [])
        .map<TransferHistoryRecord | null>((item) => mapSimActivityToTransferHistoryRow(item, chainId, walletAddress, fetchedAt))
        .filter((item): item is TransferHistoryRecord => item != null);
    }),
  );

  return sortTransferHistoryRows(rows.flat());
}
