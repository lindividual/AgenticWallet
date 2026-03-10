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

type OpenAiChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';

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
  const provider = resolveLlmProvider(env);
  switch (provider) {
    case 'openai':
      return callOpenAiCompatible(env, input);
    default:
      throw new Error(`unsupported_llm_provider_${provider}`);
  }
}

export function getLlmStatus(env: Bindings): {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
} {
  const provider = resolveLlmProvider(env);
  const baseUrl = (env.LLM_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).trim();
  const model = (env.LLM_MODEL ?? DEFAULT_OPENAI_MODEL).trim();
  return {
    enabled: Boolean(env.LLM_API_KEY?.trim()),
    provider,
    model,
    baseUrl,
  };
}

export async function getLlmDebugStatus(env: Bindings): Promise<{
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  keyFingerprint: string | null;
}> {
  const status = getLlmStatus(env);
  return {
    ...status,
    keyFingerprint: await fingerprintApiKey(env.LLM_API_KEY),
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

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function backoffMs(attempt: number): number {
  // attempt starts from 1.
  return Math.min(1000 * 2 ** (attempt - 1), 15_000);
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

  const durationMatch = normalized.match(/^(\d+(?:\.\d+)?)(ms|s|m)$/);
  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    const unit = durationMatch[2];
    if (unit === 'ms') return Math.round(amount);
    if (unit === 's') return Math.round(amount * 1000);
    return Math.round(amount * 60_000);
  }

  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  return null;
}

function readRetryAfterMs(headers: Headers): number | undefined {
  const retryAfterMs = headers.get('retry-after-ms');
  if (retryAfterMs) {
    const parsed = Number(retryAfterMs.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.round(parsed), 15_000);
    }
  }

  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const asDelay = parseDurationMs(retryAfter);
    if (asDelay && asDelay > 0) {
      return Math.min(asDelay, 15_000);
    }

    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      const delay = dateMs - Date.now();
      if (delay > 0) {
        return Math.min(delay, 15_000);
      }
    }
  }

  for (const name of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
    const reset = headers.get(name);
    if (!reset) continue;
    const parsed = parseDurationMs(reset);
    if (parsed && parsed > 0) {
      return Math.min(parsed, 15_000);
    }
  }

  return undefined;
}

async function callOpenAiCompatible(env: Bindings, input: LlmGenerateInput): Promise<LlmGenerateOutput> {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('llm_api_key_not_configured');
  }

  const baseUrl = (env.LLM_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).trim();
  const model = (env.LLM_MODEL ?? DEFAULT_OPENAI_MODEL).trim();
  const keyFingerprint = await fingerprintApiKey(apiKey);
  const maxAttempts = Number.isFinite(input.retryAttempts)
    ? Math.min(Math.max(Math.trunc(input.retryAttempts ?? 3), 1), 6)
    : 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: input.messages,
          temperature: input.temperature ?? 0.3,
          max_tokens: input.maxTokens ?? 1200,
        }),
      });
    } catch (error) {
      const wrapped = new LlmRequestError('llm_network_error');
      wrapped.baseUrl = baseUrl;
      wrapped.model = model;
      wrapped.keyFingerprint = keyFingerprint;
      wrapped.causeMessage = error instanceof Error ? error.message : String(error);
      wrapped.attempt = attempt;
      wrapped.maxAttempts = maxAttempts;
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw wrapped;
    }

    if (!response.ok) {
      const body = await response.text();
      const requestId = response.headers.get('x-request-id') ?? response.headers.get('cf-ray');
      const retryAfterMs = readRetryAfterMs(response.headers);
      const wrapped = new LlmRequestError(`llm_request_failed_${response.status}`);
      wrapped.status = response.status;
      wrapped.baseUrl = baseUrl;
      wrapped.model = model;
      wrapped.keyFingerprint = keyFingerprint;
      wrapped.responseBodySnippet = body.slice(0, 1200);
      wrapped.attempt = attempt;
      wrapped.maxAttempts = maxAttempts;
      wrapped.retryAfterMs = retryAfterMs;
      applyResponseDebugHeaders(wrapped, response);
      wrapped.requestId = requestId;
      if (attempt < maxAttempts && isRetryableStatus(response.status)) {
        await sleep(retryAfterMs ?? backoffMs(attempt));
        continue;
      }
      throw wrapped;
    }

    const json = (await response.json()) as OpenAiChatResponse;
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new Error('llm_empty_response');
    }

    return {
      provider: 'openai',
      model,
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
