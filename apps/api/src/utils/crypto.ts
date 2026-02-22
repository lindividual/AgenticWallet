export function generatePrivateKeyHex(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `0x${hex}`;
}

export async function encryptString(plainText: string, secret: string): Promise<string> {
  const key = await deriveAesGcmKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(plainText);

  const cipherBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);

  return `${toBase64(iv)}.${toBase64(new Uint8Array(cipherBuffer))}`;
}

async function deriveAesGcmKey(secret: string): Promise<CryptoKey> {
  const secretBytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest('SHA-256', secretBytes);

  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
}

function toBase64(input: Uint8Array): string {
  let str = '';
  for (const b of input) {
    str += String.fromCharCode(b);
  }
  return btoa(str);
}
