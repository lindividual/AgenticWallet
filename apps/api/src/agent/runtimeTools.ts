import { safeJsonParse } from '../utils/json';

export type AgentRuntimeToolName =
  | 'read_article'
  | 'read_token_context'
  | 'read_wallet_context'
  | 'read_receive_addresses';

export type AgentChatToolCall = {
  tool: AgentRuntimeToolName;
  arguments: Record<string, string | null | undefined>;
};

const AGENT_RUNTIME_TOOL_NAMES: AgentRuntimeToolName[] = [
  'read_article',
  'read_token_context',
  'read_wallet_context',
  'read_receive_addresses',
];

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value || null;
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function extractJsonObject(text: string): string | null {
  const candidate = stripJsonFences(text);
  if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

export function getRuntimeTokenContext(
  pageContext: Record<string, string>,
): { tokenChain: string | null; tokenContract: string | null; tokenSymbol: string | null; tokenName: string | null } {
  return {
    tokenChain: normalizeText(pageContext.tokenChain) ?? normalizeText(pageContext.chain),
    tokenContract: normalizeText(pageContext.tokenContract) ?? normalizeText(pageContext.contract),
    tokenSymbol: normalizeText(pageContext.tokenSymbol) ?? normalizeText(pageContext.symbol),
    tokenName: normalizeText(pageContext.tokenName),
  };
}

export function getAvailableAgentRuntimeTools(
  page: string,
  pageContext: Record<string, string>,
): AgentRuntimeToolName[] {
  const tokenContext = getRuntimeTokenContext(pageContext);

  return AGENT_RUNTIME_TOOL_NAMES.filter((tool) => {
    if (tool === 'read_article') {
      return Boolean(normalizeText(pageContext.articleId));
    }
    if (tool === 'read_token_context') {
      return page === 'token' && Boolean(tokenContext.tokenChain && tokenContext.tokenContract);
    }
    if (tool === 'read_wallet_context') {
      return page === 'home' || page === 'wallet';
    }
    if (tool === 'read_receive_addresses') {
      return normalizeText(pageContext.receiveMode) === 'true';
    }
    return false;
  });
}

export function normalizeRuntimeToolArguments(
  rawArguments: unknown,
): Record<string, string | null | undefined> {
  if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
    return {};
  }

  const result: Record<string, string | null | undefined> = {};
  for (const [key, value] of Object.entries(rawArguments as Record<string, unknown>)) {
    if (typeof value === 'string') {
      result[key] = value.trim() || null;
      continue;
    }
    if (value == null) {
      result[key] = null;
    }
  }
  return result;
}

export function parseAgentRuntimeToolCall(
  text: string,
  availableTools: AgentRuntimeToolName[],
): AgentChatToolCall | null {
  const candidate = extractJsonObject(text);
  const payload = safeJsonParse<Record<string, unknown>>(candidate);
  if (!payload) return null;

  const type = normalizeText(payload.type);
  const tool = normalizeText(payload.tool) as AgentRuntimeToolName | null;
  if (type !== 'tool_call' || !tool || !availableTools.includes(tool)) {
    return null;
  }

  return {
    tool,
    arguments: normalizeRuntimeToolArguments(payload.arguments),
  };
}
