import { createMeeClient, type GetQuotePayload, type MeeClient } from '@biconomy/abstractjs';
import {
  createPublicClient,
  encodeFunctionData,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Chain,
  type Hash,
} from 'viem';
import { base, bsc, mainnet } from 'viem/chains';
import type { Bindings, TradeQuoteRequest, TradeQuoteResponse } from '../types';
import { getChainConfigByNetworkKey } from '../config/appConfig';
import {
  BASE_NETWORK_KEY,
  BNB_NETWORK_KEY,
  ETHEREUM_NETWORK_KEY,
  SOLANA_NETWORK_KEY,
  buildEvmWalletExecutionContext,
  getWalletChainAddress,
} from './wallet';
import {
  prepareSolanaTrade,
  refreshSolanaTradeStatusByHash,
  sendPreparedSolanaTrade,
  waitForPreparedSolanaTrade,
  type PreparedSolanaTrade,
} from './solanaTrade';

const ERC20_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const MAX_UINT256 = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;
const DEFAULT_TRADE_SLIPPAGE_BPS = 100;

type ChainRuntimeConfig = {
  chain: Chain;
  rpcUrl?: string;
};

type TradeCall = {
  to: Address;
  data: `0x${string}`;
  value: bigint;
};

type ZeroExQuoteResponse = {
  price?: number | string;
  buyAmount?: number | string;
  sellAmount?: number | string;
  allowanceTarget?: string;
  issues?: {
    allowance?: {
      actual?: string;
      spender?: string;
    };
  };
  transaction?: {
    to?: string;
    data?: string;
    value?: string;
  };
};

export type PreparedTrade = {
  mode: 'mee';
  quote: TradeQuoteResponse;
  meeClient: MeeClient;
  meeQuote: GetQuotePayload;
};

export type PreparedAnyTrade = PreparedTrade | PreparedSolanaTrade;

function isPreparedSolanaTrade(prepared: PreparedAnyTrade): prepared is PreparedSolanaTrade {
  return 'mode' in prepared && prepared.mode === 'solana';
}

function resolveChainConfig(env: Bindings, networkKey: string): ChainRuntimeConfig {
  if (networkKey === ETHEREUM_NETWORK_KEY) {
    return {
      chain: mainnet,
      rpcUrl: env.ETHEREUM_RPC_URL?.trim() || undefined,
    };
  }
  if (networkKey === BASE_NETWORK_KEY) {
    return {
      chain: base,
      rpcUrl: env.BASE_RPC_URL?.trim() || undefined,
    };
  }
  if (networkKey === BNB_NETWORK_KEY) {
    return {
      chain: bsc,
      rpcUrl: env.BNB_RPC_URL?.trim() || undefined,
    };
  }
  throw new Error('unsupported_chain');
}

function toAddressOrThrow(raw: string, field: string): Address {
  const normalized = raw.trim();
  if (!isAddress(normalized)) {
    throw new Error(`invalid_${field}`);
  }
  return normalized;
}

function parseAmountRaw(amount: string, decimals: number): bigint {
  const normalized = amount.trim();
  if (!normalized) {
    throw new Error('invalid_sell_amount');
  }
  const raw = parseUnits(normalized, decimals);
  if (raw <= 0n) {
    throw new Error('invalid_sell_amount');
  }
  return raw;
}

function parseBigintString(raw: string | null | undefined): bigint | null {
  if (!raw) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function parseTransactionValue(raw: string | null | undefined): bigint {
  if (!raw) return 0n;
  try {
    const value = BigInt(raw);
    return value >= 0n ? value : 0n;
  } catch {
    return 0n;
  }
}

function normalizeTokenDecimals(input: number | undefined): number | null {
  if (input === undefined) return null;
  if (!Number.isFinite(input)) return null;
  const value = Math.floor(input);
  if (value < 0 || value > 36) return null;
  return value;
}

function normalizeHexData(raw: string | null | undefined): `0x${string}` {
  const value = (raw ?? '').trim();
  if (!value.startsWith('0x')) {
    throw new Error('trade_provider_invalid_response');
  }
  return value as `0x${string}`;
}

function normalizeBigintLike(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return BigInt(Math.floor(value));
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) return null;
    try {
      return BigInt(normalized);
    } catch {
      return null;
    }
  }
  return null;
}

