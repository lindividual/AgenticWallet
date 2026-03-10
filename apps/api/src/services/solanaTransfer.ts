import type { Bindings, TransferQuoteRequest, TransferQuoteResponse } from '../types';
import {
  buildSignedSolanaTransfer,
  getSolanaMintDecimals,
  getSolanaNativeBalanceLamports,
  getSolanaSignatureStatus,
  getSolanaSplBalanceRaw,
  normalizeSolanaAddress,
  parseSolanaAmountInput,
  resolveSolanaTokenContract,
  sendSignedSolanaTransaction,
  waitForSolanaSignature,
} from './solana';
import { ensureWalletForUser } from './wallet';

export type PreparedSolanaTransfer = {
  mode: 'solana';
  env: Bindings;
  quote: TransferQuoteResponse;
  transactionBytes: Uint8Array;
};

export async function prepareSolanaTransfer(
  env: Bindings,
  userId: string,
  input: TransferQuoteRequest,
): Promise<PreparedSolanaTransfer> {
  const wallet = await ensureWalletForUser(env, userId);

  const fromAddress = wallet.chainAccounts.find((row) => row.chainId === 101)?.address;
  if (!fromAddress) {
    throw new Error('wallet_not_found');
  }

  const toAddress = normalizeSolanaAddress(input.toAddress, 'to_address');
  const tokenAddress = input.tokenAddress ? resolveSolanaTokenContract(input.tokenAddress) : null;
  const tokenDecimals = tokenAddress
    ? (Number.isFinite(input.tokenDecimals) ? Number(input.tokenDecimals) : await getSolanaMintDecimals(env, tokenAddress))
    : 9;
  const { amountInput, amountRaw } = parseSolanaAmountInput(input.amount, tokenDecimals);

  const [nativeBalance, tokenBalance] = await Promise.all([
    getSolanaNativeBalanceLamports(env, fromAddress),
    tokenAddress ? getSolanaSplBalanceRaw(env, fromAddress, tokenAddress) : Promise.resolve(0n),
  ]);

  if (!tokenAddress && nativeBalance < amountRaw) {
    throw new Error('insufficient_native_balance');
  }
  if (tokenAddress && tokenBalance < amountRaw) {
    throw new Error('insufficient_token_balance');
  }

  const signed = await buildSignedSolanaTransfer(env, userId, {
    toAddress,
    tokenAddress,
    amountRaw,
  });

  if (!tokenAddress && nativeBalance < amountRaw + signed.estimatedFeeLamports) {
    throw new Error('insufficient_native_balance');
  }
  if (tokenAddress && nativeBalance < signed.estimatedFeeLamports) {
    throw new Error('insufficient_native_balance');
  }

  return {
    mode: 'solana',
    env,
    transactionBytes: signed.transactionBytes,
    quote: {
      chainId: 101,
      fromAddress: signed.fromAddress,
      toAddress,
      tokenAddress,
      tokenSymbol: input.tokenSymbol?.trim().toUpperCase() || (tokenAddress ? null : 'SOL'),
      tokenDecimals,
      amountInput,
      amountRaw: amountRaw.toString(),
      estimatedFeeWei: signed.estimatedFeeLamports.toString(),
      estimatedFeeTokenAmount: null,
      estimatedFeeTokenWei: null,
      estimatedFeeTokenAddress: null,
      estimatedFeeTokenChainId: null,
      insufficientFeeTokenBalance: false,
      estimatedGas: {
        preVerificationGas: null,
        verificationGasLimit: null,
        callGasLimit: null,
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
      },
    },
  };
}

export async function sendPreparedSolanaTransfer(prepared: PreparedSolanaTransfer): Promise<string> {
  return sendSignedSolanaTransaction(prepared.env, prepared.transactionBytes);
}

export async function waitForPreparedSolanaTransfer(
  prepared: PreparedSolanaTransfer,
  signature: string,
): Promise<'confirmed' | 'failed' | 'pending'> {
  return waitForSolanaSignature(prepared.env, signature);
}

export async function refreshSolanaTransferStatusByHash(
  env: Bindings,
  signature: string,
): Promise<'confirmed' | 'failed' | 'pending'> {
  return getSolanaSignatureStatus(env, signature);
}
