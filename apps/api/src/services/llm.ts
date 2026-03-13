import type { Bindings } from '../types';

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlmGenerateInput = {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  retryAttempts?: number;
  maxRetryDelayMs?: number;
};

export type LlmGenerateOutput = {
  provider: string;
  model: string;
  text: string;
  keyFingerprint?: string | null;
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

export type LlmErrorInfo = {
  message: string;
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
};

type OpenAiResponsesResponse = {
  model?: string;
  output_text?: string;
  output?: Array<{
    type?: string;
    text?: string | { value?: string | null } | null;
    content?: Array<{
      type?: string;
      text?: string | { value?: string | null } | null;
    }>;
  }>;
  error?: {
    message?: string;
  } | null;
  incomplete_details?: {
    reason?: string;
  } | null;
};

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const CLOUDFLARE_AI_GATEWAY_HOST = 'gateway.ai.cloudflare.com';
const CLOUDFLARE_AI_GATEWAY_BASE_URL = `https://${CLOUDFLARE_AI_GATEWAY_HOST}/v1`;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const ABSOLUTE_MAX_RETRY_DELAY_MS = 120_000;

type ResolvedLlmConfig = {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  gatewayToken: string | null;
  usingGateway: boolean;
  usingGatewayCompat: boolean;
};

class LlmRequestError extends Error {
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

type LlmDebugFields = {
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

export async function generateWithLlm(env: Bindings, input: LlmGenerateInput): Promise<LlmGenerateOutput> {
  const config = resolveLlmConfig(env);
  switch (config.provider) {
    case 'openai':
      return callOpenAiCompatible(config, input);
    default:
      throw new Error(`unsupported_llm_provider_${config.provider}`);
  }
}

export function getLlmStatus(env: Bindings): {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
} {
  const config = resolveLlmConfig(env);
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
  };
}

export async function getLlmDebugStatus(env: Bindings): Promise<{
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  keyFingerprint: string | null;
}> {
  const config = resolveLlmConfig(env);
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    keyFingerprint: await fingerprintApiKey(resolveAuthorizationToken(config) ?? undefined),
  };
}

export function getLlmErrorInfo(error: unknown): LlmErrorInfo {
  if (error instanceof LlmRequestError) {
    return {
      message: error.message,
      status: error.status,
      requestId: error.requestId,
      cfRay: error.cfRay,
      server: error.server,
      openaiProject: error.openaiProject,
      openaiOrganization: error.openaiOrganization,
      rateLimitLimitRequests: error.rateLimitLimitRequests,
      rateLimitLimitTokens: error.rateLimitLimitTokens,
      rateLimitRemainingRequests: error.rateLimitRemainingRequests,
      rateLimitRemainingTokens: error.rateLimitRemainingTokens,
      rateLimitResetRequests: error.rateLimitResetRequests,
      rateLimitResetTokens: error.rateLimitResetTokens,
      baseUrl: error.baseUrl,
      model: error.model,
      keyFingerprint: error.keyFingerprint,
      responseBodySnippet: error.responseBodySnippet,
      causeMessage: error.causeMessage,
      attempt: error.attempt,
      maxAttempts: error.maxAttempts,
      retryAfterMs: error.retryAfterMs,
    };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}

function resolveLlmProvider(env: Bindings): string {
  return (env.LLM_PROVIDER ?? 'openai').trim().toLowerCase();
}

function trimEnvValue(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function isCloudflareAiGatewayUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === CLOUDFLARE_AI_GATEWAY_HOST;
  } catch {
    return false;
  }
}

function isCloudflareAiGatewayCompatUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === CLOUDFLARE_AI_GATEWAY_HOST && url.pathname.replace(/\/+$/, '').endsWith('/compat');
  } catch {
    return false;
  }
}

function buildCloudflareAiGatewayBaseUrl(accountId: string, gatewayId: string, provider: string): string {
  return `${CLOUDFLARE_AI_GATEWAY_BASE_URL}/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/${provider}`;
}

