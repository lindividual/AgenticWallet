import type { Bindings } from '../types';
import { normalizeR2Key } from './userAgentHelpers';
import type { ArticleContentRow } from './userAgentTypes';
import type { SqlStorage } from './userAgentContentTypes';

export async function putArticleMarkdownContent(
  env: Bindings,
  sql: SqlStorage,
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

  sql.exec(
    `INSERT INTO article_contents (article_id, markdown)
     VALUES (?, ?)
     ON CONFLICT(article_id) DO UPDATE SET markdown = excluded.markdown`,
    articleId,
    markdown,
  );
}

export async function getArticleMarkdownContent(
  env: Bindings,
  sql: SqlStorage,
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

  const content = sql
    .exec('SELECT article_id, markdown FROM article_contents WHERE article_id = ? LIMIT 1', articleId)
    .toArray()[0] as ArticleContentRow | undefined;
  return content?.markdown ?? '';
}
