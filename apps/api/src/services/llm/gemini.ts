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

type GeminiGenerateContentResponse = {
  modelVersion?: string;
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string | null;
      }>;
    };
  }>;
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  } | null;
  error?: {
    message?: string;
  } | null;
};

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export function isGeminiConfigEnabled(config: Pick<ResolvedLlmConfig, 'apiKey' | 'gatewayToken' | 'usingGateway' | 'usingGatewayCompat'>): boolean {
  return Boolean(config.apiKey || (config.usingGateway && config.gatewayToken) || config.usingGatewayCompat);
}

function extractGeminiText(response: GeminiGenerateContentResponse): string {
  const chunks: string[] = [];
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text.trim()) {
        chunks.push(part.text.trim());
      }
    }
  }
  return chunks.join('\n').trim();
}

function buildGeminiRequestBody(input: LlmGenerateInput): Record<string, unknown> {
  const systemInstruction = input.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n\n');
  const contents = input.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: input.temperature ?? 0.3,
      maxOutputTokens: normalizeMaxOutputTokens(input.maxTokens),
    },
  };

  if (systemInstruction) {
    body.system_instruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  return body;
}

function buildGeminiEndpoint(config: ResolvedLlmConfig): string {
  const path = config.usingGateway
    ? `v1/models/${encodeURIComponent(config.model)}:generateContent`
    : `models/${encodeURIComponent(config.model)}:generateContent`;
  return new URL(path, `${config.baseUrl}/`).toString();
}

export async function generateWithGeminiNative(config: ResolvedLlmConfig, input: LlmGenerateInput): Promise<LlmGenerateOutput> {
  if (!config.enabled) {
    throw new Error('llm_not_configured');
  }

  const keyFingerprint = await fingerprintApiKey(config.apiKey ?? config.gatewayToken ?? undefined);
  const maxRetryDelayMs = normalizeMaxRetryDelayMs(input.maxRetryDelayMs);
  const maxAttempts = Number.isFinite(input.retryAttempts)
    ? Math.min(Math.max(Math.trunc(input.retryAttempts ?? 3), 1), 6)
    : 3;
  const endpoint = buildGeminiEndpoint(config);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (config.apiKey) {
    headers['x-goog-api-key'] = config.apiKey;
  }
  if (config.usingGateway && config.gatewayToken) {
    headers['cf-aig-authorization'] = `Bearer ${config.gatewayToken}`;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildGeminiRequestBody(input)),
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

    const json = (await response.json()) as GeminiGenerateContentResponse;
    const text = extractGeminiText(json);
    if (!text) {
      const blockReason = json.promptFeedback?.blockReason?.trim();
      const blockMessage = json.promptFeedback?.blockReasonMessage?.trim();
      const finishReason = json.candidates?.find((candidate) => candidate.finishReason?.trim())?.finishReason?.trim();
      const errorMessage = json.error?.message?.trim();
      throw new Error(
        [
          'llm_empty_response',
          blockReason ? `block_reason=${blockReason}` : null,
          blockMessage ? `block_message=${blockMessage}` : null,
          finishReason ? `finish_reason=${finishReason}` : null,
          errorMessage ? `error=${errorMessage}` : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join(':'),
      );
    }

    return {
      provider: 'gemini',
      model: typeof json.modelVersion === 'string' && json.modelVersion.trim() ? json.modelVersion : config.model,
      text,
      keyFingerprint,
      ...collectSuccessDebugFields(response),
    };
  }

  throw new Error('llm_retry_exhausted');
}
