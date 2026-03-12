import { createMeeClient, type GetQuotePayload, type MeeClient } from '@biconomy/abstractjs';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Chain,
  type Hash,
} from 'viem';
import { base, bsc, mainnet } from 'viem/chains';
import type { Bindings, TransferQuoteRequest, TransferQuoteResponse } from '../types';
import { buildEvmWalletExecutionContext, getWalletChainAddress } from './wallet';
import {
  prepareSolanaTransfer,
  refreshSolanaTransferStatusByHash,
  sendPreparedSolanaTransfer,
  waitForPreparedSolanaTransfer,
  type PreparedSolanaTransfer,
} from './solanaTransfer';

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
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const DEFAULT_TRANSFER_CALL_GAS_LIMIT = 35_000n;

type ChainRuntimeConfig = {
  chain: Chain;
  rpcUrl?: string;
};

type TransferCall = {
  to: Address;
  data: `0x${string}`;
  value: bigint;
};

type MeePreparedTransfer = {
  mode: 'mee';
  quote: TransferQuoteResponse;
  meeClient: MeeClient;
  meeQuote: GetQuotePayload;
};

type EoaPreparedTransfer = {
  mode: 'eoa';
  quote: TransferQuoteResponse;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  request: {
    chain: Chain;
    account: Address;
    to: Address;
    value: bigint;
    data?: `0x${string}`;
  };
};

export type PreparedTransfer = MeePreparedTransfer | EoaPreparedTransfer | PreparedSolanaTransfer;

function resolveChainConfig(env: Bindings, chainId: number): ChainRuntimeConfig {
  if (chainId === mainnet.id) {
    return {
      chain: mainnet,
      rpcUrl: env.ETHEREUM_RPC_URL?.trim() || undefined,
    };
  }
  if (chainId === base.id) {
    return {
      chain: base,
      rpcUrl: env.BASE_RPC_URL?.trim() || undefined,
    };
  }
  if (chainId === bsc.id) {
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
    throw new Error('invalid_amount');
  }
  const raw = parseUnits(normalized, decimals);
  if (raw <= 0n) {
    throw new Error('invalid_amount');
  }
  return raw;
}

function normalizeTokenDecimals(input: number | undefined): number | null {
  if (input === undefined) return null;
  if (!Number.isFinite(input)) return null;
  const value = Math.floor(input);
  if (value < 0 || value > 36) return null;
  return value;
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
      return normalized.startsWith('0x') || normalized.startsWith('0X')
        ? BigInt(normalized)
        : BigInt(normalized);
    } catch {
      return null;
    }
  }
  return null;
}

