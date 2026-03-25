import { createMeeClient } from '@biconomy/abstractjs';
import {
  createWalletClient,
  formatUnits,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Chain,
  type Hash,
} from 'viem';
import { arbitrum, base, bsc, mainnet, optimism, polygon } from 'viem/chains';
import type {
  Bindings,
  CrossChainTransferLegQuote,
  CrossChainTransferQuoteRequest,
  CrossChainTransferQuoteResponse,
  CrossChainTransferSourceOption,
  CrossChainTransferSubmitLegResult,
  CrossChainTransferSubmitResponse,
  SupportedStablecoinSymbol,
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
import {
  buildStablecoinTransferPlan,
  getStablecoinNetworkAsset,
  type StablecoinBalance,
  type StablecoinPlanSource,
  type StablecoinTransferPlan,
} from './stablecoinAbstraction';
import { requiredEnv } from '../utils/env';

const DEFAULT_CROSSCHAIN_SLIPPAGE = 0.01;

type BiconomyAuthorizationRequest = {
  address: Address;
  chainId: number;
  nonce: number;
};

type PlannedBridgeLeg = {
  quote: CrossChainTransferLegQuote;
  biconomyQuote: BiconomyQuoteResponse;
};

type PlannedDirectLeg = {
  quote: CrossChainTransferLegQuote;
};

type PlannedQuote = {
  plan: StablecoinTransferPlan;
  response: CrossChainTransferQuoteResponse;
  directLeg: PlannedDirectLeg | null;
  bridgeLeg: PlannedBridgeLeg | null;
};

type BiconomyRouteStep = {
  type?: string | null;
  protocol?: string | null;
  sources?: string[] | null;
};

type BiconomyIntentResult = {
  outputAmount?: string | null;
  minOutputAmount?: string | null;
  route?: {
    summary?: string | null;
    steps?: BiconomyRouteStep[] | null;
    totalGasFeesUsd?: number | string | null;
    totalBridgeFeesUsd?: number | string | null;
    estimatedTime?: number | string | null;
  } | null;
};

type BiconomyQuoteResponse = {
  mode: 'eoa-7702';
  ownerAddress: Address;
  fee?: {
    amount?: string | null;
    token?: string | null;
    chainId?: number | string | null;
  } | null;
  quoteType?: string | null;
  quote?: Record<string, unknown> | null;
  payloadToSign?: Array<Record<string, unknown>> | null;
  returnedData?: BiconomyIntentResult[] | null;
};

type BiconomyExecuteResponse = {
  success?: boolean;
  supertxHash?: string | null;
  error?: string | null;
};

type BiconomyQuoteRequest = {
  mode: 'eoa-7702';
  ownerAddress: Address;
  composeFlows: Array<{
    type: '/instructions/intent-simple' | '/instructions/build';
    data: Record<string, unknown>;
    batch?: boolean;
  }>;
  feeToken?: {
    address: Address;
    chainId: number;
  };
  authorizations?: Array<Record<string, unknown>>;
  simulate?: boolean;
};

type BiconomyQuote412Response = {
  authorizations?: BiconomyAuthorizationRequest[];
  message?: string;
  error?: string;
};

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function parseBigintString(raw: string | null | undefined): bigint | null {
  if (!raw) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function toAddressOrThrow(raw: string, field: string): Address {
  const normalized = raw.trim();
  if (!isAddress(normalized)) {
    throw new Error(`invalid_${field}`);
  }
  return normalized;
}

function convertAmountDecimals(value: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return value;
  if (fromDecimals < toDecimals) {
    return value * 10n ** BigInt(toDecimals - fromDecimals);
  }
  return value / 10n ** BigInt(fromDecimals - toDecimals);
}

function resolveEvmChainConfig(env: Bindings, networkKey: string): { chain: Chain; rpcUrl?: string } {
  if (networkKey === ETHEREUM_NETWORK_KEY) {
    return { chain: mainnet, rpcUrl: env.ETHEREUM_RPC_URL?.trim() || undefined };
  }
  if (networkKey === BASE_NETWORK_KEY) {
    return { chain: base, rpcUrl: env.BASE_RPC_URL?.trim() || undefined };
  }
  if (networkKey === BNB_NETWORK_KEY) {
    return { chain: bsc, rpcUrl: env.BNB_RPC_URL?.trim() || undefined };
  }
  if (networkKey === ARBITRUM_NETWORK_KEY) {
    return { chain: arbitrum, rpcUrl: env.ARBITRUM_RPC_URL?.trim() || undefined };
  }
  if (networkKey === OPTIMISM_NETWORK_KEY) {
    return { chain: optimism, rpcUrl: env.OPTIMISM_RPC_URL?.trim() || undefined };
  }
  if (networkKey === POLYGON_NETWORK_KEY) {
    return { chain: polygon, rpcUrl: env.POLYGON_RPC_URL?.trim() || undefined };
  }
  throw new Error('unsupported_crosschain_network');
}

function getBiconomyApiBaseUrl(env: Bindings): string {
  return env.BICONOMY_API_BASE_URL?.trim() || 'https://api.biconomy.io';
}

function resolveMeeSponsorshipEnabled(env: Bindings): boolean {
  const raw = env.MEE_SPONSORSHIP_ENABLED?.trim().toLowerCase();
  if (!raw) return false;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return false;
}

function resolveMeeSimulationEnabled(env: Bindings): boolean {
  const raw = env.MEE_ENABLE_SIMULATION?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return true;
}

function toSourceOption(source: StablecoinBalance): CrossChainTransferSourceOption {
  return {
    networkKey: source.networkKey,
    chainId: source.chainId,
    tokenAddress: source.tokenAddress,
    tokenSymbol: source.symbol,
    tokenDecimals: source.tokenDecimals,
    availableAmountRaw: source.availableAmountRaw.toString(),
  };
}

function buildBiconomyHeaders(env: Bindings): Headers {
  const apiKey = requiredEnv(env.BICONOMY_API_KEY, 'BICONOMY_API_KEY');
  return new Headers({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  });
}

function buildBiconomyQuoteRequest(input: {
  env: Bindings;
  source: StablecoinPlanSource;
  destinationTokenAddress: Address;
  destinationChainId: number;
  requestedAmountRaw: bigint;
  toAddress: Address;
  fromAmountRaw: bigint;
}): BiconomyQuoteRequest {
  const sponsorshipEnabled = resolveMeeSponsorshipEnabled(input.env);
  return {
    mode: 'eoa-7702',
    ownerAddress: input.source.fromAddress,
    ...(sponsorshipEnabled
      ? {}
      : {
          feeToken: {
            address: input.source.tokenAddress,
            chainId: input.source.chainId,
          },
        }),
    composeFlows: [
      {
        type: '/instructions/intent-simple',
        data: {
          srcChainId: input.source.chainId,
          dstChainId: input.destinationChainId,
          srcToken: input.source.tokenAddress,
          dstToken: input.destinationTokenAddress,
          amount: input.fromAmountRaw.toString(),
          slippage: DEFAULT_CROSSCHAIN_SLIPPAGE,
        },
        batch: true,
      },
      {
        type: '/instructions/build',
        data: {
          functionSignature: 'function transfer(address to, uint256 value)',
          args: [
            input.toAddress,
            input.requestedAmountRaw.toString(),
          ],
          to: input.destinationTokenAddress,
          chainId: input.destinationChainId,
          value: '0',
        },
        batch: true,
      },
    ],
    simulate: resolveMeeSimulationEnabled(input.env),
  };
}

async function fetchBiconomyQuoteRaw(
  env: Bindings,
  request: BiconomyQuoteRequest,
): Promise<{
  status: number;
  payload: BiconomyQuoteResponse | BiconomyQuote412Response;
}> {
  const response = await fetch(new URL('/v1/quote', getBiconomyApiBaseUrl(env)).toString(), {
    method: 'POST',
    headers: buildBiconomyHeaders(env),
    body: JSON.stringify(request),
  });
  const payload = await response.json() as unknown;
  if (response.ok || response.status === 412) {
    return {
      status: response.status,
      payload: payload as BiconomyQuoteResponse | BiconomyQuote412Response,
    };
  }

  const detail = JSON.stringify(payload).slice(0, 300);
  throw new Error(`crosschain_quote_http_${response.status}:${detail}`);
}

function extractBiconomyIntentResult(quote: BiconomyQuoteResponse): BiconomyIntentResult {
  const result = quote.returnedData?.[0];
  if (!result) {
    throw new Error('crosschain_quote_invalid_response');
  }
  return result;
}

async function fetchBiconomyQuote(
  env: Bindings,
  walletClient: ReturnType<typeof createWalletClient>,
  signerAddress: Address,
  request: BiconomyQuoteRequest,
): Promise<BiconomyQuoteResponse> {
  let currentRequest = request;
  let response = await fetchBiconomyQuoteRaw(env, currentRequest);

  if (response.status === 412) {
    const payload = response.payload as BiconomyQuote412Response;
    const authorizations = Array.isArray(payload.authorizations) ? payload.authorizations : [];
    if (authorizations.length === 0) {
      throw new Error('crosschain_quote_invalid_response');
    }

    const signedAuthorizations = await Promise.all(
      authorizations.map(async (item: BiconomyAuthorizationRequest) => {
        const authorization = await walletClient.signAuthorization({
          chainId: item.chainId,
          address: item.address,
          nonce: item.nonce,
          account: signerAddress,
        });
        return {
          ...authorization,
          yParity: authorization.yParity,
          v: authorization.v?.toString(),
        };
      }),
    );

    currentRequest = {
      ...request,
      authorizations: signedAuthorizations,
    };
    response = await fetchBiconomyQuoteRaw(env, currentRequest);
  }

  if (response.status !== 200) {
    throw new Error('crosschain_quote_invalid_response');
  }

  const quote = response.payload as BiconomyQuoteResponse;
  if (!quote.quote || !Array.isArray(quote.payloadToSign) || quote.payloadToSign.length === 0) {
    throw new Error('crosschain_quote_invalid_response');
  }
  if (quote.quoteType !== 'simple') {
    throw new Error(`unsupported_crosschain_quote_type_${quote.quoteType ?? 'unknown'}`);
  }
  extractBiconomyIntentResult(quote);
  return quote;
}

async function buildSingleSourceBridgeLeg(
  env: Bindings,
  userId: string,
  input: {
    source: StablecoinPlanSource;
    destinationNetworkKey: string;
    destinationTokenSymbol: SupportedStablecoinSymbol;
    requestedAmountRaw: bigint;
    toAddress: Address;
  },
): Promise<PlannedBridgeLeg | null> {
  const destination = getStablecoinNetworkAsset(input.destinationNetworkKey, input.destinationTokenSymbol);
  if (!destination) {
    throw new Error('unsupported_stablecoin_destination');
  }

  const source = input.source;
  const clients = await buildBridgeExecutionClients(env, userId, source.networkKey);
  const cache = new Map<string, BiconomyQuoteResponse>();

  const quoteForAmount = async (fromAmountRaw: bigint): Promise<BiconomyQuoteResponse> => {
    const key = fromAmountRaw.toString();
    const cached = cache.get(key);
    if (cached) return cached;
    const quote = await fetchBiconomyQuote(env, clients.walletClient, clients.signer.address, buildBiconomyQuoteRequest({
      env,
      source,
      destinationTokenAddress: destination.tokenAddress,
      destinationChainId: destination.chainId,
      requestedAmountRaw: input.requestedAmountRaw,
      toAddress: input.toAddress,
      fromAmountRaw,
    }));
    cache.set(key, quote);
    return quote;
  };

  const maxQuote = await quoteForAmount(source.selectedAmountRaw);
  const maxIntent = extractBiconomyIntentResult(maxQuote);
  const maxMinToAmountRaw = parseBigintString(maxIntent.minOutputAmount) ?? parseBigintString(maxIntent.outputAmount);
  if (maxMinToAmountRaw === null || maxMinToAmountRaw < input.requestedAmountRaw) {
    return null;
  }

  let selectedQuote = maxQuote;
  let selectedFromAmountRaw = source.selectedAmountRaw;
  if (maxMinToAmountRaw > input.requestedAmountRaw) {
    let low = 1n;
    let high = source.selectedAmountRaw;
    let bestQuote = maxQuote;
    let bestFromAmountRaw = source.selectedAmountRaw;
    let iterations = 0;

    while (low <= high && iterations < 16) {
      iterations += 1;
      const mid = (low + high) / 2n;
      const quote = await quoteForAmount(mid);
      const intent = extractBiconomyIntentResult(quote);
      const minToAmountRaw = parseBigintString(intent.minOutputAmount) ?? parseBigintString(intent.outputAmount);
      if (minToAmountRaw === null || minToAmountRaw <= 0n) {
        low = mid + 1n;
        continue;
      }
      if (minToAmountRaw >= input.requestedAmountRaw) {
        bestQuote = quote;
        bestFromAmountRaw = mid;
        high = mid - 1n;
      } else {
        low = mid + 1n;
      }
    }

    selectedQuote = bestQuote;
    selectedFromAmountRaw = bestFromAmountRaw;
  }

  const selectedIntent = extractBiconomyIntentResult(selectedQuote);
  const selectedMinOutputRaw = parseBigintString(selectedIntent.minOutputAmount) ?? parseBigintString(selectedIntent.outputAmount);
  if (selectedMinOutputRaw === null || selectedMinOutputRaw < input.requestedAmountRaw) {
    return null;
  }
  const route = selectedIntent.route;
  const routeSteps = route?.steps ?? [];
  const tool =
    normalizeText(route?.summary)
    ?? normalizeText(routeSteps.map((step) => normalizeText(step.protocol)).filter((value): value is string => Boolean(value)).join(' -> '))
    ?? 'biconomy';

  return {
    quote: {
      kind: 'bridge',
      fromNetworkKey: source.networkKey,
      fromChainId: source.chainId,
      fromTokenAddress: source.tokenAddress,
      fromTokenSymbol: source.symbol,
      fromTokenDecimals: source.tokenDecimals,
      fromAmountRaw: selectedFromAmountRaw.toString(),
      fromAmountInput: formatUnits(selectedFromAmountRaw, source.tokenDecimals),
      fromAddress: source.fromAddress,
      toNetworkKey: destination.networkKey,
      toChainId: destination.chainId,
      toTokenAddress: destination.tokenAddress,
      toTokenSymbol: destination.symbol,
      toTokenDecimals: destination.tokenDecimals,
      toAmountRaw: input.requestedAmountRaw.toString(),
      toAmountMinRaw: input.requestedAmountRaw.toString(),
      recipientAddress: input.toAddress,
      tool,
      approvalAddress: null,
      estimatedDurationSeconds: Number(route?.estimatedTime ?? 0) || null,
      estimatedGasCostUsd: Number.isFinite(Number(route?.totalGasFeesUsd))
        ? Number(route?.totalGasFeesUsd).toFixed(2)
        : null,
      estimatedFeeCostUsd: Number.isFinite(Number(route?.totalBridgeFeesUsd))
        ? Number(route?.totalBridgeFeesUsd).toFixed(2)
        : null,
    },
    biconomyQuote: selectedQuote,
  };
}

async function buildAvailableStablecoinBalances(
  env: Bindings,
  userId: string,
  symbol: SupportedStablecoinSymbol,
): Promise<StablecoinBalance[]> {
  const wallet = await ensureWalletForUser(env, userId);
  const { holdings } = await fetchWalletPortfolio(env, wallet);
  const output: StablecoinBalance[] = [];

  for (const chainAccount of wallet.chainAccounts.filter((row) => row.protocol === 'evm')) {
    const asset = getStablecoinNetworkAsset(chainAccount.networkKey, symbol);
    if (!asset) continue;

    const holding = holdings.find((item) =>
      item.protocol === 'evm'
      && item.network_key === chainAccount.networkKey
      && normalizeText(item.address)?.toLowerCase() === asset.tokenAddress.toLowerCase(),
    );
    const availableAmountRaw = parseBigintString(normalizeText(holding?.amount) ?? '0') ?? 0n;
    if (availableAmountRaw <= 0n) continue;

    const fromAddress = getWalletChainAddress(wallet, chainAccount.networkKey);
    if (!fromAddress || typeof fromAddress !== 'string' || !isAddress(fromAddress)) {
      continue;
    }

    output.push({
      ...asset,
      availableAmountRaw,
      fromAddress: fromAddress as Address,
    });
  }

  return output;
}

function buildDirectLeg(plan: StablecoinTransferPlan, toAddress: Address): PlannedDirectLeg | null {
  const source = plan.selectedSources[0];
  if (!source) return null;

  return {
    quote: {
      kind: 'direct',
      fromNetworkKey: source.networkKey,
      fromChainId: source.chainId,
      fromTokenAddress: source.tokenAddress,
      fromTokenSymbol: source.symbol,
      fromTokenDecimals: source.tokenDecimals,
      fromAmountRaw: source.selectedAmountRaw.toString(),
      fromAmountInput: formatUnits(source.selectedAmountRaw, source.tokenDecimals),
      fromAddress: source.fromAddress,
      toNetworkKey: plan.destination.networkKey,
      toChainId: plan.destination.chainId,
      toTokenAddress: plan.destination.tokenAddress,
      toTokenSymbol: plan.destination.symbol,
      toTokenDecimals: plan.destination.tokenDecimals,
      toAmountRaw: plan.requestedAmountRaw.toString(),
      toAmountMinRaw: plan.requestedAmountRaw.toString(),
      recipientAddress: toAddress,
      tool: 'direct',
      approvalAddress: null,
      estimatedDurationSeconds: null,
      estimatedGasCostUsd: null,
      estimatedFeeCostUsd: null,
    },
  };
}

async function planQuote(
  env: Bindings,
  userId: string,
  input: CrossChainTransferQuoteRequest,
): Promise<PlannedQuote> {
  const toAddress = toAddressOrThrow(input.toAddress, 'to_address');
  const destination = getStablecoinNetworkAsset(input.destinationNetworkKey, input.destinationTokenSymbol);
  if (!destination) {
    throw new Error('unsupported_stablecoin_destination');
  }

  const requestedAmountRaw = parseUnits(input.amount.trim(), destination.tokenDecimals);
  if (requestedAmountRaw <= 0n) {
    throw new Error('invalid_amount');
  }

  const availableSources = await buildAvailableStablecoinBalances(env, userId, input.destinationTokenSymbol);
  const plan = buildStablecoinTransferPlan({
    destinationNetworkKey: input.destinationNetworkKey,
    destinationTokenSymbol: input.destinationTokenSymbol,
    requestedAmountRaw,
    availableSources,
    sourceNetworkKey: input.sourceNetworkKey,
  });

  let directLeg: PlannedDirectLeg | null = null;
  let bridgeLeg: PlannedBridgeLeg | null = null;
  let estimatedReceivedAmountRaw = plan.estimatedReceivedAmountRaw;

  if (plan.executionMode === 'direct') {
    directLeg = buildDirectLeg(plan, toAddress);
  } else if (plan.executionMode === 'single_source_bridge') {
    const source = plan.selectedSources[0];
    if (source) {
      bridgeLeg = await buildSingleSourceBridgeLeg(env, userId, {
        source,
        destinationNetworkKey: input.destinationNetworkKey,
        destinationTokenSymbol: input.destinationTokenSymbol,
        requestedAmountRaw,
        toAddress,
      });
      if (bridgeLeg) {
        estimatedReceivedAmountRaw = BigInt(bridgeLeg.quote.toAmountRaw);
      }
    }
  }

  const selectedSourceNetworkKey = plan.selectedSourceNetworkKey
    ?? bridgeLeg?.quote.fromNetworkKey
    ?? directLeg?.quote.fromNetworkKey
    ?? null;
  const shortfallAmountRaw = estimatedReceivedAmountRaw >= requestedAmountRaw ? 0n : requestedAmountRaw - estimatedReceivedAmountRaw;

  return {
    plan: {
      ...plan,
      estimatedReceivedAmountRaw,
      shortfallAmountRaw,
    },
    response: {
      executionMode: plan.executionMode,
      canSubmit: plan.executionMode === 'direct' || plan.executionMode === 'single_source_bridge',
      toAddress,
      destinationNetworkKey: destination.networkKey,
      destinationChainId: destination.chainId,
      destinationTokenAddress: destination.tokenAddress,
      destinationTokenSymbol: destination.symbol,
      destinationTokenDecimals: destination.tokenDecimals,
      requestedAmountInput: input.amount.trim(),
      requestedAmountRaw: requestedAmountRaw.toString(),
      estimatedReceivedAmountRaw: estimatedReceivedAmountRaw.toString(),
      shortfallAmountRaw: shortfallAmountRaw.toString(),
      recommendedSourceNetworkKey: plan.recommendedSourceNetworkKey,
      selectedSourceNetworkKey,
      availableSourceOptions: plan.availableSources.map(toSourceOption),
      legs: directLeg
        ? [directLeg.quote]
        : bridgeLeg
          ? [bridgeLeg.quote]
          : plan.selectedSources.map((source) => ({
            kind: source.networkKey === destination.networkKey ? 'direct' : 'bridge',
            fromNetworkKey: source.networkKey,
            fromChainId: source.chainId,
            fromTokenAddress: source.tokenAddress,
            fromTokenSymbol: source.symbol,
            fromTokenDecimals: source.tokenDecimals,
            fromAmountRaw: source.selectedAmountRaw.toString(),
            fromAmountInput: formatUnits(source.selectedAmountRaw, source.tokenDecimals),
            fromAddress: source.fromAddress,
            toNetworkKey: destination.networkKey,
            toChainId: destination.chainId,
            toTokenAddress: destination.tokenAddress,
            toTokenSymbol: destination.symbol,
            toTokenDecimals: destination.tokenDecimals,
            toAmountRaw: convertAmountDecimals(
              source.selectedAmountRaw,
              source.tokenDecimals,
              destination.tokenDecimals,
            ).toString(),
            toAmountMinRaw: null,
            recipientAddress: toAddress,
            tool: null,
            approvalAddress: null,
            estimatedDurationSeconds: null,
            estimatedGasCostUsd: null,
            estimatedFeeCostUsd: null,
          })),
    },
    directLeg,
    bridgeLeg,
  };
}

export async function quoteCrossChainTransfer(
  env: Bindings,
  userId: string,
  input: CrossChainTransferQuoteRequest,
): Promise<CrossChainTransferQuoteResponse> {
  const planned = await planQuote(env, userId, input);
  return planned.response;
}

async function buildBridgeExecutionClients(env: Bindings, userId: string, networkKey: string) {
  const { chain, rpcUrl } = resolveEvmChainConfig(env, networkKey);
  const { wallet, signer, account } = await buildEvmWalletExecutionContext(env, userId);
  const fromAddress = getWalletChainAddress(wallet, networkKey) ?? signer.address;
  const walletClient = createWalletClient({
    account: signer,
    chain,
    transport: http(rpcUrl),
  });
  const meeClient = await createMeeClient({ account });
  return {
    signer,
    meeClient,
    fromAddress: fromAddress as Address,
    walletClient,
  };
}

async function executeBridgeLeg(
  env: Bindings,
  userId: string,
  leg: PlannedBridgeLeg,
): Promise<CrossChainTransferSubmitLegResult> {
  const clients = await buildBridgeExecutionClients(env, userId, leg.quote.fromNetworkKey);
  const payloads = leg.biconomyQuote.payloadToSign;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    throw new Error('crosschain_quote_invalid_response');
  }

  const signedPayloads = await Promise.all(
    payloads.map(async (payload) => {
      const message = typeof payload.message === 'string'
        ? payload.message
        : typeof payload.signablePayload === 'object' && payload.signablePayload !== null && typeof (payload.signablePayload as { message?: unknown }).message === 'string'
          ? (payload.signablePayload as { message: string }).message
          : null;
      if (!message) {
        throw new Error('crosschain_quote_invalid_response');
      }
      const signature = await clients.walletClient.signMessage({
        account: clients.signer,
        message,
      });
      return {
        ...payload,
        signature,
      };
    }),
  );

  const executeResponse = await fetch(new URL('/v1/execute', getBiconomyApiBaseUrl(env)).toString(), {
    method: 'POST',
    headers: buildBiconomyHeaders(env),
    body: JSON.stringify({
      ...leg.biconomyQuote,
      payloadToSign: signedPayloads,
    }),
  });
  const executePayload = await executeResponse.json() as BiconomyExecuteResponse;
  if (!executeResponse.ok) {
    const detail = JSON.stringify(executePayload).slice(0, 300);
    throw new Error(`crosschain_execute_http_${executeResponse.status}:${detail}`);
  }
  if (!executePayload.success || !executePayload.supertxHash) {
    throw new Error(`crosschain_execute_failed:${executePayload.error ?? 'unknown_error'}`);
  }

  let sourceStatus: CrossChainTransferSubmitLegResult['sourceStatus'] = 'submitted';
  try {
    const receipt = await clients.meeClient.waitForSupertransactionReceipt({
      hash: executePayload.supertxHash as Hash,
    });
    if (receipt.transactionStatus === 'SUCCESS' || receipt.transactionStatus === 'MINED_SUCCESS') {
      sourceStatus = 'confirmed';
    } else if (receipt.transactionStatus === 'FAILED' || receipt.transactionStatus === 'MINED_FAIL') {
      sourceStatus = 'failed';
    } else {
      sourceStatus = 'pending';
    }
  } catch {
    sourceStatus = 'pending';
  }

  return {
    kind: 'bridge',
    fromNetworkKey: leg.quote.fromNetworkKey,
    txHash: executePayload.supertxHash,
    approvalTxHash: null,
    sourceStatus,
    tool: leg.quote.tool,
  };
}

export async function submitCrossChainTransfer(
  env: Bindings,
  userId: string,
  input: CrossChainTransferQuoteRequest,
): Promise<CrossChainTransferSubmitResponse> {
  const planned = await planQuote(env, userId, input);

  if (planned.plan.executionMode === 'insufficient_balance') {
    throw new Error('insufficient_balance');
  }
  if (planned.plan.executionMode === 'multi_source_bridge') {
    throw new Error('multi_source_bridge_not_supported_yet');
  }

  const results: CrossChainTransferSubmitLegResult[] = [];

  if (planned.directLeg) {
    const prepared = await prepareTransfer(env, userId, {
      networkKey: planned.directLeg.quote.fromNetworkKey,
      toAddress: planned.directLeg.quote.recipientAddress,
      amount: planned.directLeg.quote.fromAmountInput,
      tokenAddress: planned.directLeg.quote.fromTokenAddress,
      tokenSymbol: planned.directLeg.quote.fromTokenSymbol ?? undefined,
      tokenDecimals: planned.directLeg.quote.fromTokenDecimals,
    });
    const txHash = await sendPreparedTransfer(prepared);
    const status = await waitForTransferReceipt(prepared, txHash);
    results.push({
      kind: 'direct',
      fromNetworkKey: planned.directLeg.quote.fromNetworkKey,
      txHash,
      approvalTxHash: null,
      sourceStatus: status,
      tool: 'direct',
    });
  } else if (planned.bridgeLeg) {
    results.push(await executeBridgeLeg(env, userId, planned.bridgeLeg));
  }

  const hasFailure = results.some((item) => item.sourceStatus === 'failed');
  const hasPending = results.some((item) => item.sourceStatus === 'pending' || item.sourceStatus === 'submitted');
  const hasBridge = results.some((item) => item.kind === 'bridge');

  return {
    status: hasFailure
      ? 'failed'
      : hasPending
        ? 'pending'
        : hasBridge
          ? 'submitted'
          : 'confirmed',
    quote: planned.response,
    legs: results,
  };
}
