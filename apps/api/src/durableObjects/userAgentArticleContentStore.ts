import type { Bindings } from '../types';
import { normalizeR2Key } from './userAgentHelpers';

export async function putArticleMarkdownContent(
  env: Bindings,
  articleId: string,
  r2Key: string,
  markdown: string,
): Promise<void> {
  await env.AGENT_ARTICLES.put(r2Key, markdown, {
    httpMetadata: {
      contentType: 'text/markdown; charset=utf-8',
    },
    customMetadata: {
      articleId,
    },
  });
}

export async function getArticleMarkdownContent(
  env: Bindings,
  articleId: string,
  r2Key: string,
): Promise<string> {
  const normalizedKey = normalizeR2Key(r2Key);
  if (normalizedKey) {
    const object = await env.AGENT_ARTICLES.get(normalizedKey);
    if (object) {
      const text = await object.text();
      if (text) return text;
    }
  }
  return '';
}
