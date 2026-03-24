import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import { decryptString } from '../utils/crypto';
import type { Bindings, TransferQuoteRequest, TransferQuoteResponse } from '../types';
import { BITCOIN_NETWORK_KEY, BTC_PROTOCOL, ensureWalletWithPrivateKey, getWalletChainAddress } from './wallet';

const BITCOIN_MEMPOOL_API_BASE_URL = 'https://mempool.space/api';
const DEFAULT_BITCOIN_FEE_RATE_SATS_VB = 5n;
const BITCOIN_DECIMALS = 8;
const BITCOIN_SYMBOL = 'BTC';

type BitcoinFeeRecommendationResponse = {
  fastestFee?: number;
  halfHourFee?: number;
  hourFee?: number;
  economyFee?: number;
  minimumFee?: number;
};

type BitcoinUtxoResponse = Array<{
  txid?: string;
  vout?: number;
  value?: number;
  status?: {
    confirmed?: boolean;
  };
}>;

type BitcoinTxStatusResponse = {
  confirmed?: boolean;
};

export type PreparedBitcoinTransfer = {
  mode: 'btc';
  quote: TransferQuoteResponse;
  txHex: string;
  txId: string;
};

function trimTrailingZeroes(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/\.?0+$/, '');
}

function formatBitcoinAmount(raw: bigint): string {
  const whole = raw / 100_000_000n;
  const fraction = raw % 100_000_000n;
  if (fraction === 0n) return whole.toString();
  return trimTrailingZeroes(`${whole.toString()}.${fraction.toString().padStart(BITCOIN_DECIMALS, '0')}`);
}

function parseBitcoinAmount(amount: string): bigint {
  const normalized = amount.trim();
  if (!normalized) {
    throw new Error('invalid_amount');
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error('invalid_amount');
  }
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > BITCOIN_DECIMALS) {
    throw new Error('invalid_amount');
  }
  const value = BigInt(whole) * 100_000_000n + BigInt((fraction + '0'.repeat(BITCOIN_DECIMALS)).slice(0, BITCOIN_DECIMALS));
  if (value <= 0n) {
    throw new Error('invalid_amount');
  }
  return value;
}

function getMempoolApiBaseUrl(): string {
  return BITCOIN_MEMPOOL_API_BASE_URL;
}

function validateBitcoinAddress(address: string): string {
  const trimmed = address.trim();
  const normalized = trimmed.toLowerCase().startsWith('bc1') ? trimmed.toLowerCase() : trimmed;
  if (!normalized) {
    throw new Error('invalid_to_address');
  }
  try {
    btc.Address(btc.NETWORK).decode(normalized);
    return normalized;
  } catch {
    throw new Error('invalid_to_address');
  }
}

async function fetchRecommendedFeeRate(): Promise<bigint> {
  try {
    const response = await fetch(`${getMempoolApiBaseUrl()}/v1/fees/recommended`);
    if (!response.ok) return DEFAULT_BITCOIN_FEE_RATE_SATS_VB;
    const data = (await response.json()) as BitcoinFeeRecommendationResponse;
    const candidates = [
      data.halfHourFee,
      data.hourFee,
      data.economyFee,
      data.minimumFee,
      data.fastestFee,
    ]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (candidates.length === 0) return DEFAULT_BITCOIN_FEE_RATE_SATS_VB;
    return BigInt(Math.max(1, Math.ceil(candidates[0] ?? Number(DEFAULT_BITCOIN_FEE_RATE_SATS_VB))));
  } catch {
    return DEFAULT_BITCOIN_FEE_RATE_SATS_VB;
  }
}

async function fetchBitcoinUtxos(address: string): Promise<BitcoinUtxoResponse> {
  const response = await fetch(`${getMempoolApiBaseUrl()}/address/${encodeURIComponent(address)}/utxo`);
  if (!response.ok) {
    throw new Error('failed_to_fetch_bitcoin_utxos');
  }
  const data = (await response.json()) as BitcoinUtxoResponse;
  return Array.isArray(data) ? data : [];
}

