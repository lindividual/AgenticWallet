import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Chain,
} from 'viem';
import { arbitrum, base, bsc, mainnet, optimism, polygon } from 'viem/chains';
import type {
  Bindings,
  CrossChainTransferLegQuote,
  CrossChainTransferQuoteRequest,
  CrossChainTransferQuoteResponse,
  CrossChainTransferSubmitLegResult,
  CrossChainTransferSubmitResponse,
} from '../types';
import { fetchWalletPortfolio } from './market';
import { prepareTransfer, sendPreparedTransfer, waitForTransferReceipt } from './transfer';
import {
  ARBITRUM_NETWORK_KEY,
  BASE_NETWORK_KEY,
  BNB_NETWORK_KEY,
  ETHEREUM_NETWORK_KEY,
  OPTIMISM_NETWORK_KEY,
  POLYGON_NETWORK_KEY,
  buildEvmWalletExecutionContext,
  ensureWalletForUser,
  getWalletChainAddress,
} from './wallet';

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

type EvmPortfolioHolding = Awaited<ReturnType<typeof fetchWalletPortfolio>>['holdings'][number];

type EvmChainRuntimeConfig = {
  networkKey: string;
  chain: Chain;
  rpcUrl?: string;
};

type LiFiGasCost = {
  amountUSD?: string | number | null;
};

type LiFiFeeCost = {
  amountUSD?: string | number | null;
};

type LiFiQuoteResponse = {
  tool?: string | null;
  toolDetails?: {
    name?: string | null;
  };
  action?: {
    fromChainId?: number | string | null;
    toChainId?: number | string | null;
    fromToken?: {
      address?: string | null;
      symbol?: string | null;
      decimals?: number | string | null;
    };
    toToken?: {
      address?: string | null;
      symbol?: string | null;
      decimals?: number | string | null;
    };
    fromAmount?: string | null;
    fromAddress?: string | null;
    toAddress?: string | null;
  };
  estimate?: {
    toAmount?: string | null;
    toAmountMin?: string | null;
    approvalAddress?: string | null;
    gasCosts?: LiFiGasCost[] | null;
    feeCosts?: LiFiFeeCost[] | null;
    executionDuration?: number | string | null;
  };
  transactionRequest?: {
    to?: string | null;
    data?: string | null;
    value?: string | null;
    gasLimit?: string | null;
    gasPrice?: string | null;
    maxFeePerGas?: string | null;
    maxPriorityFeePerGas?: string | null;
  } | null;
};

type DirectPlanLeg = {
  kind: 'direct';
  quote: CrossChainTransferLegQuote;
};

type BridgePlanLeg = {
  kind: 'bridge';
  quote: CrossChainTransferLegQuote;
  lifiQuote: LiFiQuoteResponse;
};

type PlannedCrossChainTransfer = {
  response: CrossChainTransferQuoteResponse;
  legs: Array<DirectPlanLeg | BridgePlanLeg>;
};

type SourceCandidate = {
  networkKey: string;
  chainId: number;
  tokenAddress: Address;
  tokenSymbol: string | null;
  tokenDecimals: number;
  availableAmountRaw: bigint;
  fromAddress: Address;
  inputIndex: number;
};

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function normalizeFiniteNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizePositiveInt(raw: unknown, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.trunc(value);
}

