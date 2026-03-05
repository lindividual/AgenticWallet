import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { cacheStores, clearExpired, pruneCacheStore, readCache, writeCache } from '../utils/indexedDbCache';

type CachedIconImageProps = {
  src: string;
  alt: string;
  className?: string;
  loading?: 'eager' | 'lazy';
  fallback?: ReactNode;
  onError?: () => void;
};

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 300;
const MAX_ICON_BYTES = 50 * 1024;
const MAX_DATA_URL_LENGTH = 80_000;

const memoryCache = new Map<string, string>();
const pendingWarmups = new Map<string, Promise<void>>();

function isRemoteIcon(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

function canWarmRemoteIcon(src: string): boolean {
  if (!isRemoteIcon(src) || typeof window === 'undefined') return false;
  try {
    const url = new URL(src, window.location.href);
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

async function getCachedIcon(src: string): Promise<string | null> {
  if (!canWarmRemoteIcon(src)) return null;
  const memory = memoryCache.get(src);
  if (memory) return memory;
  const cached = await readCache<string>(cacheStores.icon, src);
  if (cached) memoryCache.set(src, cached);
  return cached;
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('icon_read_failed'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(blob);
  });
}

async function warmIconCache(src: string): Promise<void> {
  if (!canWarmRemoteIcon(src)) return;
  if (await getCachedIcon(src)) return;
  const existing = pendingWarmups.get(src);
  if (existing) {
    await existing;
    return;
  }

  const task = (async () => {
    try {
      const response = await fetch(src, { method: 'GET' });
      if (!response.ok) return;
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) return;
      if (blob.size > MAX_ICON_BYTES) return;
      const dataUrl = await toDataUrl(blob);
      if (!dataUrl || dataUrl.length > MAX_DATA_URL_LENGTH) return;
      memoryCache.set(src, dataUrl);
      await writeCache<string>(cacheStores.icon, src, dataUrl, CACHE_TTL_MS);
      await clearExpired(cacheStores.icon);
      await pruneCacheStore(cacheStores.icon, MAX_ENTRIES);
    } catch {
      // Ignore cross-origin and network failures. Browser cache still applies.
    }
  })();

  pendingWarmups.set(src, task);
  try {
    await task;
  } finally {
    pendingWarmups.delete(src);
  }
}

export function CachedIconImage({
  src,
  alt,
  className,
  loading = 'lazy',
  fallback,
  onError,
}: CachedIconImageProps) {
  const normalizedSrc = useMemo(() => src.trim(), [src]);
  const [resolvedSrc, setResolvedSrc] = useState<string>(() => normalizedSrc);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    if (!normalizedSrc) {
      setResolvedSrc('');
      return () => {
        cancelled = true;
      };
    }
    if (!isRemoteIcon(normalizedSrc)) {
      setResolvedSrc(normalizedSrc);
      return () => {
        cancelled = true;
      };
    }
    setResolvedSrc(normalizedSrc);
    if (!canWarmRemoteIcon(normalizedSrc)) {
      return () => {
        cancelled = true;
      };
    }
    void getCachedIcon(normalizedSrc).then((cached) => {
      if (cancelled) return;
      if (cached) {
        setResolvedSrc(cached);
        return;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [normalizedSrc]);

  useEffect(() => {
    if (!canWarmRemoteIcon(normalizedSrc)) return;
    void warmIconCache(normalizedSrc).then(async () => {
      const value = await getCachedIcon(normalizedSrc);
      if (value) setResolvedSrc(value);
    });
  }, [normalizedSrc]);

  if (loadFailed && fallback != null) {
    return <>{fallback}</>;
  }

  if (!resolvedSrc) {
    if (fallback != null) return <>{fallback}</>;
    return <div className={className} aria-hidden="true" />;
  }

  return (
    <img
      src={resolvedSrc}
      alt={alt}
      className={className}
      loading={loading}
      referrerPolicy="no-referrer"
      onError={() => {
        setLoadFailed(true);
        onError?.();
      }}
    />
  );
}
