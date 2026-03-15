export type LlmSuccessDebugFields = {
  requestId?: string | null;
  cfRay?: string | null;
  server?: string | null;
  openaiProject?: string | null;
  openaiOrganization?: string | null;
  rateLimitLimitRequests?: string | null;
  rateLimitLimitTokens?: string | null;
  rateLimitRemainingRequests?: string | null;
  rateLimitRemainingTokens?: string | null;
  rateLimitResetRequests?: string | null;
  rateLimitResetTokens?: string | null;
};

export class LlmRequestError extends Error {
  status?: number;
  requestId?: string | null;
  cfRay?: string | null;
  server?: string | null;
  openaiProject?: string | null;
  openaiOrganization?: string | null;
  rateLimitLimitRequests?: string | null;
  rateLimitLimitTokens?: string | null;
  rateLimitRemainingRequests?: string | null;
  rateLimitRemainingTokens?: string | null;
  rateLimitResetRequests?: string | null;
  rateLimitResetTokens?: string | null;
  baseUrl?: string;
  model?: string;
  keyFingerprint?: string | null;
  responseBodySnippet?: string;
  causeMessage?: string;
  attempt?: number;
  maxAttempts?: number;
  retryAfterMs?: number;
}

export function applyResponseDebugHeaders(target: LlmSuccessDebugFields, response: Response): void {
  target.requestId = response.headers.get('x-request-id');
  target.cfRay = response.headers.get('cf-ray');
  target.server = response.headers.get('server');
  target.openaiProject = response.headers.get('openai-project');
  target.openaiOrganization = response.headers.get('openai-organization');
  target.rateLimitLimitRequests = response.headers.get('x-ratelimit-limit-requests');
  target.rateLimitLimitTokens = response.headers.get('x-ratelimit-limit-tokens');
  target.rateLimitRemainingRequests = response.headers.get('x-ratelimit-remaining-requests');
  target.rateLimitRemainingTokens = response.headers.get('x-ratelimit-remaining-tokens');
  target.rateLimitResetRequests = response.headers.get('x-ratelimit-reset-requests');
  target.rateLimitResetTokens = response.headers.get('x-ratelimit-reset-tokens');
}

export function collectSuccessDebugFields(response: Response): LlmSuccessDebugFields {
  const output: LlmSuccessDebugFields = {};
  applyResponseDebugHeaders(output, response);
  return output;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function normalizeMaxRetryDelayMs(value: number | undefined): number {
  const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
  const ABSOLUTE_MAX_RETRY_DELAY_MS = 120_000;
  if (!Number.isFinite(value)) return DEFAULT_MAX_RETRY_DELAY_MS;
  const rounded = Math.round(value ?? DEFAULT_MAX_RETRY_DELAY_MS);
  return Math.max(1_000, Math.min(rounded, ABSOLUTE_MAX_RETRY_DELAY_MS));
}

export function normalizeMaxOutputTokens(value: number | undefined): number {
  const minTokens = 16;
  if (!Number.isFinite(value)) return 1200;
  return Math.max(Math.round(value ?? 1200), minTokens);
}

export function applyJitter(delayMs: number, minFactor: number, maxFactor: number, maxDelayMs: number): number {
  const factor = minFactor + Math.random() * Math.max(maxFactor - minFactor, 0);
  return Math.max(250, Math.min(Math.round(delayMs * factor), maxDelayMs));
}

export function backoffMs(attempt: number, maxDelayMs: number): number {
  const baseDelayMs = Math.min(1500 * 2 ** (attempt - 1), maxDelayMs);
  return applyJitter(baseDelayMs, 0.75, 1.5, maxDelayMs);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseDurationMs(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  if (/^(\d+(?:\.\d+)?(ms|h|m|s))+$/.test(normalized)) {
    let totalMs = 0;
    const matches = normalized.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g);
    for (const match of matches) {
      const amount = Number(match[1]);
      if (!Number.isFinite(amount) || amount < 0) return null;
      const unit = match[2];
      if (unit === 'ms') totalMs += amount;
      else if (unit === 's') totalMs += amount * 1000;
      else if (unit === 'm') totalMs += amount * 60_000;
      else totalMs += amount * 3_600_000;
    }
    return Math.round(totalMs);
  }

  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  return null;
}

export function readRetryAfterMs(headers: Headers, maxDelayMs: number): number | undefined {
  const retryAfterMs = headers.get('retry-after-ms');
  if (retryAfterMs) {
    const parsed = Number(retryAfterMs.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.round(parsed), maxDelayMs);
    }
  }

  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const asDelay = parseDurationMs(retryAfter);
    if (asDelay && asDelay > 0) {
      return Math.min(asDelay, maxDelayMs);
    }

    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      const delay = dateMs - Date.now();
      if (delay > 0) {
        return Math.min(delay, maxDelayMs);
      }
    }
  }

  for (const name of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
    const reset = headers.get(name);
    if (!reset) continue;
    const parsed = parseDurationMs(reset);
    if (parsed && parsed > 0) {
      return Math.min(parsed, maxDelayMs);
    }
  }

  return undefined;
}

export function resolveRetryDelayMs(attempt: number, headers: Headers | null, maxDelayMs: number): number {
  const hintedDelayMs = headers ? readRetryAfterMs(headers, maxDelayMs) : undefined;
  if (hintedDelayMs && hintedDelayMs > 0) {
    return applyJitter(hintedDelayMs, 1, 1.15, maxDelayMs);
  }
  return backoffMs(attempt, maxDelayMs);
}

export async function fingerprintApiKey(apiKey: string | undefined): Promise<string | null> {
  const normalized = apiKey?.trim();
  if (!normalized) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .slice(0, 6)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