function estimateFeeWei(userOp: Record<string, unknown>): {
  estimatedFeeWei: string | null;
  estimatedGas: TransferQuoteResponse['estimatedGas'];
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
    preVerificationGas !== null &&
    verificationGasLimit !== null &&
    callGasLimit !== null &&
    maxFeePerGas !== null
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

async function buildTransferContext(env: Bindings, userId: string, chainId: number) {
  const { chain, rpcUrl } = resolveChainConfig(env, chainId);
  const { wallet, signer, account } = await buildEvmWalletExecutionContext(env, userId);
  const deployment = account.deploymentOn(chainId, true);
  const publicClient = deployment.publicClient;
  const walletClient = createWalletClient({
    account: signer,
    chain,
    transport: http(rpcUrl),
  });
  const meeClient = await createMeeClient({ account });

  const fromAddress =
    getWalletChainAddress(wallet, chainId) ??
    signer.address;

  return {
    wallet,
    signer,
    account,
    deployment,
    publicClient,
    walletClient,
    meeClient,
    fromAddress: fromAddress as Address,
  };
}

async function estimateDirectFee(
  publicClient: ReturnType<typeof createPublicClient>,
  request: { account: Address; to: Address; value: bigint; data?: `0x${string}` },
): Promise<{
  estimatedFeeWei: string | null;
  estimatedGas: TransferQuoteResponse['estimatedGas'];
}> {
  const [gasLimit, feeEstimate] = await Promise.all([
    publicClient.estimateGas(request),
    publicClient.estimateFeesPerGas().catch(async () => {
      const gasPrice = await publicClient.getGasPrice();
      return {
        gasPrice,
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: null,
      };
    }),
  ]);
  const maxFeePerGas = feeEstimate.maxFeePerGas ?? feeEstimate.gasPrice ?? null;
  const estimatedFeeWei = maxFeePerGas !== null ? (gasLimit * maxFeePerGas).toString() : null;

  return {
    estimatedFeeWei,
    estimatedGas: {
      preVerificationGas: null,
      verificationGasLimit: null,
      callGasLimit: gasLimit.toString(),
      maxFeePerGas: maxFeePerGas?.toString() ?? null,
      maxPriorityFeePerGas: feeEstimate.maxPriorityFeePerGas?.toString() ?? null,
    },
  };
}

function resolveMeeSponsorshipEnabled(env: Bindings): boolean {
  const raw = env.MEE_SPONSORSHIP_ENABLED?.trim().toLowerCase();
  if (!raw) return false;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return false;
}

export async function prepareTransfer(
  env: Bindings,
  userId: string,
  input: TransferQuoteRequest,
): Promise<PreparedTransfer> {
  const chainId = Number(input.chainId);
  if (!Number.isFinite(chainId)) {
    throw new Error('invalid_chain_id');
  }
  if (chainId === 101) {
    return prepareSolanaTransfer(env, userId, input);
  }

  const { chain } = resolveChainConfig(env, chainId);
  const toAddress = toAddressOrThrow(input.toAddress, 'to_address');
  const tokenAddress = input.tokenAddress?.trim() ? toAddressOrThrow(input.tokenAddress, 'token_address') : null;

  const {
    account,
    deployment,
    publicClient,
    walletClient,
    meeClient,
    fromAddress,
    signer,
  } = await buildTransferContext(env, userId, chain.id);

  let tokenDecimals = tokenAddress ? normalizeTokenDecimals(input.tokenDecimals) : 18;
  if (tokenAddress && tokenDecimals === null) {
    const value = await deployment.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'decimals',
      args: [],
    });
    tokenDecimals = Number(value);
  }
  if (tokenDecimals === null) {
    throw new Error('invalid_token_decimals');
  }

  const amountRaw = parseAmountRaw(input.amount, tokenDecimals);
  let call: TransferCall;

  if (tokenAddress) {
    const tokenBalance = await deployment.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [fromAddress],
    });
    if (tokenBalance < amountRaw) {
      throw new Error('insufficient_token_balance');
    }

    const feeTokenAddress = input.feeTokenAddress?.trim()
      ? toAddressOrThrow(input.feeTokenAddress, 'fee_token_address')
      : tokenAddress;
    const feeTokenChainId =
      input.feeTokenChainId !== undefined ? Number(input.feeTokenChainId) : chain.id;
    if (!Number.isFinite(feeTokenChainId)) {
      throw new Error('invalid_fee_token_chain_id');
    }

    const simulationEnabled = resolveMeeSimulationEnabled(env);
    const transferCallGasLimit = resolveTransferCallGasLimit(env);
    const transferInstructionData: {
      chainId: number;
      tokenAddress: Address;
      amount: bigint;
      recipient: Address;
      gasLimit?: bigint;
    } = {
      chainId: chain.id,
      tokenAddress,
      amount: amountRaw,
      recipient: toAddress,
    };
    if (!simulationEnabled) {
      transferInstructionData.gasLimit = transferCallGasLimit;
    }
    const instructions = await account.buildComposable(
      {
        type: 'transfer',
        data: transferInstructionData,
      },
      [],
    );
    console.log('[transfer/quote][mee] instructions_built', {
      userId,
      chainId: chain.id,
      tokenAddress,
      toAddress,
      amountRaw: amountRaw.toString(),
      simulationEnabled,
      gasLimit: simulationEnabled ? null : transferCallGasLimit.toString(),
      instructions: toLogSafe(instructions),
    });
    try {
      await meeClient.getSupportedFeeToken({
        chainId: feeTokenChainId,
        tokenAddress: feeTokenAddress,
      });
    } catch {
      throw new Error('unsupported_fee_token');
    }
    let meeQuote: GetQuotePayload;
    try {
      meeQuote = await meeClient.getQuote({
        instructions,
        feeToken: {
          address: feeTokenAddress,
          chainId: feeTokenChainId,
        },
        delegate: true,
        multichain7702Auth: true,
        ...(simulationEnabled
          ? {
              simulation: {
                simulate: true,
              },
            }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      const feeDetail = parseMeeInsufficientFeeMessage(message);
      if (feeDetail) {
        console.error('[transfer/quote][mee] insufficient_fee_detail', {
          userId,
          chainId: chain.id,
          tokenAddress,
          feeTokenAddress,
          feeTokenChainId,
          ...feeDetail,
        });
      }
      throw error instanceof Error ? error : new Error('transfer_quote_failed');
    }

    const feeTokenWeiAmount = parseBigintString(meeQuote.paymentInfo.tokenWeiAmount);
    const insufficientFeeTokenBalance =
      feeTokenAddress.toLowerCase() === tokenAddress.toLowerCase() &&
      feeTokenChainId === chain.id &&
      feeTokenWeiAmount !== null &&
      tokenBalance < amountRaw + feeTokenWeiAmount;

    return {
      mode: 'mee',
      quote: {
        chainId: chain.id,
        fromAddress,
        toAddress,
        tokenAddress,
        tokenSymbol: input.tokenSymbol?.trim().toUpperCase() || null,
        tokenDecimals,
        amountInput: input.amount.trim(),
        amountRaw: amountRaw.toString(),
        // Keep legacy field for backward compatibility in web UI.
        estimatedFeeWei: meeQuote.paymentInfo.tokenWeiAmount ?? null,
        estimatedFeeTokenAmount: meeQuote.paymentInfo.tokenAmount ?? null,
        estimatedFeeTokenWei: meeQuote.paymentInfo.tokenWeiAmount ?? null,
        estimatedFeeTokenAddress: meeQuote.paymentInfo.token ?? null,
        estimatedFeeTokenChainId: Number(meeQuote.paymentInfo.chainId),
        insufficientFeeTokenBalance,
        estimatedGas: {
          preVerificationGas: null,
          verificationGasLimit: null,
          callGasLimit: null,
          maxFeePerGas: null,
          maxPriorityFeePerGas: null,
        },
      },
      meeClient,
      meeQuote,
    };
  } else {
    const nativeBalance = await publicClient.getBalance({ address: fromAddress });
    if (nativeBalance < amountRaw) {
      throw new Error('insufficient_native_balance');
    }

    const sponsorshipEnabled = resolveMeeSponsorshipEnabled(env);
    if (sponsorshipEnabled) {
      const instructions = await account.buildComposable(
        {
          type: 'nativeTokenTransfer',
          data: {
            chainId: chain.id,
            to: toAddress,
            value: amountRaw,
            gasLimit: resolveTransferCallGasLimit(env),
          },
        },
        [],
      );
      const meeQuote = await meeClient.getQuote({
        instructions,
        sponsorship: true,
        delegate: true,
        multichain7702Auth: true,
        ...(resolveMeeSimulationEnabled(env)
          ? {
              simulation: {
                simulate: true,
              },
            }
          : {}),
      });

      return {
        mode: 'mee',
        quote: {
          chainId: chain.id,
          fromAddress,
          toAddress,
          tokenAddress,
          tokenSymbol: input.tokenSymbol?.trim().toUpperCase() || null,
          tokenDecimals,
          amountInput: input.amount.trim(),
          amountRaw: amountRaw.toString(),
          estimatedFeeWei: meeQuote.paymentInfo.tokenWeiAmount ?? '0',
          estimatedFeeTokenAmount: meeQuote.paymentInfo.tokenAmount ?? null,
          estimatedFeeTokenWei: meeQuote.paymentInfo.tokenWeiAmount ?? null,
          estimatedFeeTokenAddress: meeQuote.paymentInfo.token ?? null,
          estimatedFeeTokenChainId: Number(meeQuote.paymentInfo.chainId),
          insufficientFeeTokenBalance: false,
          estimatedGas: {
            preVerificationGas: null,
            verificationGasLimit: null,
            callGasLimit: null,
            maxFeePerGas: null,
            maxPriorityFeePerGas: null,
          },
        },
        meeClient,
        meeQuote,
      };
    }

    call = {
      to: toAddress,
      data: '0x',
      value: amountRaw,
    };
    const feeEstimate = await estimateDirectFee(publicClient, {
      account: signer.address,
      to: call.to,
      value: call.value,
      data: call.data,
    });

    return {
      mode: 'eoa',
      quote: {
        chainId: chain.id,
        fromAddress,
        toAddress,
        tokenAddress,
        tokenSymbol: input.tokenSymbol?.trim().toUpperCase() || null,
        tokenDecimals,
        amountInput: input.amount.trim(),
        amountRaw: amountRaw.toString(),
        estimatedFeeWei: feeEstimate.estimatedFeeWei,
        estimatedFeeTokenAmount: null,
        estimatedFeeTokenWei: null,
        estimatedFeeTokenAddress: null,
        estimatedFeeTokenChainId: null,
        insufficientFeeTokenBalance: false,
        estimatedGas: feeEstimate.estimatedGas,
      },
      publicClient,
      walletClient,
      request: {
        chain,
        account: signer.address,
        to: call.to,
        value: call.value,
        data: call.data,
      },
    };
  }
}

export async function sendPreparedTransfer(prepared: PreparedTransfer): Promise<Hash> {
  if (prepared.quote.insufficientFeeTokenBalance) {
    throw new Error('insufficient_fee_token_balance');
  }
  if (prepared.mode === 'solana') {
    return await sendPreparedSolanaTransfer(prepared) as Hash;
  }

  if (prepared.mode === 'mee') {
    const payload = await prepared.meeClient.executeQuote({ quote: prepared.meeQuote });
    return payload.hash;
  }

  return prepared.walletClient.sendTransaction(prepared.request);
}

export async function waitForTransferReceipt(
  prepared: PreparedTransfer,
  txHash: Hash,
): Promise<'confirmed' | 'failed' | 'pending'> {
  if (prepared.mode === 'solana') {
    return waitForPreparedSolanaTransfer(prepared, txHash);
  }
  if (prepared.mode === 'mee') {
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

  try {
    const receipt = await prepared.publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
      timeout: 120_000,
    });

    return receipt.status === 'success' ? 'confirmed' : 'failed';
  } catch {
    return 'pending';
  }
}