function parseBigintString(raw: string | null | undefined): bigint | null {
  if (!raw) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function buildBridgeSendTransactionOverrides(request: NonNullable<LiFiQuoteResponse['transactionRequest']>):
  | {
    gas?: bigint;
    gasPrice: bigint;
  }
  | {
    gas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  } {
  const gas = parseBigintString(request.gasLimit) ?? undefined;
  const gasPrice = parseBigintString(request.gasPrice) ?? undefined;
  const maxFeePerGas = parseBigintString(request.maxFeePerGas) ?? undefined;
  const maxPriorityFeePerGas = parseBigintString(request.maxPriorityFeePerGas) ?? undefined;

  if (gasPrice !== undefined) {
    return {
      gas,
      gasPrice,
    };
  }

  return {
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
}

function toAddressOrThrow(raw: string, field: string): Address {
  const normalized = raw.trim();
  if (!isAddress(normalized)) {
    throw new Error(`invalid_${field}`);
  }
  return normalized;
}

function resolveEvmChainConfig(env: Bindings, networkKey: string): EvmChainRuntimeConfig {
  if (networkKey === ETHEREUM_NETWORK_KEY) {
    return { networkKey, chain: mainnet, rpcUrl: env.ETHEREUM_RPC_URL?.trim() || undefined };
  }
  if (networkKey === BASE_NETWORK_KEY) {
    return { networkKey, chain: base, rpcUrl: env.BASE_RPC_URL?.trim() || undefined };
  }
  if (networkKey === BNB_NETWORK_KEY) {
    return { networkKey, chain: bsc, rpcUrl: env.BNB_RPC_URL?.trim() || undefined };
  }
  if (networkKey === ARBITRUM_NETWORK_KEY) {
    return { networkKey, chain: arbitrum, rpcUrl: env.ARBITRUM_RPC_URL?.trim() || undefined };
  }
  if (networkKey === OPTIMISM_NETWORK_KEY) {
    return { networkKey, chain: optimism, rpcUrl: env.OPTIMISM_RPC_URL?.trim() || undefined };
  }
  if (networkKey === POLYGON_NETWORK_KEY) {
    return { networkKey, chain: polygon, rpcUrl: env.POLYGON_RPC_URL?.trim() || undefined };
  }
  throw new Error('unsupported_crosschain_network');
}

function getLiFiApiBaseUrl(env: Bindings): string {
  return env.LIFI_API_BASE_URL?.trim() || 'https://li.quest';
}

function resolveUsdTotal(items: Array<LiFiGasCost | LiFiFeeCost> | null | undefined): string | null {
  const total = (items ?? []).reduce((acc, item) => acc + Number(item.amountUSD ?? 0), 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  return total.toFixed(2);
}

async function getTokenDecimals(
  env: Bindings,
  networkKey: string,
  tokenAddress: Address,
): Promise<number> {
  const { chain, rpcUrl } = resolveEvmChainConfig(env, networkKey);
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
  const decimals = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'decimals',
    args: [],
  });
  return normalizePositiveInt(decimals, 18);
}

async function fetchLiFiQuote(
  env: Bindings,
  input: {
    fromChainId: number;
    toChainId: number;
    fromTokenAddress: Address;
    toTokenAddress: Address;
    fromAmountRaw: bigint;
    fromAddress: Address;
    toAddress: Address;
  },
): Promise<LiFiQuoteResponse> {
  const url = new URL('/v1/quote', getLiFiApiBaseUrl(env));
  url.searchParams.set('fromChain', String(input.fromChainId));
  url.searchParams.set('toChain', String(input.toChainId));
  url.searchParams.set('fromToken', input.fromTokenAddress);
  url.searchParams.set('toToken', input.toTokenAddress);
  url.searchParams.set('fromAmount', input.fromAmountRaw.toString());
  url.searchParams.set('fromAddress', input.fromAddress);
  url.searchParams.set('toAddress', input.toAddress);
  url.searchParams.set('preset', 'stablecoin');
  url.searchParams.set('order', 'CHEAPEST');
  url.searchParams.set('integrator', 'agentic-wallet');

  const headers = new Headers({
    Accept: 'application/json',
  });
  const apiKey = env.LIFI_API_KEY?.trim();
  if (apiKey) {
    headers.set('x-lifi-api-key', apiKey);
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`crosschain_quote_http_${response.status}:${detail}`);
  }

  const payload = (await response.json()) as LiFiQuoteResponse;
  if (!payload.transactionRequest?.to || !payload.transactionRequest?.data) {
    throw new Error('crosschain_quote_invalid_response');
  }
  if (!payload.action?.fromAmount || !payload.estimate?.toAmount) {
    throw new Error('crosschain_quote_invalid_response');
  }
  return payload;
}

