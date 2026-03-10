export function generatePrivateKeyHex(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `0x${hex}`;
}

export function generateRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function encryptString(plainText: string, secret: string): Promise<string> {
  const key = await deriveAesGcmKey(secret, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(plainText);

  const cipherBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);

  return `${toBase64(iv)}.${toBase64(new Uint8Array(cipherBuffer))}`;
}

export async function decryptString(encrypted: string, secret: string): Promise<string> {
  const [ivB64, cipherB64] = encrypted.split('.');
  if (!ivB64 || !cipherB64) {
    throw new Error('invalid_encrypted_payload');
  }

  const iv = fromBase64(ivB64);
  const ivBuffer = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
  const cipherBytes = fromBase64(cipherB64);
  const cipherBuffer = cipherBytes.buffer.slice(
    cipherBytes.byteOffset,
    cipherBytes.byteOffset + cipherBytes.byteLength,
  ) as ArrayBuffer;
  const key = await deriveAesGcmKey(secret, ['decrypt']);
  const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuffer }, key, cipherBuffer);
  return new TextDecoder().decode(plainBuffer);
}

async function deriveAesGcmKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const secretBytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest('SHA-256', secretBytes);

  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, usages);
}

function toBase64(input: Uint8Array): string {
  let str = '';
  for (const b of input) {
    str += String.fromCharCode(b);
  }
  return btoa(str);
}

function fromBase64(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encodeBase64(input: Uint8Array): string {
  return toBase64(input);
}

export function decodeBase64(input: string): Uint8Array {
  return fromBase64(input);
}
