import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { base58 } from '@scure/base';

const TRON_BASE58_ADDRESS_REGEX = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error('invalid_hex');
  }
  const output = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    output[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return output;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function assertTronBase58Payload(decoded: Uint8Array): Uint8Array {
  if (decoded.length !== 25) {
    throw new Error('invalid_tron_address');
  }
  const payload = decoded.slice(0, 21);
  const checksum = decoded.slice(21);
  const expectedChecksum = sha256(sha256(payload)).slice(0, 4);
  if (!expectedChecksum.every((value, index) => checksum[index] === value)) {
    throw new Error('invalid_tron_address');
  }
  if (payload[0] !== 0x41) {
    throw new Error('invalid_tron_address');
  }
  return payload;
}

export function isTronAddress(raw: unknown): raw is string {
  return typeof raw === 'string' && TRON_BASE58_ADDRESS_REGEX.test(raw.trim());
}

export function normalizeTronAddress(raw: unknown): string | null {
  if (!isTronAddress(raw)) return null;
  return raw.trim();
}

export function tronAddressToHex41(address: string): string {
  const normalized = normalizeTronAddress(address);
  if (!normalized) {
    throw new Error('invalid_tron_address');
  }
  return bytesToHex(assertTronBase58Payload(base58.decode(normalized)));
}

export function tronAddressToEvmAddress(address: string): `0x${string}` {
  const hex41 = tronAddressToHex41(address);
  return `0x${hex41.slice(2)}` as `0x${string}`;
}

export function evmAddressToTronAddress(address: string): string {
  const normalized = address.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    throw new Error('invalid_evm_address');
  }

  const payload = hexToBytes(`41${normalized.slice(2)}`);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const output = new Uint8Array(payload.length + checksum.length);
  output.set(payload);
  output.set(checksum, payload.length);
  return base58.encode(output);
}

export function signTronDigest(digest: Uint8Array, privateKeyHex: string): string {
  const privateKeyBytes = hexToBytes(privateKeyHex.replace(/^0x/i, ''));
  const signature = secp256k1.sign(digest, privateKeyBytes);
  return `${signature.toCompactHex()}${signature.recovery.toString(16).padStart(2, '0')}`;
}

export function computeTronTransactionId(rawDataHex: string): string {
  return bytesToHex(sha256(hexToBytes(rawDataHex)));
}
