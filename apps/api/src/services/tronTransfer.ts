import { encodeAbiParameters, formatUnits, parseAbiParameters, parseUnits } from 'viem';
import { decryptString } from '../utils/crypto';
import type { Bindings, TransferQuoteRequest, TransferQuoteResponse } from '../types';
import {
  computeTronTransactionId,
  hexToBytes,
  normalizeTronAddress,
  signTronDigest,
  tronAddressToEvmAddress,
} from '../utils/tron';
import { ensureWalletWithPrivateKey, getWalletChainAddress, TRON_NETWORK_KEY, TVM_PROTOCOL } from './wallet';

const DEFAULT_TRON_RPC_URL = 'https://api.trongrid.io';
const TRON_NATIVE_DECIMALS = 6;
const DEFAULT_TRON_FEE_LIMIT_SUN = 30_000_000n;
const MIN_TRON_FEE_LIMIT_SUN = 5_000_000n;
const TRON_SIGNATURE_BYTES = 65n;

type TronUnsignedTransaction = {
  visible?: boolean;
  txID?: string;
  raw_data?: Record<string, unknown>;
  raw_data_hex?: string;
  fee_limit?: number;
  signature?: string[];
};

type TronAccountResponse = {
  address?: string;
  balance?: number | string | null;
};

type TronAccountResourceResponse = {
  freeNetLimit?: number | string | null;
  freeNetUsed?: number | string | null;
  NetLimit?: number | string | null;
  NetUsed?: number | string | null;
  EnergyLimit?: number | string | null;
  EnergyUsed?: number | string | null;
};

type TronChainParametersResponse = {
  chainParameter?: Array<{
    key?: string;
    value?: number | string | null;
  }>;
};

type TronTriggerConstantResponse = {
  result?: {
    result?: boolean;
    code?: string;
    message?: string;
  };
  constant_result?: string[];
  energy_used?: number | string | null;
};

type TronTriggerSmartContractResponse = {
  result?: {
    result?: boolean;
    code?: string;
    message?: string;
  };
  transaction?: TronUnsignedTransaction;
};

type TronBroadcastResponse = {
  result?: boolean;
  txid?: string;
  code?: string;
  message?: string;
};

type TronTransactionInfoResponse = {
  id?: string;
  blockNumber?: number | string | null;
  receipt?: {
    result?: string | null;
  };
  result?: string | null;
};

type TronTransactionResponse = {
  txID?: string;
  ret?: Array<{
    contractRet?: string | null;
  }>;
};

type PreparedTronTransaction = {
  transaction: TronUnsignedTransaction;
  estimatedFeeSun: bigint;
  estimatedBandwidthFeeSun: bigint;
  estimatedEnergyFeeSun: bigint;
  estimatedEnergyUsage: bigint;
  estimatedTxBytes: bigint;
  amountRaw: bigint;
  amountInput: string;
  tokenAddress: string | null;
  tokenDecimals: number;
  tokenSymbol: string | null;
  fromAddress: string;
  toAddress: string;
};

export type PreparedTronTransfer = {
  mode: 'tron';
  env: Bindings;
  transaction: TronUnsignedTransaction;
  quote: TransferQuoteResponse;
};

function getTronRpcUrl(env: Bindings): string {
  const raw = env.TRON_RPC_URL?.trim();
  if (!raw) return DEFAULT_TRON_RPC_URL;
  return raw.replace(/\/+$/, '');
}

function normalizeFiniteNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function getTronHeaders(env: Bindings): Headers {
  const headers = new Headers({
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });
  const apiKey = env.TRON_PRO_API_KEY?.trim();
  if (apiKey) {
    headers.set('TRON-PRO-API-KEY', apiKey);
  }
  return headers;
}

