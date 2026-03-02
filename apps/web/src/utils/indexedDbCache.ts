const DB_NAME = 'agentic_wallet_cache_db';
const DB_VERSION = 1;
const STORE_QUERY = 'query_cache';
const STORE_ICON = 'icon_cache';

type CacheStoreName = typeof STORE_QUERY | typeof STORE_ICON;

type CacheRecord<T> = {
  key: string;
  value: T;
  updatedAt: number;
  expiresAt: number;
};

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_QUERY)) {
          const queryStore = db.createObjectStore(STORE_QUERY, { keyPath: 'key' });
          queryStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          queryStore.createIndex('expiresAt', 'expiresAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_ICON)) {
          const iconStore = db.createObjectStore(STORE_ICON, { keyPath: 'key' });
          iconStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          iconStore.createIndex('expiresAt', 'expiresAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function txComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('idb_tx_failed'));
    tx.onabort = () => reject(tx.error ?? new Error('idb_tx_aborted'));
  });
}

export async function readCache<T>(storeName: CacheStoreName, key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const record = await new Promise<CacheRecord<T> | undefined>((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result as CacheRecord<T> | undefined);
      req.onerror = () => reject(req.error);
    });
    await txComplete(tx);
    if (!record) return null;
    if (!Number.isFinite(Number(record.expiresAt)) || Date.now() > Number(record.expiresAt)) {
      void deleteCache(storeName, key);
      return null;
    }
    return record.value ?? null;
  } catch {
    return null;
  }
}

export async function writeCache<T>(
  storeName: CacheStoreName,
  key: string,
  value: T,
  ttlMs: number,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const now = Date.now();
  const record: CacheRecord<T> = {
    key,
    value,
    updatedAt: now,
    expiresAt: now + Math.max(0, ttlMs),
  };
  try {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(record);
    await txComplete(tx);
  } catch {
    // Ignore cache write failures.
  }
}

export async function deleteCache(storeName: CacheStoreName, key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    await txComplete(tx);
  } catch {
    // Ignore cache delete failures.
  }
}

export async function pruneCacheStore(storeName: CacheStoreName, maxEntries: number): Promise<void> {
  const db = await openDb();
  if (!db) return;
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) return;
  try {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const count = await new Promise<number>((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const toDelete = count - maxEntries;
    if (toDelete > 0) {
      const index = store.index('updatedAt');
      let deleted = 0;
      await new Promise<void>((resolve, reject) => {
        const cursorRequest = index.openCursor();
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || deleted >= toDelete) {
            resolve();
            return;
          }
          cursor.delete();
          deleted += 1;
          cursor.continue();
        };
      });
    }
    await txComplete(tx);
  } catch {
    // Ignore prune failures.
  }
}

export async function clearExpired(storeName: CacheStoreName): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const index = store.index('expiresAt');
    const now = Date.now();
    await new Promise<void>((resolve, reject) => {
      const cursorRequest = index.openCursor(IDBKeyRange.upperBound(now));
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
    });
    await txComplete(tx);
  } catch {
    // Ignore cleanup failures.
  }
}

export const cacheStores = {
  query: STORE_QUERY,
  icon: STORE_ICON,
} as const;