function estimateFeeWei(userOp: Record<string, unknown>): {
  estimatedFeeWei: string | null;
  estimatedGas: TradeQuoteResponse['estimatedGas'];
} {
  const preVerificationGas = normalizeBigintLike(userOp.preVerificationGas);
  const verificationGasLimit = normalizeBigintLike(userOp.verificationGasLimit);
  const callGasLimit = normalizeBigintLike(userOp.callGasLimit);
  const maxFeePerGas = normalizeBigintLike(userOp.maxFeePerGas);
  const maxPriorityFeePerGas = normalizeBigintLike(userOp.maxPriorityFeePerGas);
  const paymasterVerificationGasLimit = normalizeBigintLike(userOp.paymasterVerificationGasLimit) ?? 0n;
  const paymasterPostOpGasLimit = normalizeBigintLike(userOp.paymasterPostOpGasLimit) ?? 0n;

  let estimatedFeeWei: string | null = null;
  if (
    preVerificationGas !== null
    && verificationGasLimit !== null
    && callGasLimit !== null
    && maxFeePerGas !== null
  ) {
    const totalGas =
      preVerificationGas + verificationGasLimit + callGasLimit + paymasterVerificationGasLimit + paymasterPostOpGasLimit;
    estimatedFeeWei = (totalGas * maxFeePerGas).toString();
  }

  return {
    estimatedFeeWei,
    estimatedGas: {
      preVerificationGas: preVerificationGas?.toString() ?? null,
      verificationGasLimit: verificationGasLimit?.toString() ?? null,
      callGasLimit: callGasLimit?.toString() ?? null,
      maxFeePerGas: maxFeePerGas?.toString() ?? null,
      maxPriorityFeePerGas: maxPriorityFeePerGas?.toString() ?? null,
    },
  };
}

function resolveTradeSlippageBps(env: Bindings, input?: number): number {
  if (Number.isFinite(input)) {
    const normalized = Math.floor(Number(input));
    if (normalized >= 5 && normalized <= 3000) {
      return normalized;
    }
  }

  const fromEnv = Number(env.TRADE_DEFAULT_SLIPPAGE_BPS);
  if (Number.isFinite(fromEnv)) {
    const normalized = Math.floor(fromEnv);
    if (normalized >= 5 && normalized <= 3000) {
      return normalized;
    }
  }

  return DEFAULT_TRADE_SLIPPAGE_BPS;
}

function resolveTradeAggregatorBaseUrl(env: Bindings): string {
  return env.TRADE_AGGREGATOR_BASE_URL?.trim() || 'https://api.0x.org';
}

async function fetchZeroExQuote(
  env: Bindings,
  input: {
    chainId: number;
    sellToken: Address;
    buyToken: Address;
    sellAmount: string;
    taker: Address;
    slippageBps: number;
  },
): Promise<ZeroExQuoteResponse> {
  const url = new URL('/swap/allowance-holder/quote', resolveTradeAggregatorBaseUrl(env));
  url.searchParams.set('chainId', String(input.chainId));
  url.searchParams.set('sellToken', input.sellToken);
  url.searchParams.set('buyToken', input.buyToken);
  url.searchParams.set('sellAmount', input.sellAmount);
  url.searchParams.set('taker', input.taker);
  url.searchParams.set('slippageBps', String(input.slippageBps));

  const headers: HeadersInit = {
    Accept: 'application/json',
    '0x-version': 'v2',
  };

  const apiKey = env.TRADE_AGGREGATOR_API_KEY?.trim();
  if (apiKey) {
    headers['0x-api-key'] = apiKey;
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`trade_provider_http_${response.status}:${detail.slice(0, 300)}`);
  }

  const payload = (await response.json()) as ZeroExQuoteResponse;
  if (!payload.transaction?.to || !payload.transaction?.data || !payload.buyAmount || !payload.sellAmount) {
    throw new Error('trade_provider_invalid_response');
  }

  return payload;
}