async function postTronJson<T>(
  env: Bindings,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${getTronRpcUrl(env)}${path}`, {
    method: 'POST',
    headers: getTronHeaders(env),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`tron_rpc_${response.status}`);
  }
  return (await response.json()) as T;
}

function parseTronAmount(amount: string, decimals: number): bigint {
  const normalized = amount.trim();
  if (!normalized) throw new Error('invalid_amount');
  const raw = parseUnits(normalized, decimals);
  if (raw <= 0n) throw new Error('invalid_amount');
  return raw;
}

function formatTronAmount(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}

function parseConstantResultHex(response: TronTriggerConstantResponse): bigint {
  const success = response.result?.result ?? false;
  const value = response.constant_result?.[0]?.trim();
  if (!success || !value) {
    throw new Error(response.result?.message ?? response.result?.code ?? 'tron_constant_call_failed');
  }
  return BigInt(`0x${value}`);
}

function estimateSignedTxBytes(transaction: TronUnsignedTransaction): bigint {
  const rawDataHex = normalizeText(transaction.raw_data_hex);
  if (!rawDataHex) return 0n;
  return BigInt(rawDataHex.length / 2) + TRON_SIGNATURE_BYTES;
}

function readChainParameter(params: Map<string, bigint>, key: string, fallback: bigint): bigint {
  return params.get(key) ?? fallback;
}

async function getTronChainParameters(env: Bindings): Promise<Map<string, bigint>> {
  const response = await postTronJson<TronChainParametersResponse>(env, '/wallet/getchainparameters', {});
  const output = new Map<string, bigint>();
  for (const item of response.chainParameter ?? []) {
    const key = normalizeText(item.key);
    if (!key) continue;
    const value = normalizeFiniteNumber(item.value);
    if (value == null) continue;
    output.set(key, BigInt(Math.trunc(value)));
  }
  return output;
}

async function getTronAccount(env: Bindings, address: string): Promise<TronAccountResponse> {
  return postTronJson<TronAccountResponse>(env, '/wallet/getaccount', {
    address,
    visible: true,
  });
}

async function getTronAccountResources(env: Bindings, address: string): Promise<TronAccountResourceResponse> {
  return postTronJson<TronAccountResourceResponse>(env, '/wallet/getaccountresource', {
    address,
    visible: true,
  });
}

async function getTronNativeBalanceSun(env: Bindings, address: string): Promise<bigint> {
  const account = await getTronAccount(env, address);
  return BigInt(Math.trunc(normalizeFiniteNumber(account.balance) ?? 0));
}

function getAvailableBandwidth(resources: TronAccountResourceResponse): bigint {
  const freeLimit = BigInt(Math.trunc(normalizeFiniteNumber(resources.freeNetLimit) ?? 0));
  const freeUsed = BigInt(Math.trunc(normalizeFiniteNumber(resources.freeNetUsed) ?? 0));
  const netLimit = BigInt(Math.trunc(normalizeFiniteNumber(resources.NetLimit) ?? 0));
  const netUsed = BigInt(Math.trunc(normalizeFiniteNumber(resources.NetUsed) ?? 0));
  const freeAvailable = freeLimit > freeUsed ? freeLimit - freeUsed : 0n;
  const netAvailable = netLimit > netUsed ? netLimit - netUsed : 0n;
  return freeAvailable + netAvailable;
}

function getAvailableEnergy(resources: TronAccountResourceResponse): bigint {
  const energyLimit = BigInt(Math.trunc(normalizeFiniteNumber(resources.EnergyLimit) ?? 0));
  const energyUsed = BigInt(Math.trunc(normalizeFiniteNumber(resources.EnergyUsed) ?? 0));
  return energyLimit > energyUsed ? energyLimit - energyUsed : 0n;
}

function estimateBandwidthFeeSun(txBytes: bigint, availableBandwidth: bigint, unitFeeSun: bigint): bigint {
  const shortfall = txBytes > availableBandwidth ? txBytes - availableBandwidth : 0n;
  return shortfall * unitFeeSun;
}

function encodeTronAddressParam(address: string): string {
  return encodeAbiParameters(
    parseAbiParameters('address'),
    [tronAddressToEvmAddress(address)],
  ).slice(2);
}

function encodeTronTransferParams(toAddress: string, amountRaw: bigint): string {
  return encodeAbiParameters(
    parseAbiParameters('address,uint256'),
    [tronAddressToEvmAddress(toAddress), amountRaw],
  ).slice(2);
}

async function callTronConstantContract(
  env: Bindings,
  ownerAddress: string,
  contractAddress: string,
  functionSelector: string,
  parameter: string,
): Promise<TronTriggerConstantResponse> {
  return postTronJson<TronTriggerConstantResponse>(env, '/wallet/triggerconstantcontract', {
    owner_address: ownerAddress,
    contract_address: contractAddress,
    function_selector: functionSelector,
    parameter,
    visible: true,
  });
}

async function getTronTokenDecimals(env: Bindings, ownerAddress: string, contractAddress: string): Promise<number> {
  const response = await callTronConstantContract(env, ownerAddress, contractAddress, 'decimals()', '');
  const decimals = Number(parseConstantResultHex(response));
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) {
    throw new Error('invalid_token_decimals');
  }
  return decimals;
}

async function getTronTokenBalanceRaw(env: Bindings, ownerAddress: string, contractAddress: string): Promise<bigint> {
  const response = await callTronConstantContract(
    env,
    ownerAddress,
    contractAddress,
    'balanceOf(address)',
    encodeTronAddressParam(ownerAddress),
  );
  return parseConstantResultHex(response);
}

async function buildTronNativeTransferTransaction(
  env: Bindings,
  fromAddress: string,
  toAddress: string,
  amountRaw: bigint,
): Promise<TronUnsignedTransaction> {
  const response = await postTronJson<TronUnsignedTransaction>(env, '/wallet/createtransaction', {
    owner_address: fromAddress,
    to_address: toAddress,
    amount: Number(amountRaw),
    visible: true,
  });
  if (!normalizeText(response.raw_data_hex)) {
    throw new Error('tron_transaction_build_failed');
  }
  return response;
}

async function buildTronTokenTransferTransaction(
  env: Bindings,
  fromAddress: string,
  toAddress: string,
  tokenAddress: string,
  amountRaw: bigint,
  feeLimitSun: bigint,
): Promise<TronUnsignedTransaction> {
  const response = await postTronJson<TronTriggerSmartContractResponse>(env, '/wallet/triggersmartcontract', {
    owner_address: fromAddress,
    contract_address: tokenAddress,
    function_selector: 'transfer(address,uint256)',
    parameter: encodeTronTransferParams(toAddress, amountRaw),
    fee_limit: Number(feeLimitSun),
    call_value: 0,
    visible: true,
  });
  if (!(response.result?.result) || !response.transaction || !normalizeText(response.transaction.raw_data_hex)) {
    throw new Error(response.result?.message ?? response.result?.code ?? 'tron_transaction_build_failed');
  }
  return response.transaction;
}

function signTronTransaction(transaction: TronUnsignedTransaction, privateKeyHex: string): TronUnsignedTransaction {
  const rawDataHex = normalizeText(transaction.raw_data_hex);
  if (!rawDataHex) {
    throw new Error('tron_transaction_build_failed');
  }
  const txId = normalizeText(transaction.txID) ?? computeTronTransactionId(rawDataHex);
  const signature = signTronDigest(hexToBytes(txId), privateKeyHex);
  return {
    ...transaction,
    txID: txId,
    signature: [signature],
  };
}

async function getTokenTransferEnergyEstimate(
  env: Bindings,
  fromAddress: string,
  toAddress: string,
  tokenAddress: string,
  amountRaw: bigint,
): Promise<bigint> {
  const response = await callTronConstantContract(
    env,
    fromAddress,
    tokenAddress,
    'transfer(address,uint256)',
    encodeTronTransferParams(toAddress, amountRaw),
  );
  return BigInt(Math.trunc(normalizeFiniteNumber(response.energy_used) ?? 0));
}

async function prepareTronTransaction(
  env: Bindings,
  fromAddress: string,
  toAddress: string,
  amountRaw: bigint,
  tokenAddress: string | null,
): Promise<{
  transaction: TronUnsignedTransaction;
  estimatedBandwidthFeeSun: bigint;
  estimatedEnergyFeeSun: bigint;
  estimatedEnergyUsage: bigint;
  estimatedTxBytes: bigint;
  estimatedFeeSun: bigint;
}> {
  const [chainParameters, resources] = await Promise.all([
    getTronChainParameters(env),
    getTronAccountResources(env, fromAddress).catch(() => ({})),
  ]);
  const transactionFeeSun = readChainParameter(chainParameters, 'getTransactionFee', 1_000n);
  const energyFeeSun = readChainParameter(chainParameters, 'getEnergyFee', 100n);
  const availableBandwidth = getAvailableBandwidth(resources);
  const availableEnergy = getAvailableEnergy(resources);

  let estimatedEnergyUsage = 0n;
  let transaction: TronUnsignedTransaction;

  if (tokenAddress) {
    estimatedEnergyUsage = await getTokenTransferEnergyEstimate(env, fromAddress, toAddress, tokenAddress, amountRaw);
    const estimatedEnergyShortfall = estimatedEnergyUsage > availableEnergy ? estimatedEnergyUsage - availableEnergy : 0n;
    const estimatedEnergyFeeSun = estimatedEnergyShortfall * energyFeeSun;
    const provisionalFeeLimit = estimatedEnergyFeeSun > 0n
      ? estimatedEnergyFeeSun * 2n
      : DEFAULT_TRON_FEE_LIMIT_SUN;
    const feeLimitSun = provisionalFeeLimit > MIN_TRON_FEE_LIMIT_SUN ? provisionalFeeLimit : MIN_TRON_FEE_LIMIT_SUN;
    transaction = await buildTronTokenTransferTransaction(env, fromAddress, toAddress, tokenAddress, amountRaw, feeLimitSun);
  } else {
    transaction = await buildTronNativeTransferTransaction(env, fromAddress, toAddress, amountRaw);
  }

  const estimatedTxBytes = estimateSignedTxBytes(transaction);
  const estimatedBandwidthFeeSun = estimateBandwidthFeeSun(estimatedTxBytes, availableBandwidth, transactionFeeSun);
  const estimatedEnergyShortfall = estimatedEnergyUsage > availableEnergy ? estimatedEnergyUsage - availableEnergy : 0n;
  const estimatedEnergyFeeSun = estimatedEnergyShortfall * energyFeeSun;
  const estimatedFeeSun = estimatedBandwidthFeeSun + estimatedEnergyFeeSun;

  return {
    transaction,
    estimatedBandwidthFeeSun,
    estimatedEnergyFeeSun,
    estimatedEnergyUsage,
    estimatedTxBytes,
    estimatedFeeSun,
  };
}

export async function prepareTronTransfer(
  env: Bindings,
  userId: string,
  input: TransferQuoteRequest,
): Promise<PreparedTronTransfer> {
  const wallet = await ensureWalletWithPrivateKey(env, userId);
  const fromAddress = getWalletChainAddress(wallet, TRON_NETWORK_KEY, TVM_PROTOCOL);
  if (typeof fromAddress !== 'string' || !fromAddress.trim()) {
    throw new Error('wallet_not_found');
  }

  const encryptedPrivateKey = wallet.encryptedProtocolKeys[TVM_PROTOCOL] ?? wallet.encryptedPrivateKey;
  let privateKey: string;
  try {
    privateKey = await decryptString(encryptedPrivateKey, env.APP_SECRET);
  } catch {
    throw new Error('wallet_key_decryption_failed');
  }

  const toAddress = normalizeTronAddress(input.toAddress);
  if (!toAddress) {
    throw new Error('invalid_to_address');
  }

  const tokenAddress = input.tokenAddress?.trim() ? normalizeTronAddress(input.tokenAddress) : null;
  if (input.tokenAddress?.trim() && !tokenAddress) {
    throw new Error('invalid_token_address');
  }

  const tokenDecimals = tokenAddress
    ? (Number.isFinite(input.tokenDecimals) ? Number(input.tokenDecimals) : await getTronTokenDecimals(env, fromAddress.trim(), tokenAddress))
    : TRON_NATIVE_DECIMALS;
  const amountRaw = parseTronAmount(input.amount, tokenDecimals);
  const amountInput = formatTronAmount(amountRaw, tokenDecimals);

  const [nativeBalanceSun, tokenBalanceRaw] = await Promise.all([
    getTronNativeBalanceSun(env, fromAddress.trim()),
    tokenAddress ? getTronTokenBalanceRaw(env, fromAddress.trim(), tokenAddress) : Promise.resolve(0n),
  ]);

  if (!tokenAddress && nativeBalanceSun < amountRaw) {
    throw new Error('insufficient_native_balance');
  }
  if (tokenAddress && tokenBalanceRaw < amountRaw) {
    throw new Error('insufficient_token_balance');
  }

  const preparedTx = await prepareTronTransaction(env, fromAddress.trim(), toAddress, amountRaw, tokenAddress);
  if (!tokenAddress && nativeBalanceSun < amountRaw + preparedTx.estimatedFeeSun) {
    throw new Error('insufficient_native_balance');
  }
  if (tokenAddress && nativeBalanceSun < preparedTx.estimatedFeeSun) {
    throw new Error('insufficient_native_balance');
  }

  const signedTransaction = signTronTransaction(preparedTx.transaction, privateKey);

  return {
    mode: 'tron',
    env,
    transaction: signedTransaction,
    quote: {
      networkKey: TRON_NETWORK_KEY,
      chainId: null,
      fromAddress: fromAddress.trim(),
      toAddress,
      tokenAddress,
      tokenSymbol: input.tokenSymbol?.trim().toUpperCase() || (tokenAddress ? null : 'TRX'),
      tokenDecimals,
      amountInput,
      amountRaw: amountRaw.toString(),
      estimatedFeeWei: preparedTx.estimatedFeeSun.toString(),
      estimatedFeeTokenAmount: formatTronAmount(preparedTx.estimatedFeeSun, TRON_NATIVE_DECIMALS),
      estimatedFeeTokenWei: preparedTx.estimatedFeeSun.toString(),
      estimatedFeeTokenAddress: null,
      estimatedFeeTokenChainId: null,
      insufficientFeeTokenBalance: false,
      estimatedGas: {
        preVerificationGas: null,
        verificationGasLimit: preparedTx.estimatedEnergyUsage.toString(),
        callGasLimit: preparedTx.estimatedTxBytes.toString(),
        maxFeePerGas: preparedTx.estimatedEnergyFeeSun.toString(),
        maxPriorityFeePerGas: preparedTx.estimatedBandwidthFeeSun.toString(),
      },
    },
  };
}

export async function sendPreparedTronTransfer(prepared: PreparedTronTransfer): Promise<string> {
  const response = await postTronJson<TronBroadcastResponse>(prepared.env, '/wallet/broadcasttransaction', prepared.transaction);
  if (!response.result) {
    throw new Error(response.message ?? response.code ?? 'tron_transfer_submit_failed');
  }
  return normalizeText(response.txid) ?? normalizeText(prepared.transaction.txID) ?? 'unknown_tron_txid';
}

async function getConfirmedTronTransactionInfo(
  env: Bindings,
  txHash: string,
): Promise<TronTransactionInfoResponse> {
  return postTronJson<TronTransactionInfoResponse>(env, '/walletsolidity/gettransactioninfobyid', {
    value: txHash,
    visible: true,
  });
}

async function getTronTransactionById(
  env: Bindings,
  txHash: string,
): Promise<TronTransactionResponse> {
  return postTronJson<TronTransactionResponse>(env, '/wallet/gettransactionbyid', {
    value: txHash,
    visible: true,
  });
}

export async function refreshTronTransferStatusByHash(
  env: Bindings,
  txHash: string,
): Promise<'confirmed' | 'failed' | 'pending'> {
  const confirmed = await getConfirmedTronTransactionInfo(env, txHash).catch(() => null);
  const receiptResult = normalizeText(confirmed?.receipt?.result ?? confirmed?.result)?.toUpperCase();
  if (receiptResult === 'SUCCESS') return 'confirmed';
  if (receiptResult && receiptResult !== 'SUCCESS') return 'failed';

  const tx = await getTronTransactionById(env, txHash).catch(() => null);
  const contractResult = normalizeText(tx?.ret?.[0]?.contractRet)?.toUpperCase();
  if (contractResult && contractResult !== 'SUCCESS') return 'failed';
  if (normalizeText(tx?.txID)) return 'pending';
  return 'pending';
}

export async function waitForPreparedTronTransfer(
  prepared: PreparedTronTransfer,
  txHash: string,
): Promise<'confirmed' | 'failed' | 'pending'> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await refreshTronTransferStatusByHash(prepared.env, txHash);
    if (status !== 'pending') return status;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return 'pending';
}