function resolveLlmConfig(env: Bindings): ResolvedLlmConfig {
  const provider = resolveLlmProvider(env);
  const explicitBaseUrl = trimEnvValue(env.LLM_BASE_URL);
  const gatewayAccountId = trimEnvValue(env.CF_AI_GATEWAY_ACCOUNT_ID);
  const gatewayId = trimEnvValue(env.CF_AI_GATEWAY_GATEWAY_ID);
  const gatewayToken = trimEnvValue(env.CF_AI_GATEWAY_TOKEN) ?? trimEnvValue(env.CF_AIG_TOKEN);
  const apiKey = trimEnvValue(env.LLM_API_KEY);
  const gatewayBaseUrl =
    gatewayAccountId && gatewayId ? buildCloudflareAiGatewayBaseUrl(gatewayAccountId, gatewayId, provider) : null;
  const explicitBaseUrlIsDefaultOpenAi =
    explicitBaseUrl !== null && normalizeBaseUrl(explicitBaseUrl) === DEFAULT_OPENAI_BASE_URL;
  const baseUrl = normalizeBaseUrl(
    gatewayBaseUrl && (explicitBaseUrl === null || explicitBaseUrlIsDefaultOpenAi)
      ? gatewayBaseUrl
      : explicitBaseUrl ?? gatewayBaseUrl ?? DEFAULT_OPENAI_BASE_URL,
  );
  const model = resolveLlmModel(provider, baseUrl, trimEnvValue(env.LLM_MODEL) ?? DEFAULT_OPENAI_MODEL);
  const usingGateway = isCloudflareAiGatewayUrl(baseUrl);
  const usingGatewayCompat = isCloudflareAiGatewayCompatUrl(baseUrl);
  const authorizationToken = resolveAuthorizationToken({
    apiKey,
    gatewayToken,
    usingGatewayCompat,
  });
  return {
    enabled: Boolean(authorizationToken || usingGateway),
    provider,
    baseUrl,
    model,
    apiKey,
    gatewayToken,
    usingGateway,
    usingGatewayCompat,
  };
}

function resolveLlmModel(provider: string, baseUrl: string, model: string): string {
  if (!isCloudflareAiGatewayCompatUrl(baseUrl) || model.includes('/')) {
    return model;
  }
  return `${provider}/${model}`;
}

function resolveAuthorizationToken(config: Pick<ResolvedLlmConfig, 'apiKey' | 'gatewayToken' | 'usingGatewayCompat'>): string | null {
  if (config.usingGatewayCompat) {
    return config.gatewayToken ?? config.apiKey;
  }
  return config.apiKey;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function normalizeMaxRetryDelayMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_RETRY_DELAY_MS;
  const rounded = Math.round(value ?? DEFAULT_MAX_RETRY_DELAY_MS);
  return Math.max(1_000, Math.min(rounded, ABSOLUTE_MAX_RETRY_DELAY_MS));
}

function applyJitter(delayMs: number, minFactor: number, maxFactor: number, maxDelayMs: number): number {
  const factor = minFactor + Math.random() * Math.max(maxFactor - minFactor, 0);
  return Math.max(250, Math.min(Math.round(delayMs * factor), maxDelayMs));
}

