import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { searchMarketTokens, type MarketSearchResult } from '../api';
import { CachedIconImage } from './CachedIconImage';
import { formatUsdAdaptive } from '../utils/currency';

type TokenSearchModalProps = {
  visible: boolean;
  onClose: () => void;
  onSelectItem: (item: MarketSearchResult) => void;
};

function formatPct(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(2)}%`;
}

function pctClassName(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return 'text-base-content/55';
  const numberValue = Number(value);
  if (numberValue > 0) return 'text-success';
  if (numberValue < 0) return 'text-error';
  return 'text-base-content/70';
}

function getMarketTypeLabel(t: (key: string) => string, marketType: MarketSearchResult['marketType']): string {
  if (marketType === 'spot') return t('trade.tokens');
  if (marketType === 'stock') return t('trade.stocks');
  if (marketType === 'perp') return t('trade.perps');
  return t('trade.prediction');
}

export function TokenSearchModal({ visible, onClose, onSelectItem }: TokenSearchModalProps) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MarketSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      setQuery('');
      setResults([]);
    }
  }, [visible]);

  const performSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    try {
      const items = await searchMarketTokens(trimmed, 20);
      setResults(items);
    } catch {
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  function handleQueryChange(value: string): void {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void performSearch(value);
    }, 350);
  }

  function handleSelect(item: MarketSearchResult): void {
    onSelectItem(item);
    onClose();
  }

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-base-200/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="mx-auto flex w-full max-w-[420px] flex-col p-4">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-base-content/50"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              className="input input-bordered w-full pl-9 text-sm"
              placeholder={t('trade.searchPlaceholder')}
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
          >
            {t('common.close')}
          </button>
        </div>

        <div className="mt-3 flex-1 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 100px)' }}>
          {isSearching && (
            <div className="flex items-center justify-center py-8">
              <span className="loading loading-spinner loading-md" />
            </div>
          )}

          {!isSearching && query.trim() && results.length === 0 && (
            <p className="py-8 text-center text-sm text-base-content/60">
              {t('trade.searchNoResults')}
            </p>
          )}

          {!isSearching && !query.trim() && (
            <p className="py-8 text-center text-sm text-base-content/50">
              {t('trade.searchHint')}
            </p>
          )}

          {results.length > 0 && (
            <div className="overflow-hidden rounded-xl bg-base-200/35">
              {results.map((item) => {
                const changeClass = pctClassName(item.change24h);
                const fallback = (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-base-300 text-sm font-semibold text-base-content/75">
                    {item.symbol ? item.symbol[0].toUpperCase() : '?'}
                  </div>
                );
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-3 border-b border-base-content/10 px-4 py-3 text-left transition-colors hover:bg-base-200/70 last:border-b-0"
                    onClick={() => handleSelect(item)}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {item.image ? (
                        <CachedIconImage
                          src={item.image}
                          alt={item.symbol}
                          className="h-9 w-9 shrink-0 rounded-full bg-white/10 object-cover"
                          loading="lazy"
                          fallback={fallback}
                        />
                      ) : fallback}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="m-0 truncate text-[15px] font-semibold">{item.symbol}</p>
                          <span className="rounded-full bg-base-300 px-2 py-0.5 text-[10px] font-medium text-base-content/65">
                            {getMarketTypeLabel(t, item.marketType)}
                          </span>
                        </div>
                        <p className="m-0 mt-0.5 truncate text-xs text-base-content/55">{item.name}</p>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      {item.marketType === 'prediction' ? (
                        <>
                          <p className="m-0 text-sm text-base-content/65">
                            {item.probability != null ? `${item.probability.toFixed(1)}%` : '--'}
                          </p>
                          <p className="m-0 mt-0.5 text-xs text-base-content/55">{t('trade.probability')}</p>
                        </>
                      ) : (
                        <>
                          <p className="m-0 text-sm text-base-content/65">
                            {item.currentPrice != null ? formatUsdAdaptive(item.currentPrice, i18n.language) : '--'}
                          </p>
                          <p className={`m-0 mt-0.5 text-sm font-semibold ${changeClass}`}>
                            {formatPct(item.change24h)}
                          </p>
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
