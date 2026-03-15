import type { Bindings } from '../types';
import {
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
  generateWithGeminiNative,
  isGeminiConfigEnabled,
} from './llm/gemini';
import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  generateWithOpenAiResponses,
  isOpenAiConfigEnabled,
  resolveOpenAiAuthorizationToken,
} from './llm/openaiResponses';
import { LlmRequestError, fingerprintApiKey } from './llm/shared';

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
  fallbackFrom?: string | null;
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

export type ResolvedLlmConfig = {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  gatewayToken: string | null;
  usingGateway: boolean;
  usingGatewayCompat: boolean;
};

type LlmStatus = {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
};

const CLOUDFLARE_AI_GATEWAY_HOST = 'gateway.ai.cloudflare.com';
const CLOUDFLARE_AI_GATEWAY_BASE_URL = `https://${CLOUDFLARE_AI_GATEWAY_HOST}/v1`;

export async function generateWithLlm(env: Bindings, input: LlmGenerateInput): Promise<LlmGenerateOutput> {
  const primary = resolveLlmConfig(env);
  const fallback = resolveLlmConfig(env, 'fallback');

  try {
    return await callLlmProvider(primary, input);
  } catch (error) {
    if (!shouldUseFallback(primary, fallback)) {
      throw error;
    }

    console.warn('llm_primary_failed_falling_back', {
      primaryProvider: primary.provider,
      primaryModel: primary.model,
      primaryBaseUrl: primary.baseUrl,
      fallbackProvider: fallback.provider,
      fallbackModel: fallback.model,
      fallbackBaseUrl: fallback.baseUrl,
      primaryError: getLlmErrorInfo(error),
    });

    try {
      const result = await callLlmProvider(fallback, input);
      return {
        ...result,
        fallbackFrom: primary.provider,
      };
    } catch (fallbackError) {
      if (fallbackError instanceof LlmRequestError) {
        fallbackError.causeMessage = `primary_failed:${formatFallbackCause(error)}`;
      }
      throw fallbackError;
    }
  }
}

export function getLlmStatus(env: Bindings): LlmStatus & {
  fallbackEnabled: boolean;
  fallbackProvider: string;
  fallbackModel: string;
  fallbackBaseUrl: string;
} {
  const config = resolveLlmConfig(env);
  const fallback = resolveLlmConfig(env, 'fallback');
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    fallbackEnabled: shouldUseFallback(config, fallback),
    fallbackProvider: fallback.provider,
    fallbackModel: fallback.model,
    fallbackBaseUrl: fallback.baseUrl,
  };
}

export async function getLlmDebugStatus(env: Bindings): Promise<
  LlmStatus & {
    keyFingerprint: string | null;
    fallbackEnabled: boolean;
    fallbackProvider: string;
    fallbackModel: string;
    fallbackBaseUrl: string;
    fallbackKeyFingerprint: string | null;
  }
> {
  const config = resolveLlmConfig(env);
  const fallback = resolveLlmConfig(env, 'fallback');
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    keyFingerprint: await fingerprintApiKey(resolveDebugSecret(config) ?? undefined),
    fallbackEnabled: shouldUseFallback(config, fallback),
    fallbackProvider: fallback.provider,
    fallbackModel: fallback.model,
    fallbackBaseUrl: fallback.baseUrl,
    fallbackKeyFingerprint: await fingerprintApiKey(resolveDebugSecret(fallback) ?? undefined),
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

function resolveFallbackLlmProvider(env: Bindings): string {
  return (env.LLM_FALLBACK_PROVIDER ?? '').trim().toLowerCase();
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

function isCloudflareAiGatewayProviderUrl(baseUrl: string, providerPath: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === CLOUDFLARE_AI_GATEWAY_HOST && url.pathname.replace(/\/+$/, '').endsWith(`/${providerPath}`);
  } catch {
    return false;
  }
}

function normalizeGatewayBaseUrlForResponses(provider: string, baseUrl: string): string {
  if (provider !== 'openai' || !isCloudflareAiGatewayCompatUrl(baseUrl)) {
    return baseUrl;
  }

  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/compat\/?$/, `/${provider}`);
  return url.toString();
}

function buildCloudflareAiGatewayBaseUrl(accountId: string, gatewayId: string, provider: string): string {
  return `${CLOUDFLARE_AI_GATEWAY_BASE_URL}/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/${resolveGatewayProviderPath(
    provider,
  )}`;
}

function resolveGatewayProviderPath(provider: string): string {
  switch (provider) {
    case 'gemini':
      return 'google-ai-studio';
    case 'openai':
    default:
      return provider;
  }
}

function resolveDefaultBaseUrl(provider: string): string {
  switch (provider) {
    case 'gemini':
      return DEFAULT_GEMINI_BASE_URL;
    case 'openai':
    default:
      return DEFAULT_OPENAI_BASE_URL;
  }
}

function resolveDefaultModel(provider: string): string {
  switch (provider) {
    case 'gemini':
      return DEFAULT_GEMINI_MODEL;
    case 'openai':
    default:
      return DEFAULT_OPENAI_MODEL;
  }
}