export async function refreshTransferStatusByHash(
  env: Bindings,
  userId: string,
  chainId: number,
  txHash: Hash,
): Promise<'confirmed' | 'failed' | 'pending'> {
  if (chainId === 101) {
    return refreshSolanaTransferStatusByHash(env, txHash);
  }
  try {
    const { meeClient } = await buildTransferContext(env, userId, chainId);
    const receipt = await meeClient.getSupertransactionReceipt({ hash: txHash, waitForReceipts: false });
    if (receipt.transactionStatus === 'SUCCESS' || receipt.transactionStatus === 'MINED_SUCCESS') {
      return 'confirmed';
    }
    if (receipt.transactionStatus === 'FAILED' || receipt.transactionStatus === 'MINED_FAIL') {
      return 'failed';
    }
  } catch {
    // Fallback to direct chain receipt lookup for non-MEE tx hashes.
  }
  const { publicClient } = await buildTransferContext(env, userId, chainId);

  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    return receipt.status === 'success' ? 'confirmed' : 'failed';
  } catch {
    return 'pending';
  }
}

function parseBigintString(raw: string | null | undefined): bigint | null {
  if (!raw) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function toLogSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => toLogSafe(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, toLogSafe(v)]));
  }
  return value;
}

function resolveTransferCallGasLimit(env: Bindings): bigint {
  const raw = env.MEE_TRANSFER_CALL_GAS_LIMIT?.trim();
  if (!raw) return DEFAULT_TRANSFER_CALL_GAS_LIMIT;
  try {
    const parsed = BigInt(raw);
    if (parsed <= 0n) return DEFAULT_TRANSFER_CALL_GAS_LIMIT;
    return parsed;
  } catch {
    return DEFAULT_TRANSFER_CALL_GAS_LIMIT;
  }
}

function resolveMeeSimulationEnabled(env: Bindings): boolean {
  const raw = env.MEE_ENABLE_SIMULATION?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return true;
}

function parseMeeInsufficientFeeMessage(message: string): {
  gasFeeUsd: string | null;
  orchestrationFeeUsd: string | null;
  totalFeeUsd: string | null;
} | null {
  const normalized = message.trim();
  if (!normalized) return null;
  const gasMatch = normalized.match(/\$([0-9]+(?:\.[0-9]+)?)\s+gas fee/i);
  const orchestrationMatch = normalized.match(/\$([0-9]+(?:\.[0-9]+)?)\s+orchestration fee/i);
  if (!gasMatch && !orchestrationMatch) return null;

  const gasFeeUsd = gasMatch?.[1] ?? null;
  const orchestrationFeeUsd = orchestrationMatch?.[1] ?? null;
  const totalFeeUsd =
    gasFeeUsd !== null && orchestrationFeeUsd !== null
      ? (Number(gasFeeUsd) + Number(orchestrationFeeUsd)).toFixed(6)
      : null;

  return {
    gasFeeUsd,
    orchestrationFeeUsd,
    totalFeeUsd,
  };
}