async function buildBridgePlanLeg(
  env: Bindings,
  params: {
    candidate: SourceCandidate;
    targetNetworkKey: string;
    targetChainId: number;
    targetTokenAddress: Address;
    targetTokenSymbol: string | null;
    targetTokenDecimals: number;
    toAddress: Address;
    requestedTargetAmountRaw: bigint;
    desiredTargetAmountRaw: bigint;
  },
): Promise<BridgePlanLeg | null> {
  const cache = new Map<string, LiFiQuoteResponse>();

  const quoteForAmount = async (fromAmountRaw: bigint): Promise<LiFiQuoteResponse> => {
    const cacheKey = fromAmountRaw.toString();
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const quote = await fetchLiFiQuote(env, {
      fromChainId: params.candidate.chainId,
      toChainId: params.targetChainId,
      fromTokenAddress: params.candidate.tokenAddress,
      toTokenAddress: params.targetTokenAddress,
      fromAmountRaw,
      fromAddress: params.candidate.fromAddress,
      toAddress: params.toAddress,
    });
    cache.set(cacheKey, quote);
    return quote;
  };

  const fullQuote = await quoteForAmount(params.candidate.availableAmountRaw);
  const fullToAmountRaw = parseBigintString(fullQuote.estimate?.toAmount);
  if (fullToAmountRaw === null || fullToAmountRaw <= 0n) {
    return null;
  }

  let selectedQuote = fullQuote;
  if (fullToAmountRaw > params.desiredTargetAmountRaw) {
    let low = 1n;
    let high = params.candidate.availableAmountRaw;
    let bestQuote = fullQuote;
    let iterations = 0;

    while (low <= high && iterations < 16) {
      iterations += 1;
      const mid = (low + high) / 2n;
      const quote = await quoteForAmount(mid);
      const toAmountRaw = parseBigintString(quote.estimate?.toAmount);
      if (toAmountRaw === null || toAmountRaw <= 0n) {
        low = mid + 1n;
        continue;
      }
      if (toAmountRaw >= params.desiredTargetAmountRaw) {
        bestQuote = quote;
        high = mid - 1n;
      } else {
        low = mid + 1n;
      }
    }

    selectedQuote = bestQuote;
  }

  const selectedFromAmountRaw = parseBigintString(selectedQuote.action?.fromAmount);
  const selectedToAmountRaw = parseBigintString(selectedQuote.estimate?.toAmount);
  if (selectedFromAmountRaw === null || selectedToAmountRaw === null || selectedFromAmountRaw <= 0n || selectedToAmountRaw <= 0n) {
    return null;
  }

  const toAmountMinRaw = parseBigintString(selectedQuote.estimate?.toAmountMin);
  const tool = normalizeText(selectedQuote.toolDetails?.name) ?? normalizeText(selectedQuote.tool) ?? null;
  const quote: CrossChainTransferLegQuote = {
    kind: 'bridge',
    fromNetworkKey: params.candidate.networkKey,
    fromChainId: params.candidate.chainId,
    fromTokenAddress: params.candidate.tokenAddress,
    fromTokenSymbol: params.candidate.tokenSymbol,
    fromTokenDecimals: params.candidate.tokenDecimals,
    fromAmountRaw: selectedFromAmountRaw.toString(),
    fromAmountInput: formatUnits(selectedFromAmountRaw, params.candidate.tokenDecimals),
    fromAddress: params.candidate.fromAddress,
    toNetworkKey: params.targetNetworkKey,
    toChainId: params.targetChainId,
    toTokenAddress: params.targetTokenAddress,
    toTokenSymbol: params.targetTokenSymbol,
    toTokenDecimals: params.targetTokenDecimals,
    toAmountRaw: selectedToAmountRaw.toString(),
    toAmountMinRaw: toAmountMinRaw?.toString() ?? null,
    recipientAddress: params.toAddress,
    tool,
    approvalAddress: normalizeText(selectedQuote.estimate?.approvalAddress),
    estimatedDurationSeconds: normalizeFiniteNumber(selectedQuote.estimate?.executionDuration),
    estimatedGasCostUsd: resolveUsdTotal(selectedQuote.estimate?.gasCosts),
    estimatedFeeCostUsd: resolveUsdTotal(selectedQuote.estimate?.feeCosts),
  };

  return {
    kind: 'bridge',
    quote,
    lifiQuote: selectedQuote,
  };
}

function buildDirectPlanLeg(
  quote: CrossChainTransferLegQuote,
): DirectPlanLeg {
  return {
    kind: 'direct',
    quote,
  };
}

function sortCandidates(
  candidates: SourceCandidate[],
  targetNetworkKey: string,
  targetTokenAddress: Address,
): SourceCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftIsDirect = left.networkKey === targetNetworkKey && left.tokenAddress.toLowerCase() === targetTokenAddress.toLowerCase();
    const rightIsDirect = right.networkKey === targetNetworkKey && right.tokenAddress.toLowerCase() === targetTokenAddress.toLowerCase();
    if (leftIsDirect !== rightIsDirect) {
      return leftIsDirect ? -1 : 1;
    }
    return left.inputIndex - right.inputIndex;
  });
}

