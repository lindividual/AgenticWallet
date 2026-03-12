import { secp256k1 } from '@noble/curves/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha2';
import { bech32 } from '@scure/base';

export function privateKeyToBitcoinSegwitAddress(privateKey: `0x${string}`): string {
  const publicKey = secp256k1.getPublicKey(privateKey.slice(2), true);
  const witnessProgram = ripemd160(sha256(publicKey));
  const words = bech32.toWords(witnessProgram);
  return bech32.encode('bc', [0, ...words]);
}
