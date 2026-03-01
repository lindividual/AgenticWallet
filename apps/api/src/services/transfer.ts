import { createNexusClient } from '@biconomy/abstractjs';
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
import { baseSepolia, sepolia } from 'viem/chains';
import type { Bindings, TransferQuoteRequest, TransferQuoteResponse } from '../types';
import { requiredEnv } from '../utils/env';
import { decryptString } from '../utils/crypto';
import { createBiconomyMultichainAccount, getWalletWithPrivateKey } from './wallet';

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

type ChainRuntimeConfig = {
  chain: Chain;
  rpcUrl: string;
};

type TransferCall = {
  to: Address;
  data: `0x${string}`;
  value: bigint;
};

export type PreparedTransfer = {
  quote: TransferQuoteResponse;
  call: TransferCall;
  nexusClient: ReturnType<typeof createNexusClient>;
};

function resolveChainConfig(env: Bindings, chainId: number): ChainRuntimeConfig {
  if (chainId === sepolia.id) {
    return {
      chain: sepolia,
      rpcUrl: requiredEnv(env.ETHEREUM_RPC_URL, 'ETHEREUM_RPC_URL'),
    };
  }
  if (chainId === baseSepolia.id) {
    return {
      chain: baseSepolia,
      rpcUrl: requiredEnv(env.BASE_RPC_URL, 'BASE_RPC_URL'),
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
  const wallet = await getWalletWithPrivateKey(env.DB, userId);
  if (!wallet) {
    throw new Error('wallet_not_found');
  }

  const privateKey = await decryptString(wallet.encryptedPrivateKey, env.APP_SECRET);
  const smartAccount = await createBiconomyMultichainAccount(env, privateKey as `0x${string}`);
  const deployment = smartAccount.deploymentOn(chainId, true);

  const client = createNexusClient({
    chain: deployment.chain,
    account: deployment,
    ...(env.BICONOMY_BUNDLER_URL?.trim()
      ? { bundlerUrl: env.BICONOMY_BUNDLER_URL.trim() }
      : env.BICONOMY_BUNDLER_API_KEY?.trim()
        ? { apiKey: env.BICONOMY_BUNDLER_API_KEY.trim() }
        : {}),
  });

  const fromAddress =
    wallet.chainAccounts.find((row) => row.chainId === chainId)?.address ??
    wallet.address ??
    deployment.address;

  return {
    wallet,
    deployment,
    client,
    fromAddress: fromAddress as Address,
  };
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

  const { chain } = resolveChainConfig(env, chainId);
  const toAddress = toAddressOrThrow(input.toAddress, 'to_address');
  const tokenAddress = input.tokenAddress?.trim() ? toAddressOrThrow(input.tokenAddress, 'token_address') : null;

  const { client, deployment, fromAddress } = await buildTransferContext(env, userId, chain.id);

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
  let txValue = 0n;

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

    call = {
      to: tokenAddress,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [toAddress, amountRaw],
      }),
      value: 0n,
    };
  } else {
    const nativeBalance = await deployment.publicClient.getBalance({ address: fromAddress });
    if (nativeBalance < amountRaw) {
      throw new Error('insufficient_native_balance');
    }

    txValue = amountRaw;
    call = {
      to: toAddress,
      data: '0x',
      value: amountRaw,
    };
  }

  const userOp = (await client.prepareUserOperation({ calls: [call] })) as unknown as Record<string, unknown>;
  const feeEstimate = estimateFeeWei(userOp);

  return {
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
      estimatedGas: feeEstimate.estimatedGas,
    },
    call,
    nexusClient: client,
  };
}

export async function sendPreparedTransfer(prepared: PreparedTransfer): Promise<Hash> {
  const hash = await prepared.nexusClient.sendTransaction({ calls: [prepared.call] });
  return hash;
}

export async function waitForTransferReceipt(
  prepared: PreparedTransfer,
  txHash: Hash,
): Promise<'confirmed' | 'failed' | 'pending'> {
  try {
    const receipt = await prepared.nexusClient.waitForTransactionReceipt({
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
  chainId: number,
  txHash: Hash,
): Promise<'confirmed' | 'failed' | 'pending'> {
  const { chain, rpcUrl } = resolveChainConfig(env, chainId);
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
