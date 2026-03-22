import type { TransferStatus } from '../types';

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
