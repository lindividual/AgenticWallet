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

type OpenAiChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';

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

function resolveLlmProvider(env: Bindings): string {
  return (env.LLM_PROVIDER ?? 'openai').trim().toLowerCase();
}

async function callOpenAiCompatible(env: Bindings, input: LlmGenerateInput): Promise<LlmGenerateOutput> {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('llm_api_key_not_configured');
  }

  const baseUrl = (env.LLM_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).trim();
  const model = (env.LLM_MODEL ?? DEFAULT_OPENAI_MODEL).trim();

  const response = await fetch(`${baseUrl}/chat/completions`, {
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

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`llm_request_failed_${response.status}_${body}`);
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