export async function prepareBitcoinTransfer(
  env: Bindings,
  userId: string,
  input: TransferQuoteRequest,
): Promise<PreparedBitcoinTransfer> {
  if (input.tokenAddress?.trim()) {
    throw new Error('unsupported_bitcoin_token_transfer');
  }

  const wallet = await ensureWalletWithPrivateKey(env, userId);
  const fromAddress = getWalletChainAddress(wallet, BITCOIN_NETWORK_KEY, BTC_PROTOCOL);
  if (typeof fromAddress !== 'string' || !fromAddress.trim()) {
    throw new Error('wallet_not_found');
  }

  const encryptedPrivateKey = wallet.encryptedProtocolKeys[BTC_PROTOCOL] ?? wallet.encryptedPrivateKey;
  let privateKey: string;
  try {
    privateKey = await decryptString(encryptedPrivateKey, env.APP_SECRET);
  } catch {
    throw new Error('wallet_key_decryption_failed');
  }

  const privateKeyBytes = hex.decode(privateKey.replace(/^0x/i, ''));
  const derivedAddress = btc.getAddress('wpkh', privateKeyBytes, btc.NETWORK)?.toLowerCase();
  if (!derivedAddress || derivedAddress !== fromAddress.trim().toLowerCase()) {
    throw new Error('wallet_key_mismatch');
  }

  const toAddress = validateBitcoinAddress(input.toAddress);
  const amountRaw = parseBitcoinAmount(input.amount);
  const spend = btc.p2wpkh(secp256k1.getPublicKey(privateKeyBytes, true), btc.NETWORK);
  const utxos = await fetchBitcoinUtxos(fromAddress.trim());
  const feePerByte = await fetchRecommendedFeeRate();
  const selected = btc.selectUTXO(
    utxos
      .filter((item) => typeof item.txid === 'string' && Number.isFinite(item.vout) && Number.isFinite(item.value) && Number(item.value) > 0)
      .map((item) => ({
        ...spend,
        txid: item.txid as string,
        index: Number(item.vout),
        witnessUtxo: {
          script: spend.script,
          amount: BigInt(Number(item.value)),
        },
      })),
    [{ address: toAddress, amount: amountRaw }],
    'default',
    {
      feePerByte,
      changeAddress: fromAddress.trim(),
      createTx: true,
      network: btc.NETWORK,
    },
  );
  if (!selected?.tx) {
    throw new Error('insufficient_native_balance');
  }

  selected.tx.sign(privateKeyBytes);
  selected.tx.finalize();
  const feeSats = selected.tx.fee;

  return {
    mode: 'btc',
    quote: {
      networkKey: BITCOIN_NETWORK_KEY,
      chainId: null,
      fromAddress: fromAddress.trim(),
      toAddress,
      tokenAddress: null,
      tokenSymbol: BITCOIN_SYMBOL,
      tokenDecimals: BITCOIN_DECIMALS,
      amountInput: input.amount.trim(),
      amountRaw: amountRaw.toString(),
      estimatedFeeWei: feeSats.toString(),
      estimatedFeeTokenAmount: formatBitcoinAmount(feeSats),
      estimatedFeeTokenWei: feeSats.toString(),
      estimatedFeeTokenAddress: null,
      estimatedFeeTokenChainId: null,
      estimatedFeeTokenSymbol: BITCOIN_SYMBOL,
      estimatedFeeTokenDecimals: BITCOIN_DECIMALS,
      insufficientFeeTokenBalance: false,
      estimatedGas: {
        preVerificationGas: null,
        verificationGasLimit: null,
        callGasLimit: null,
        maxFeePerGas: feePerByte.toString(),
        maxPriorityFeePerGas: null,
      },
    },
    txHex: selected.tx.hex,
    txId: selected.tx.id,
  };
}

export async function sendPreparedBitcoinTransfer(prepared: PreparedBitcoinTransfer): Promise<string> {
  const response = await fetch(`${getMempoolApiBaseUrl()}/tx`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
    },
    body: prepared.txHex,
  });
  const responseText = (await response.text()).trim();
  if (!response.ok) {
    throw new Error(responseText || 'bitcoin_transfer_submit_failed');
  }
  return responseText || prepared.txId;
}

async function getBitcoinTxStatus(txHash: string): Promise<'confirmed' | 'failed' | 'pending'> {
  const response = await fetch(`${getMempoolApiBaseUrl()}/tx/${encodeURIComponent(txHash)}/status`);
  if (response.status === 404) return 'failed';
  if (!response.ok) return 'pending';
  const data = (await response.json()) as BitcoinTxStatusResponse;
  return data.confirmed ? 'confirmed' : 'pending';
}

export async function waitForPreparedBitcoinTransfer(
  txHash: string,
): Promise<'confirmed' | 'failed' | 'pending'> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = await getBitcoinTxStatus(txHash);
    if (status !== 'pending') return status;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return 'pending';
}

export async function refreshBitcoinTransferStatusByHash(txHash: string): Promise<'confirmed' | 'failed' | 'pending'> {
  return getBitcoinTxStatus(txHash);
}