function resolveLlmConfig(env: Bindings, mode: 'primary' | 'fallback' = 'primary'): ResolvedLlmConfig {
  const provider = mode === 'fallback' ? resolveFallbackLlmProvider(env) : resolveLlmProvider(env);
  const explicitBaseUrl = trimEnvValue(mode === 'fallback' ? env.LLM_FALLBACK_BASE_URL : env.LLM_BASE_URL);
  const gatewayAccountId = trimEnvValue(env.CF_AI_GATEWAY_ACCOUNT_ID);
  const gatewayId = trimEnvValue(env.CF_AI_GATEWAY_GATEWAY_ID);
  const gatewayToken = trimEnvValue(env.CF_AI_GATEWAY_TOKEN) ?? trimEnvValue(env.CF_AIG_TOKEN);
  const apiKey = trimEnvValue(mode === 'fallback' ? env.LLM_FALLBACK_API_KEY : env.LLM_API_KEY);
  if (!provider) {
    return {
      enabled: false,
      provider: '',
      baseUrl: '',
      model: '',
      apiKey,
      gatewayToken,
      usingGateway: false,
      usingGatewayCompat: false,
    };
  }

  const gatewayBaseUrl = gatewayAccountId && gatewayId ? buildCloudflareAiGatewayBaseUrl(gatewayAccountId, gatewayId, provider) : null;
  const explicitBaseUrlIsDefaultOpenAi =
    explicitBaseUrl !== null && normalizeBaseUrl(explicitBaseUrl) === DEFAULT_OPENAI_BASE_URL;
  const baseUrl = normalizeGatewayBaseUrlForResponses(
    provider,
    gatewayBaseUrl && (explicitBaseUrl === null || explicitBaseUrlIsDefaultOpenAi)
      ? gatewayBaseUrl
      : normalizeBaseUrl(explicitBaseUrl ?? gatewayBaseUrl ?? resolveDefaultBaseUrl(provider)),
  );
  const model = resolveLlmModel(
    provider,
    baseUrl,
    trimEnvValue(mode === 'fallback' ? env.LLM_FALLBACK_MODEL : env.LLM_MODEL) ?? resolveDefaultModel(provider),
  );
  const usingGateway = isCloudflareAiGatewayUrl(baseUrl);
  const usingGatewayCompat = isCloudflareAiGatewayCompatUrl(baseUrl);
  const enabled = isLlmConfigEnabled({
    provider,
    apiKey,
    gatewayToken,
    usingGateway,
    usingGatewayCompat,
  });

  return {
    enabled,
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
  if (isCloudflareAiGatewayCompatUrl(baseUrl)) {
    if (model.includes('/')) return model;
    return `${resolveGatewayProviderPath(provider)}/${model}`;
  }

  const providerPath = resolveGatewayProviderPath(provider);
  if (isCloudflareAiGatewayProviderUrl(baseUrl, providerPath) && model.startsWith(`${providerPath}/`)) {
    return model.slice(providerPath.length + 1);
  }

  return model;
}

function resolveDebugSecret(config: ResolvedLlmConfig): string | null {
  if (config.provider === 'gemini') {
    return config.apiKey ?? config.gatewayToken;
  }
  return resolveOpenAiAuthorizationToken(config) ?? config.gatewayToken;
}

function isLlmConfigEnabled(
  config: Pick<ResolvedLlmConfig, 'provider' | 'apiKey' | 'gatewayToken' | 'usingGateway' | 'usingGatewayCompat'>,
): boolean {
  if (!config.provider) return false;
  if (config.provider === 'openai') {
    return isOpenAiConfigEnabled(config);
  }
  if (config.provider === 'gemini') {
    return isGeminiConfigEnabled(config);
  }
  return Boolean(config.apiKey || config.gatewayToken);
}

function shouldUseFallback(primary: ResolvedLlmConfig, fallback: ResolvedLlmConfig): boolean {
  if (!primary.provider || !fallback.enabled) return false;
  if (!fallback.provider) return false;
  return !(
    primary.provider === fallback.provider &&
    primary.baseUrl === fallback.baseUrl &&
    primary.model === fallback.model &&
    primary.apiKey === fallback.apiKey &&
    primary.gatewayToken === fallback.gatewayToken
  );
}

function formatFallbackCause(error: unknown): string {
  const info = getLlmErrorInfo(error);
  return [info.message, info.status ? `status=${info.status}` : null, info.model ? `model=${info.model}` : null]
    .filter((part): part is string => Boolean(part))
    .join(',');
}

async function callLlmProvider(config: ResolvedLlmConfig, input: LlmGenerateInput): Promise<LlmGenerateOutput> {
  switch (config.provider) {
    case 'openai':
      return generateWithOpenAiResponses(config, input);
    case 'gemini':
      return generateWithGeminiNative(config, input);
    default:
      throw new Error(`unsupported_llm_provider_${config.provider}`);
  }
}
