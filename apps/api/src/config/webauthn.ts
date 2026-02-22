import type { Bindings, WebAuthnConfig } from '../types';

export function getWebAuthnConfig(env: Bindings, requestUrl: string): WebAuthnConfig {
  const request = new URL(requestUrl);
  const origin = request.origin;
  const rpId = request.hostname;
  const rpName = env.WEBAUTHN_RP_NAME?.trim() || 'Agentic Wallet MVP';
  const requireUserVerification = env.WEBAUTHN_REQUIRE_UV?.trim() === 'true';

  if (!origin || !rpId || !rpName) {
    throw new Error('invalid_webauthn_config');
  }

  return { origin, rpId, rpName, requireUserVerification };
}

export function sanitizeDisplayName(displayName?: string): string | null {
  if (!displayName) return null;
  const trimmed = displayName.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 64);
}
