import type { Bindings } from '../types';

const DEFAULT_NEWS_FEEDS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://cointelegraph.com/rss',
];

export async function fetchNewsHeadlines(env: Bindings): Promise<string[]> {
  const feedList = (env.DAILY_NEWS_FEEDS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const feeds = feedList.length ? feedList : DEFAULT_NEWS_FEEDS;
  const headlines: string[] = [];

  const fetchPromises = feeds.slice(0, 4).map(async (feed) => {
    try {
      const res = await fetch(feed, {
        headers: {
          accept: 'application/rss+xml, application/xml, text/xml',
          'user-agent': 'AgenticWallet/1.0 RSS Reader',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const xml = await res.text();
      return extractRssTitles(xml);
    } catch {
      return [];
    }
  });

  const results = await Promise.allSettled(fetchPromises);
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const title of result.value) {
      if (!headlines.includes(title)) {
        headlines.push(title);
      }
      if (headlines.length >= 10) return headlines;
    }
  }

  return headlines;
}

function extractRssTitles(xml: string): string[] {
  const titles: string[] = [];
  const itemMatches = xml.matchAll(/<item[\s\S]*?<\/item>/gi);
  for (const match of itemMatches) {
    const item = match[0];
    const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/i);
    if (!titleMatch?.[1]) continue;
    const decoded = decodeXmlEntities(stripCdata(titleMatch[1])).trim();
    if (!decoded) continue;
    titles.push(decoded);
    if (titles.length >= 5) break;
  }
  return titles;
}

function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