async function planCrossChainTransfer(
  env: Bindings,
  userId: string,
  input: CrossChainTransferQuoteRequest,
): Promise<PlannedCrossChainTransfer> {
  const toAddress = toAddressOrThrow(input.toAddress, 'to_address');
  const targetTokenAddress = toAddressOrThrow(input.targetTokenAddress, 'target_token_address');
  const targetTokenSymbol = normalizeText(input.targetTokenSymbol)?.toUpperCase() ?? null;
  const wallet = await ensureWalletForUser(env, userId);
  const targetChain = resolveEvmChainConfig(env, input.targetNetworkKey);
  const targetTokenDecimals = Number.isFinite(input.targetTokenDecimals)
    ? Number(input.targetTokenDecimals)
    : await getTokenDecimals(env, input.targetNetworkKey, targetTokenAddress);

  const requestedTargetAmountRaw = parseUnits(input.amount.trim(), targetTokenDecimals);
  if (requestedTargetAmountRaw <= 0n) {
    throw new Error('invalid_amount');
  }

  if (!Array.isArray(input.sources) || input.sources.length === 0) {
    throw new Error('invalid_crosschain_sources');
  }

  const { holdings } = await fetchWalletPortfolio(env, wallet);
  const candidates: SourceCandidate[] = [];

  for (let index = 0; index < input.sources.length; index += 1) {
    const source = input.sources[index];
    const sourceChain = resolveEvmChainConfig(env, source.networkKey);
    const sourceTokenAddress = toAddressOrThrow(source.tokenAddress, 'source_token_address');
    const portfolioHolding = holdings.find((row) => {
      if (row.protocol !== 'evm') return false;
      if ((row.network_key ?? '').trim().toLowerCase() !== source.networkKey.trim().toLowerCase()) return false;
      return normalizeText(row.address)?.toLowerCase() === sourceTokenAddress.toLowerCase();
    });

    const availableAmountRaw = parseBigintString(normalizeText(portfolioHolding?.amount) ?? '0') ?? 0n;
    if (availableAmountRaw <= 0n) {
      continue;
    }

    const fromAddress = getWalletChainAddress(wallet, source.networkKey);
    if (!fromAddress || typeof fromAddress !== 'string' || !isAddress(fromAddress)) {
      throw new Error('wallet_not_found');
    }

    const tokenDecimals = Number.isFinite(source.tokenDecimals)
      ? Number(source.tokenDecimals)
      : Number.isFinite(portfolioHolding?.decimals)
        ? Number(portfolioHolding?.decimals)
        : await getTokenDecimals(env, source.networkKey, sourceTokenAddress);

    candidates.push({
      networkKey: source.networkKey.trim().toLowerCase(),
      chainId: sourceChain.chain.id,
      tokenAddress: sourceTokenAddress,
      tokenSymbol: normalizeText(source.tokenSymbol)?.toUpperCase() ?? normalizeText(portfolioHolding?.symbol)?.toUpperCase() ?? null,
      tokenDecimals,
      availableAmountRaw,
      fromAddress: fromAddress as Address,
      inputIndex: index,
    });
  }

  if (!candidates.length) {
    throw new Error('crosschain_source_balance_not_found');
  }

  const sortedCandidates = sortCandidates(candidates, input.targetNetworkKey, targetTokenAddress);
  const plannedLegs: Array<DirectPlanLeg | BridgePlanLeg> = [];
  let remainingTargetAmountRaw = requestedTargetAmountRaw;

  for (const candidate of sortedCandidates) {
    if (remainingTargetAmountRaw <= 0n) {
      break;
    }

    const isDirect = candidate.networkKey === input.targetNetworkKey
      && candidate.tokenAddress.toLowerCase() === targetTokenAddress.toLowerCase();

    if (isDirect) {
      const selectedFromAmountRaw = candidate.availableAmountRaw < remainingTargetAmountRaw
        ? candidate.availableAmountRaw
        : remainingTargetAmountRaw;
      if (selectedFromAmountRaw <= 0n) {
        continue;
      }

      const directQuote = await prepareTransfer(env, userId, {
        networkKey: candidate.networkKey,
        toAddress,
        amount: formatUnits(selectedFromAmountRaw, candidate.tokenDecimals),
        tokenAddress: candidate.tokenAddress,
        tokenSymbol: candidate.tokenSymbol ?? targetTokenSymbol ?? undefined,
        tokenDecimals: candidate.tokenDecimals,
      });

      plannedLegs.push(buildDirectPlanLeg({
        kind: 'direct',
        fromNetworkKey: candidate.networkKey,
        fromChainId: candidate.chainId,
        fromTokenAddress: candidate.tokenAddress,
        fromTokenSymbol: candidate.tokenSymbol,
        fromTokenDecimals: candidate.tokenDecimals,
        fromAmountRaw: selectedFromAmountRaw.toString(),
        fromAmountInput: formatUnits(selectedFromAmountRaw, candidate.tokenDecimals),
        fromAddress: candidate.fromAddress,
        toNetworkKey: input.targetNetworkKey,
        toChainId: targetChain.chain.id,
        toTokenAddress: targetTokenAddress,
        toTokenSymbol: targetTokenSymbol,
        toTokenDecimals: targetTokenDecimals,
        toAmountRaw: selectedFromAmountRaw.toString(),
        toAmountMinRaw: selectedFromAmountRaw.toString(),
        recipientAddress: toAddress,
        tool: 'direct',
        approvalAddress: null,
        estimatedDurationSeconds: null,
        estimatedGasCostUsd: null,
        estimatedFeeCostUsd: directQuote.quote.estimatedFeeWei,
      }));
      remainingTargetAmountRaw -= selectedFromAmountRaw;
      continue;
    }

    const bridgeLeg = await buildBridgePlanLeg(env, {
      candidate,
      targetNetworkKey: input.targetNetworkKey,
      targetChainId: targetChain.chain.id,
      targetTokenAddress,
      targetTokenSymbol,
      targetTokenDecimals,
      toAddress,
      requestedTargetAmountRaw,
      desiredTargetAmountRaw: remainingTargetAmountRaw,
    });
    if (!bridgeLeg) {
      continue;
    }

    plannedLegs.push(bridgeLeg);
    remainingTargetAmountRaw -= BigInt(bridgeLeg.quote.toAmountRaw);
  }

  const estimatedReceivedAmountRaw = plannedLegs.reduce((total, leg) => total + BigInt(leg.quote.toAmountRaw), 0n);
  const response: CrossChainTransferQuoteResponse = {
    toAddress,
    targetNetworkKey: input.targetNetworkKey,
    targetChainId: targetChain.chain.id,
    targetTokenAddress,
    targetTokenSymbol,
    targetTokenDecimals,
    requestedAmountInput: input.amount.trim(),
    requestedAmountRaw: requestedTargetAmountRaw.toString(),
    estimatedReceivedAmountRaw: estimatedReceivedAmountRaw.toString(),
    fullyCovered: estimatedReceivedAmountRaw >= requestedTargetAmountRaw,
    shortfallAmountRaw: estimatedReceivedAmountRaw >= requestedTargetAmountRaw
      ? '0'
      : (requestedTargetAmountRaw - estimatedReceivedAmountRaw).toString(),
    legs: plannedLegs.map((leg) => leg.quote),
  };

  return {
    response,
    legs: plannedLegs,
  };
}

