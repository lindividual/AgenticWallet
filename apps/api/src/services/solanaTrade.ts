import type { Bindings, TradeQuoteRequest, TradeQuoteResponse } from '../types';
import {
  WRAPPED_SOL_MINT,
  buildSignedJupiterSwap,
  fetchJupiterQuote,
  getSolanaMintDecimals,
  getSolanaNativeBalanceLamports,
  getSolanaSignatureStatus,
  getSolanaSplBalanceRaw,
  getSolanaWrappedMintForTrade,
  parseSolanaAmountInput,
  waitForSolanaSignature,
} from './solana';
import { ensureWalletForUser, SOLANA_NETWORK_KEY } from './wallet';

export type PreparedSolanaTrade = {
  mode: 'solana';
  env: Bindings;
  quote: TradeQuoteResponse;
  transactionBytes: Uint8Array;
};

function normalizeSlippageBps(input: number | undefined, fallback = 100): number {
  if (!Number.isFinite(input)) return fallback;
  const value = Math.trunc(Number(input));
  return value >= 5 && value <= 3000 ? value : fallback;
}

function parseBigintString(raw: unknown): bigint | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

export async function prepareSolanaTrade(
  env: Bindings,
  userId: string,
  input: TradeQuoteRequest,
): Promise<PreparedSolanaTrade> {
  const wallet = await ensureWalletForUser(env, userId);

  const fromAddress = wallet.chainAccounts.find((row) => row.networkKey === SOLANA_NETWORK_KEY)?.address;
  if (!fromAddress) {
    throw new Error('wallet_not_found');
  }

  const sellMint = getSolanaWrappedMintForTrade(input.sellTokenAddress);
  const buyMint = getSolanaWrappedMintForTrade(input.buyTokenAddress);
  if (sellMint === buyMint) {
    throw new Error('invalid_trade_pair');
  }

  const sellTokenDecimals = Number.isFinite(input.sellTokenDecimals)
    ? Number(input.sellTokenDecimals)
    : await getSolanaMintDecimals(env, sellMint);
  const buyTokenDecimals = Number.isFinite(input.buyTokenDecimals)
    ? Number(input.buyTokenDecimals)
    : await getSolanaMintDecimals(env, buyMint);
  const { amountInput, amountRaw } = parseSolanaAmountInput(input.sellAmount, sellTokenDecimals);

  const sellBalance = sellMint === WRAPPED_SOL_MINT
    ? await getSolanaNativeBalanceLamports(env, fromAddress)
    : await getSolanaSplBalanceRaw(env, fromAddress, sellMint);
  if (sellBalance < amountRaw) {
    throw new Error('insufficient_token_balance');
  }

  const slippageBps = normalizeSlippageBps(input.slippageBps);
  const quoteResponse = await fetchJupiterQuote(env, {
    inputMint: sellMint,
    outputMint: buyMint,
    amount: amountRaw.toString(),
    slippageBps,
  });

  const quotedSellAmountRaw = parseBigintString(quoteResponse.inAmount);
  const expectedBuyAmountRaw = parseBigintString(quoteResponse.outAmount);
  if (!quotedSellAmountRaw || !expectedBuyAmountRaw) {
    throw new Error('trade_provider_invalid_response');
  }

  const signed = await buildSignedJupiterSwap(env, userId, quoteResponse);
  const numericSell = Number(amountRaw) / 10 ** sellTokenDecimals;
  const numericBuy = Number(expectedBuyAmountRaw) / 10 ** buyTokenDecimals;
  const price = Number.isFinite(numericSell) && numericSell > 0 && Number.isFinite(numericBuy)
    ? numericBuy / numericSell
    : null;

  return {
    mode: 'solana',
    env,
    transactionBytes: signed.transactionBytes,
    quote: {
      networkKey: SOLANA_NETWORK_KEY,
      chainId: null,
      fromAddress,
      sellTokenAddress: sellMint,
      sellTokenSymbol: input.sellTokenSymbol?.trim().toUpperCase() || (sellMint === WRAPPED_SOL_MINT ? 'SOL' : null),
      sellTokenDecimals,
      buyTokenAddress: buyMint,
      buyTokenSymbol: input.buyTokenSymbol?.trim().toUpperCase() || (buyMint === WRAPPED_SOL_MINT ? 'SOL' : null),
      buyTokenDecimals,
      sellAmountInput: amountInput,
      sellAmountRaw: quotedSellAmountRaw.toString(),
      expectedBuyAmountRaw: expectedBuyAmountRaw.toString(),
      price,
      slippageBps,
      allowanceTarget: null,
      needsApproval: false,
      estimatedFeeWei: signed.prioritizationFeeLamports?.toString() ?? null,
      estimatedGas: {
        preVerificationGas: null,
        verificationGasLimit: null,
        callGasLimit: null,
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
      },
      provider: 'jupiter',
    },
  };
}

export async function sendPreparedSolanaTrade(prepared: PreparedSolanaTrade): Promise<string> {
  const { sendSignedSolanaTransaction } = await import('./solana');
  return sendSignedSolanaTransaction(prepared.env, prepared.transactionBytes);
}

export async function waitForPreparedSolanaTrade(
  prepared: PreparedSolanaTrade,
  signature: string,
): Promise<'confirmed' | 'failed' | 'pending'> {
  return waitForSolanaSignature(prepared.env, signature);
}

export async function refreshSolanaTradeStatusByHash(
  env: Bindings,
  signature: string,
): Promise<'confirmed' | 'failed' | 'pending'> {
  return getSolanaSignatureStatus(env, signature);
}
