import type { ResolvedLlmConfig, LlmGenerateInput, LlmGenerateOutput } from '../llm';
import {
  LlmRequestError,
  collectSuccessDebugFields,
  isRetryableStatus,
  normalizeMaxOutputTokens,
  normalizeMaxRetryDelayMs,
  readRetryAfterMs,
  resolveRetryDelayMs,
  sleep,
  applyResponseDebugHeaders,
  fingerprintApiKey,
} from './shared';

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

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';

export function resolveOpenAiAuthorizationToken(
  config: Pick<ResolvedLlmConfig, 'apiKey' | 'gatewayToken' | 'usingGatewayCompat'>,
): string | null {
  if (config.usingGatewayCompat) {
    return config.gatewayToken ?? config.apiKey;
  }
  return config.apiKey;
}

export function isOpenAiConfigEnabled(config: Pick<ResolvedLlmConfig, 'apiKey' | 'gatewayToken' | 'usingGateway' | 'usingGatewayCompat'>): boolean {
  return Boolean(
    resolveOpenAiAuthorizationToken(config) || (config.usingGateway && config.gatewayToken) || config.usingGateway,
  );
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

export async function generateWithOpenAiResponses(config: ResolvedLlmConfig, input: LlmGenerateInput): Promise<LlmGenerateOutput> {
  if (!config.enabled) {
    throw new Error('llm_not_configured');
  }

  const authorizationToken = resolveOpenAiAuthorizationToken(config);
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
  console.log('llm_openai_request_started', {
    baseUrl: config.baseUrl,
    model: config.model,
    usingGateway: config.usingGateway,
    usingGatewayCompat: config.usingGatewayCompat,
    messageCount: input.messages.length,
    temperature: input.temperature ?? 0.3,
    maxOutputTokens: normalizeMaxOutputTokens(input.maxTokens),
    maxAttempts,
    keyFingerprint,
  });

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
          max_output_tokens: normalizeMaxOutputTokens(input.maxTokens),
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
      console.warn('llm_openai_network_error', {
        baseUrl: config.baseUrl,
        model: config.model,
        attempt,
        maxAttempts,
        keyFingerprint,
        causeMessage: wrapped.causeMessage,
      });
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
      console.warn('llm_openai_response_error', {
        status: response.status,
        baseUrl: config.baseUrl,
        model: config.model,
        attempt,
        maxAttempts,
        retryAfterMs,
        requestId,
        cfRay: wrapped.cfRay ?? null,
        server: wrapped.server ?? null,
        openaiProject: wrapped.openaiProject ?? null,
        openaiOrganization: wrapped.openaiOrganization ?? null,
        rateLimitLimitRequests: wrapped.rateLimitLimitRequests ?? null,
        rateLimitLimitTokens: wrapped.rateLimitLimitTokens ?? null,
        rateLimitRemainingRequests: wrapped.rateLimitRemainingRequests ?? null,
        rateLimitRemainingTokens: wrapped.rateLimitRemainingTokens ?? null,
        rateLimitResetRequests: wrapped.rateLimitResetRequests ?? null,
        rateLimitResetTokens: wrapped.rateLimitResetTokens ?? null,
        keyFingerprint,
        responseBodySnippet: wrapped.responseBodySnippet,
      });
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
      console.warn('llm_openai_empty_response', {
        baseUrl: config.baseUrl,
        model: config.model,
        attempt,
        maxAttempts,
        incompleteReason: incompleteReason ?? null,
        errorMessage: errorMessage ?? null,
        keyFingerprint,
      });
      throw new Error(
        ['llm_empty_response', incompleteReason ? `reason=${incompleteReason}` : null, errorMessage ? `error=${errorMessage}` : null]
          .filter((part): part is string => Boolean(part))
          .join(':'),
      );
    }

    const debugFields = collectSuccessDebugFields(response);
    console.log('llm_openai_request_succeeded', {
      baseUrl: config.baseUrl,
      model: typeof json.model === 'string' && json.model.trim() ? json.model : config.model,
      attempt,
      maxAttempts,
      keyFingerprint,
      responseChars: text.length,
      requestId: debugFields.requestId ?? null,
      cfRay: debugFields.cfRay ?? null,
      server: debugFields.server ?? null,
      openaiProject: debugFields.openaiProject ?? null,
      openaiOrganization: debugFields.openaiOrganization ?? null,
      rateLimitLimitRequests: debugFields.rateLimitLimitRequests ?? null,
      rateLimitLimitTokens: debugFields.rateLimitLimitTokens ?? null,
      rateLimitRemainingRequests: debugFields.rateLimitRemainingRequests ?? null,
      rateLimitRemainingTokens: debugFields.rateLimitRemainingTokens ?? null,
      rateLimitResetRequests: debugFields.rateLimitResetRequests ?? null,
      rateLimitResetTokens: debugFields.rateLimitResetTokens ?? null,
    });
    return {
      provider: 'openai',
      model: typeof json.model === 'string' && json.model.trim() ? json.model : config.model,
      text,
      keyFingerprint,
      ...debugFields,
    };
  }

  throw new Error('llm_retry_exhausted');
}