export async function quoteCrossChainTransfer(
  env: Bindings,
  userId: string,
  input: CrossChainTransferQuoteRequest,
): Promise<CrossChainTransferQuoteResponse> {
  const planned = await planCrossChainTransfer(env, userId, input);
  return planned.response;
}

async function buildBridgeExecutionClients(env: Bindings, userId: string, networkKey: string) {
  const { chain, rpcUrl } = resolveEvmChainConfig(env, networkKey);
  const { wallet, signer } = await buildEvmWalletExecutionContext(env, userId);
  const fromAddress = getWalletChainAddress(wallet, networkKey) ?? signer.address;
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account: signer,
    chain,
    transport: http(rpcUrl),
  });
  return {
    chain,
    signer,
    fromAddress: fromAddress as Address,
    publicClient,
    walletClient,
  };
}

async function executeBridgePlanLeg(
  env: Bindings,
  userId: string,
  leg: BridgePlanLeg,
): Promise<CrossChainTransferSubmitLegResult> {
  const clients = await buildBridgeExecutionClients(env, userId, leg.quote.fromNetworkKey);
  const approvalAddress = normalizeText(leg.quote.approvalAddress);
  let approvalTxHash: string | null = null;

  if (approvalAddress) {
    const allowance = await clients.publicClient.readContract({
      address: leg.quote.fromTokenAddress as Address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [clients.fromAddress, approvalAddress as Address],
    });

    if (allowance < BigInt(leg.quote.fromAmountRaw)) {
      approvalTxHash = await clients.walletClient.sendTransaction({
        account: clients.signer,
        to: leg.quote.fromTokenAddress as Address,
        value: 0n,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [approvalAddress as Address, BigInt(leg.quote.fromAmountRaw)],
        }),
      });

      await clients.publicClient.waitForTransactionReceipt({
        hash: approvalTxHash as `0x${string}`,
        confirmations: 1,
        timeout: 120_000,
      });
    }
  }

  const request = leg.lifiQuote.transactionRequest;
  if (!request?.to || !request.data) {
    throw new Error('crosschain_quote_invalid_response');
  }

  const feeOverrides = buildBridgeSendTransactionOverrides(request);
  const transactionBase = {
    account: clients.signer,
    to: request.to as Address,
    value: parseBigintString(request.value) ?? 0n,
    data: request.data as `0x${string}`,
  };
  const txHash = 'gasPrice' in feeOverrides
    ? await clients.walletClient.sendTransaction({
      ...transactionBase,
      gas: feeOverrides.gas,
      gasPrice: feeOverrides.gasPrice,
    })
    : await clients.walletClient.sendTransaction({
      ...transactionBase,
      gas: feeOverrides.gas,
      maxFeePerGas: feeOverrides.maxFeePerGas,
      maxPriorityFeePerGas: feeOverrides.maxPriorityFeePerGas,
    });

  let sourceStatus: CrossChainTransferSubmitLegResult['sourceStatus'] = 'submitted';
  try {
    const receipt = await clients.publicClient.waitForTransactionReceipt({
      hash: txHash as `0x${string}`,
      confirmations: 1,
      timeout: 120_000,
    });
    sourceStatus = receipt.status === 'success' ? 'confirmed' : 'failed';
  } catch {
    sourceStatus = 'pending';
  }

  return {
    kind: 'bridge',
    fromNetworkKey: leg.quote.fromNetworkKey,
    txHash,
    approvalTxHash,
    sourceStatus,
    tool: leg.quote.tool,
  };
}