async function buildTradeContext(env: Bindings, userId: string, networkKey: string) {
  const { wallet, account } = await buildEvmWalletExecutionContext(env, userId);
  const { chain } = resolveChainConfig(env, networkKey);
  const deployment = account.deploymentOn(chain.id, true);
  const meeClient = await createMeeClient({ account });
  const fromAddress =
    getWalletChainAddress(wallet, networkKey)
    ?? account.signer.address;

  return {
    account,
    deployment,
    meeClient,
    fromAddress: fromAddress as Address,
  };
}

function resolveMeeSponsorshipEnabled(env: Bindings): boolean {
  const raw = env.MEE_SPONSORSHIP_ENABLED?.trim().toLowerCase();
  if (!raw) return false;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return false;
}

export async function prepareTrade(
  env: Bindings,
  userId: string,
  input: TradeQuoteRequest,
): Promise<PreparedAnyTrade> {
  const networkKey = input.networkKey?.trim().toLowerCase();
  const chainConfig = getChainConfigByNetworkKey(networkKey);
  if (!chainConfig) {
    throw new Error('invalid_network_key');
  }
  if (networkKey === SOLANA_NETWORK_KEY) {
    return prepareSolanaTrade(env, userId, input);
  }

  const { chain } = resolveChainConfig(env, networkKey);
  const sellTokenAddress = toAddressOrThrow(input.sellTokenAddress, 'sell_token_address');
  const buyTokenAddress = toAddressOrThrow(input.buyTokenAddress, 'buy_token_address');

  if (sellTokenAddress.toLowerCase() === buyTokenAddress.toLowerCase()) {
    throw new Error('invalid_trade_pair');
  }

  const { account, deployment, meeClient, fromAddress } = await buildTradeContext(env, userId, networkKey);

  let sellTokenDecimals = normalizeTokenDecimals(input.sellTokenDecimals);
  if (sellTokenDecimals === null) {
    const value = await deployment.publicClient.readContract({
      address: sellTokenAddress,
      abi: ERC20_ABI,
      functionName: 'decimals',
      args: [],
    });
    sellTokenDecimals = Number(value);
  }

  let buyTokenDecimals = normalizeTokenDecimals(input.buyTokenDecimals);
  if (buyTokenDecimals === null) {
    const value = await deployment.publicClient.readContract({
      address: buyTokenAddress,
      abi: ERC20_ABI,
      functionName: 'decimals',
      args: [],
    });
    buyTokenDecimals = Number(value);
  }

  if (sellTokenDecimals === null || buyTokenDecimals === null) {
    throw new Error('invalid_token_decimals');
  }

  const sellAmountRaw = parseAmountRaw(input.sellAmount, sellTokenDecimals);
  const sellTokenBalance = await deployment.publicClient.readContract({
    address: sellTokenAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [fromAddress],
  });

  if (sellTokenBalance < sellAmountRaw) {
    throw new Error('insufficient_token_balance');
  }

  const slippageBps = resolveTradeSlippageBps(env, input.slippageBps);
  const providerQuote = await fetchZeroExQuote(env, {
    chainId: chain.id,
    sellToken: sellTokenAddress,
    buyToken: buyTokenAddress,
    sellAmount: sellAmountRaw.toString(),
    taker: fromAddress,
    slippageBps,
  });

  const quotedSellAmountRaw = parseBigintString(String(providerQuote.sellAmount));
  const expectedBuyAmountRaw = parseBigintString(String(providerQuote.buyAmount));
  if (quotedSellAmountRaw === null || quotedSellAmountRaw <= 0n || expectedBuyAmountRaw === null || expectedBuyAmountRaw <= 0n) {
    throw new Error('trade_provider_invalid_response');
  }

  const allowanceTargetCandidate = providerQuote.issues?.allowance?.spender ?? providerQuote.allowanceTarget ?? null;
  const allowanceTarget = allowanceTargetCandidate ? toAddressOrThrow(allowanceTargetCandidate, 'allowance_target') : null;

  let needsApproval = false;
  let instructions = [] as Awaited<ReturnType<typeof account.buildComposable>>;

  if (allowanceTarget) {
    const allowance = await deployment.publicClient.readContract({
      address: sellTokenAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [fromAddress, allowanceTarget],
    });

    if (allowance < quotedSellAmountRaw) {
      needsApproval = true;
      instructions = await account.buildComposable(
        {
          type: 'rawCalldata',
          data: {
            to: sellTokenAddress,
            calldata: encodeFunctionData({
              abi: ERC20_ABI,
              functionName: 'approve',
              args: [allowanceTarget, MAX_UINT256],
            }),
            value: 0n,
            chainId: chain.id,
          },
        },
        instructions,
      );
    }
  }

  const swapTo = toAddressOrThrow(providerQuote.transaction?.to ?? '', 'trade_to_address');
  instructions = await account.buildComposable(
    {
      type: 'rawCalldata',
      data: {
        to: swapTo,
        calldata: normalizeHexData(providerQuote.transaction?.data),
        value: parseTransactionValue(providerQuote.transaction?.value),
        chainId: chain.id,
      },
    },
    instructions,
  );

  const sponsorshipEnabled = resolveMeeSponsorshipEnabled(env);
  const useFeeToken = !sponsorshipEnabled;
  if (useFeeToken) {
    try {
      await meeClient.getSupportedFeeToken({
        chainId: chain.id,
        tokenAddress: sellTokenAddress,
      });
    } catch {
      if (!sponsorshipEnabled) {
        throw new Error('unsupported_fee_token');
      }
    }
  }

  const meeQuote = await meeClient.getQuote({
    instructions,
    delegate: true,
    multichain7702Auth: true,
    ...(useFeeToken
      ? {
          feeToken: {
            address: sellTokenAddress,
            chainId: chain.id,
          },
        }
      : {
          sponsorship: true as const,
        }),
  });
  const price = Number(providerQuote.price);

  return {
    mode: 'mee',
    quote: {
      networkKey,
      chainId: chain.id,
      fromAddress,
      sellTokenAddress,
      sellTokenSymbol: input.sellTokenSymbol?.trim().toUpperCase() || null,
      sellTokenDecimals,
      buyTokenAddress,
      buyTokenSymbol: input.buyTokenSymbol?.trim().toUpperCase() || null,
      buyTokenDecimals,
      sellAmountInput: input.sellAmount.trim(),
      sellAmountRaw: quotedSellAmountRaw.toString(),
      expectedBuyAmountRaw: expectedBuyAmountRaw.toString(),
      price: Number.isFinite(price) ? price : null,
      slippageBps,
      allowanceTarget,
      needsApproval,
      estimatedFeeWei: meeQuote.paymentInfo.tokenWeiAmount ?? '0',
      estimatedGas: {
        preVerificationGas: null,
        verificationGasLimit: null,
        callGasLimit: null,
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
      },
      provider: '0x',
    },
    meeClient,
    meeQuote,
  };
}

