import type { Bindings } from '../types';

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlmGenerateInput = {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
};

export type LlmGenerateOutput = {
  provider: string;
  model: string;
  text: string;
};

export type LlmErrorInfo = {
  message: string;
  status?: number;
  requestId?: string | null;
  baseUrl?: string;
  model?: string;
  responseBodySnippet?: string;
  causeMessage?: string;
  attempt?: number;
  maxAttempts?: number;
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
  baseUrl?: string;
  model?: string;
  responseBodySnippet?: string;
  causeMessage?: string;
  attempt?: number;
  maxAttempts?: number;
}

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

export function getLlmErrorInfo(error: unknown): LlmErrorInfo {
  if (error instanceof LlmRequestError) {
    return {
      message: error.message,
      status: error.status,
      requestId: error.requestId,
      baseUrl: error.baseUrl,
      model: error.model,
      responseBodySnippet: error.responseBodySnippet,
      causeMessage: error.causeMessage,
      attempt: error.attempt,
      maxAttempts: error.maxAttempts,
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
  return attempt === 1 ? 500 : 1200;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOpenAiCompatible(env: Bindings, input: LlmGenerateInput): Promise<LlmGenerateOutput> {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('llm_api_key_not_configured');
  }

  const baseUrl = (env.LLM_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).trim();
  const model = (env.LLM_MODEL ?? DEFAULT_OPENAI_MODEL).trim();
  const maxAttempts = 3;

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
      const wrapped = new LlmRequestError(`llm_request_failed_${response.status}`);
      wrapped.status = response.status;
      wrapped.requestId = requestId;
      wrapped.baseUrl = baseUrl;
      wrapped.model = model;
      wrapped.responseBodySnippet = body.slice(0, 1200);
      wrapped.attempt = attempt;
      wrapped.maxAttempts = maxAttempts;
      if (attempt < maxAttempts && isRetryableStatus(response.status)) {
        await sleep(backoffMs(attempt));
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
    };
  }

  throw new Error('llm_retry_exhausted');
}