export async function submitCrossChainTransfer(
  env: Bindings,
  userId: string,
  input: CrossChainTransferQuoteRequest,
): Promise<CrossChainTransferSubmitResponse> {
  const planned = await planCrossChainTransfer(env, userId, input);
  const results: CrossChainTransferSubmitLegResult[] = [];

  for (const leg of planned.legs) {
    if (leg.kind === 'direct') {
      const prepared = await prepareTransfer(env, userId, {
        networkKey: leg.quote.fromNetworkKey,
        toAddress: leg.quote.recipientAddress,
        amount: leg.quote.fromAmountInput,
        tokenAddress: leg.quote.fromTokenAddress,
        tokenSymbol: leg.quote.fromTokenSymbol ?? undefined,
        tokenDecimals: leg.quote.fromTokenDecimals,
      });
      const txHash = await sendPreparedTransfer(prepared);
      const status = await waitForTransferReceipt(prepared, txHash);
      results.push({
        kind: 'direct',
        fromNetworkKey: leg.quote.fromNetworkKey,
        txHash,
        approvalTxHash: null,
        sourceStatus: status,
        tool: 'direct',
      });
      continue;
    }

    results.push(await executeBridgePlanLeg(env, userId, leg));
  }

  const hasFailure = results.some((item) => item.sourceStatus === 'failed');
  const hasPending = results.some((item) => item.sourceStatus === 'pending' || item.sourceStatus === 'submitted');
  const hasBridge = results.some((item) => item.kind === 'bridge');

  const status: CrossChainTransferSubmitResponse['status'] = hasFailure
    ? 'failed'
    : hasPending
      ? 'pending'
      : hasBridge
        ? 'submitted'
        : 'confirmed';

  return {
    status,
    quote: planned.response,
    legs: results,
  };
}