export async function sendPreparedTrade(prepared: PreparedAnyTrade): Promise<Hash> {
  if (isPreparedSolanaTrade(prepared)) {
    return await sendPreparedSolanaTrade(prepared) as Hash;
  }
  const payload = await prepared.meeClient.executeQuote({ quote: prepared.meeQuote });
  return payload.hash;
}

export async function waitForTradeReceipt(
  prepared: PreparedAnyTrade,
  txHash: Hash,
): Promise<'confirmed' | 'failed' | 'pending'> {
  if (isPreparedSolanaTrade(prepared)) {
    return waitForPreparedSolanaTrade(prepared, txHash);
  }
  try {
    const receipt = await prepared.meeClient.waitForSupertransactionReceipt({ hash: txHash });
    if (receipt.transactionStatus === 'SUCCESS' || receipt.transactionStatus === 'MINED_SUCCESS') {
      return 'confirmed';
    }
    if (receipt.transactionStatus === 'FAILED' || receipt.transactionStatus === 'MINED_FAIL') {
      return 'failed';
    }
    return 'pending';
  } catch {
    return 'pending';
  }
}

export async function refreshTradeStatusByHash(
  env: Bindings,
  networkKey: string,
  txHash: Hash,
): Promise<'confirmed' | 'failed' | 'pending'> {
  if (networkKey === SOLANA_NETWORK_KEY) {
    return refreshSolanaTradeStatusByHash(env, txHash);
  }
  const { chain, rpcUrl } = resolveChainConfig(env, networkKey);
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    return receipt.status === 'success' ? 'confirmed' : 'failed';
  } catch {
    return 'pending';
  }
}
