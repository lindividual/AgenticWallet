const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');
const IMAGE_PROXY_PATH = '/v1/image';

function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function safeParseUrl(value: string, fallback?: string): URL | null {
  try {
    return new URL(value, fallback);
  } catch {
    return null;
  }
}

function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  if (typeof window !== 'undefined') {
    origins.add(window.location.origin);
  }

  const apiUrl = safeParseUrl(API_BASE, typeof window !== 'undefined' ? window.location.href : undefined);
  if (apiUrl) {
    origins.add(apiUrl.origin);
  }
  return origins;
}

export function isAppControlledImageUrl(src: string): boolean {
  if (!isRemoteUrl(src) || typeof window === 'undefined') return false;
  const target = safeParseUrl(src, window.location.href);
  if (!target) return false;
  return getAllowedOrigins().has(target.origin);
}

export function buildProxiedImageUrl(src: string): string {
  const normalized = src.trim();
  if (!normalized || !isRemoteUrl(normalized)) return normalized;

  const target = safeParseUrl(normalized, typeof window !== 'undefined' ? window.location.href : undefined);
  if (!target) return normalized;

  const apiOrigin = API_BASE || (typeof window !== 'undefined' ? window.location.origin : '');
  if (!apiOrigin) return normalized;

  const proxyBase = safeParseUrl(apiOrigin, typeof window !== 'undefined' ? window.location.href : undefined);
  if (!proxyBase) return normalized;
  if (target.origin === proxyBase.origin && target.pathname === IMAGE_PROXY_PATH) return normalized;

  const proxyUrl = new URL(IMAGE_PROXY_PATH, proxyBase.toString());
  proxyUrl.searchParams.set('url', target.toString());
  return proxyUrl.toString();
}
