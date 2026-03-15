import type { Bindings } from '../types';
import { normalizeR2Key } from './userAgentHelpers';

export async function putArticleMarkdownContent(
  env: Bindings,
  articleId: string,
  r2Key: string,
  markdown: string,
): Promise<void> {
  const normalizedKey = normalizeR2Key(r2Key);
  if (!normalizedKey) {
    throw new Error('invalid_r2_key');
  }
  try {
    await env.AGENT_ARTICLES.put(normalizedKey, new TextEncoder().encode(markdown), {
      httpMetadata: {
        contentType: 'text/markdown; charset=utf-8',
      },
      customMetadata: {
        articleId,
      },
    });
  } catch (error) {
    console.error('article_markdown_put_failed', {
      articleId,
      r2Key,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function deleteArticleMarkdownContent(
  env: Bindings,
  r2Key: string,
): Promise<void> {
  const normalizedKey = normalizeR2Key(r2Key);
  if (!normalizedKey) return;
  await env.AGENT_ARTICLES.delete(normalizedKey);
}

export async function getArticleMarkdownContent(
  env: Bindings,
  articleId: string,
  r2Key: string,
): Promise<string> {
  const normalizedKey = normalizeR2Key(r2Key);
  if (normalizedKey) {
    try {
      const object = await env.AGENT_ARTICLES.get(normalizedKey);
      if (object) {
        const text = await object.text();
        if (text) return text;
      } else {
        console.warn('article_markdown_not_found', {
          articleId,
          r2Key: normalizedKey,
        });
      }
    } catch (error) {
      console.error('article_markdown_get_failed', {
        articleId,
        r2Key: normalizedKey,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return '';
}

export function buildMissingArticleMarkdownFallback(input: {
  title: string;
  summary: string;
  articleType: string;
  createdAt: string;
}): string {
  const heading = input.title.trim() || (input.articleType === 'topic' ? 'Topic Update' : 'Daily Brief');
  const summary = input.summary.trim() || 'Content is temporarily unavailable.';
  const createdAt = input.createdAt.trim();

  return [
    `# ${heading}`,
    '',
    createdAt ? `> Generated at: ${createdAt}` : '',
    '',
    '## Summary',
    summary,
    '',
    '## Note',
    'Full article content is temporarily unavailable. Showing the saved summary instead.',
  ]
    .filter(Boolean)
    .join('\n');
}