function backoffMs(attempt: number, maxDelayMs: number): number {
  // attempt starts from 1.
  const baseDelayMs = Math.min(1500 * 2 ** (attempt - 1), maxDelayMs);
  return applyJitter(baseDelayMs, 0.75, 1.5, maxDelayMs);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fingerprintApiKey(apiKey: string | undefined): Promise<string | null> {
  const normalized = apiKey?.trim();
  if (!normalized) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .slice(0, 6)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function applyResponseDebugHeaders(target: LlmDebugFields, response: Response): void {
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

function parseDurationMs(value: string): number | null {
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

function readRetryAfterMs(headers: Headers, maxDelayMs: number): number | undefined {
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

function resolveRetryDelayMs(attempt: number, headers: Headers | null, maxDelayMs: number): number {
  const hintedDelayMs = headers ? readRetryAfterMs(headers, maxDelayMs) : undefined;
  if (hintedDelayMs && hintedDelayMs > 0) {
    return applyJitter(hintedDelayMs, 1, 1.15, maxDelayMs);
  }
  return backoffMs(attempt, maxDelayMs);
}

function extractResponseTextValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (value && typeof value === 'object') {
    const nested = (value as { value?: unknown }).value;
    if (typeof nested === 'string') {
      const trimmed = nested.trim();
      return trimmed ? trimmed : null;
    }
  }
  return null;
}

function extractResponsesText(response: OpenAiResponsesResponse): string {
  const chunks: string[] = [];
  const topLevelText = extractResponseTextValue(response.output_text);
  if (topLevelText) chunks.push(topLevelText);

  for (const item of response.output ?? []) {
    const itemText = extractResponseTextValue(item.text);
    if (itemText) chunks.push(itemText);
    for (const content of item.content ?? []) {
      if (content.type && content.type !== 'output_text' && content.type !== 'text') continue;
      const contentText = extractResponseTextValue(content.text);
      if (contentText) chunks.push(contentText);
    }
  }

  return chunks.join('\n').trim();
}

async function callOpenAiCompatible(config: ResolvedLlmConfig, input: LlmGenerateInput): Promise<LlmGenerateOutput> {
  if (!config.enabled) {
    throw new Error('llm_not_configured');
  }

  const authorizationToken = resolveAuthorizationToken(config);
  const keyFingerprint = await fingerprintApiKey(authorizationToken ?? undefined);
  const maxRetryDelayMs = normalizeMaxRetryDelayMs(input.maxRetryDelayMs);
  const maxAttempts = Number.isFinite(input.retryAttempts)
    ? Math.min(Math.max(Math.trunc(input.retryAttempts ?? 3), 1), 6)
    : 3;
  const endpoint = new URL('responses', `${config.baseUrl}/`).toString();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (authorizationToken) {
    headers.authorization = `Bearer ${authorizationToken}`;
  }
  if (config.usingGateway && !config.usingGatewayCompat && config.gatewayToken) {
    headers['cf-aig-authorization'] = `Bearer ${config.gatewayToken}`;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          input: input.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          temperature: input.temperature ?? 0.3,
          max_output_tokens: input.maxTokens ?? 1200,
          store: false,
        }),
      });
    } catch (error) {
      const wrapped = new LlmRequestError('llm_network_error');
      wrapped.baseUrl = config.baseUrl;
      wrapped.model = config.model;
      wrapped.keyFingerprint = keyFingerprint;
      wrapped.causeMessage = error instanceof Error ? error.message : String(error);
      wrapped.attempt = attempt;
      wrapped.maxAttempts = maxAttempts;
      if (attempt < maxAttempts) {
        await sleep(resolveRetryDelayMs(attempt, null, maxRetryDelayMs));
        continue;
      }
      throw wrapped;
    }

    if (!response.ok) {
      const body = await response.text();
      const requestId = response.headers.get('x-request-id') ?? response.headers.get('cf-ray');
      const retryAfterMs = readRetryAfterMs(response.headers, maxRetryDelayMs);
      const wrapped = new LlmRequestError(`llm_request_failed_${response.status}`);
      wrapped.status = response.status;
      wrapped.baseUrl = config.baseUrl;
      wrapped.model = config.model;
      wrapped.keyFingerprint = keyFingerprint;
      wrapped.responseBodySnippet = body.slice(0, 1200);
      wrapped.attempt = attempt;
      wrapped.maxAttempts = maxAttempts;
      wrapped.retryAfterMs = retryAfterMs;
      applyResponseDebugHeaders(wrapped, response);
      wrapped.requestId = requestId;
      if (attempt < maxAttempts && isRetryableStatus(response.status)) {
        await sleep(resolveRetryDelayMs(attempt, response.headers, maxRetryDelayMs));
        continue;
      }
      throw wrapped;
    }

    const json = (await response.json()) as OpenAiResponsesResponse;
    const text = extractResponsesText(json);
    if (!text) {
      const incompleteReason = json.incomplete_details?.reason?.trim();
      const errorMessage = json.error?.message?.trim();
      throw new Error(
        ['llm_empty_response', incompleteReason ? `reason=${incompleteReason}` : null, errorMessage ? `error=${errorMessage}` : null]
          .filter((part): part is string => Boolean(part))
          .join(':'),
      );
    }

    return {
      provider: 'openai',
      model: typeof json.model === 'string' && json.model.trim() ? json.model : config.model,
      text,
      keyFingerprint,
      ...collectSuccessDebugFields(response),
    };
  }

  throw new Error('llm_retry_exhausted');
}

function collectSuccessDebugFields(response: Response): Omit<LlmGenerateOutput, 'provider' | 'model' | 'text'> {
  const output: Omit<LlmGenerateOutput, 'provider' | 'model' | 'text'> = {};
  applyResponseDebugHeaders(output, response);
  return output;
}
