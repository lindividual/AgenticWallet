import { safeJsonParse } from '../utils/json';

export type TopicArticleRuntimeToolName =
  | 'read_packet_overview'
  | 'read_source_refs'
  | 'read_news_signals'
  | 'read_social_signals'
  | 'read_meme_signals'
  | 'read_spot_signals'
  | 'read_perp_signals'
  | 'read_prediction_signals';

export type TopicArticleRuntimeToolCall = {
  tool: TopicArticleRuntimeToolName;
  arguments: Record<string, string | null | undefined>;
};

export type TopicArticleRuntimeStep =
  | {
      kind: 'tool_call';
      toolCall: TopicArticleRuntimeToolCall;
    }
  | {
      kind: 'final';
      markdown: string;
    };

function normalizeText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value || null;
}

function stripOuterFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json|markdown|md)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function extractJsonObject(text: string): string | null {
  const candidate = stripOuterFences(text);
  if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function normalizeToolArguments(
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

export function parseTopicArticleRuntimeStep(
  text: string,
  availableTools: TopicArticleRuntimeToolName[],
): TopicArticleRuntimeStep {
  const candidate = extractJsonObject(text);
  const payload = safeJsonParse<Record<string, unknown>>(candidate);
  if (payload) {
    const type = normalizeText(payload.type);
    const tool = normalizeText(payload.tool) as TopicArticleRuntimeToolName | null;
    if (type === 'tool_call' && tool && availableTools.includes(tool)) {
      return {
        kind: 'tool_call',
        toolCall: {
          tool,
          arguments: normalizeToolArguments(payload.arguments),
        },
      };
    }

    const markdown = normalizeText(payload.markdown) ?? normalizeText(payload.reply);
    if (type === 'final' && markdown) {
      return {
        kind: 'final',
        markdown,
      };
    }
  }

  return {
    kind: 'final',
    markdown: stripOuterFences(text),
  };
}
