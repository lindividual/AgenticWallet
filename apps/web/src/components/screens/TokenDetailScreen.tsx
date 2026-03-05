import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Liveline } from 'liveline';
import type { CandlePoint, LivelinePoint } from 'liveline';
import {
  addMarketWatchlistAsset,
  getAppConfig,
  getMarketByInstrumentId,
  getMarketCandlesByInstrumentId,
  getCoinDetail,
  getMarketWatchlist,
  resolveAssetIdentity,
  getTokenKline,
  ingestAgentEvent,
  removeMarketWatchlistAsset,
  type KlinePeriod,
  type TopMarketAsset,
} from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { formatUsdAdaptive } from '../../utils/currency';
import { normalizeCandlesForLiveline, toLivelinePoints } from '../../utils/kline';
import { cloneTradeToken, getChainIdByMarketChain, getTradeTokenConfig } from '../../utils/tradeTokens';
import { CachedIconImage } from '../CachedIconImage';
import { Modal } from '../modals/Modal';
import { TradeContent, type TradePreset } from '../modals/TradeContent';
import { SkeletonBlock } from '../Skeleton';
import { useTheme } from '../../contexts/ThemeContext';

type TokenDetailScreenProps = {
  chain: string;
  contract: string;
  onBack: () => void;
};

const KLINE_PERIOD_OPTIONS: Array<{
  value: KlinePeriod;
  labelKey: string;
}> = [
  { value: '15m', labelKey: 'trade.klinePeriod15m' },
  { value: '1h', labelKey: 'trade.klinePeriod1h' },
  { value: '4h', labelKey: 'trade.klinePeriod4h' },
  { value: '1d', labelKey: 'trade.klinePeriod1d' },
];

const KLINE_CANDLE_WIDTH_SECONDS: Record<KlinePeriod, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
  '1w': 604_800,
};
const TOKEN_ROUTE_PREVIEW_QUERY_KEY = 'trade-token-route-preview';

function formatPct(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(2)}%`;
}

function formatCompact(value: number | null | undefined, locale: string): string {
  if (!Number.isFinite(Number(value))) return '--';
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function formatPercentFromRatio(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function getTokenInitial(symbol: string | null | undefined, name: string | null | undefined): string {
  const label = (symbol ?? name ?? '').trim();
  return label ? label[0].toUpperCase() : '?';
}

function resolveThemeColor(variable: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;

  const probe = document.createElement('span');
  probe.style.color = `var(${variable})`;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color.trim();
  probe.remove();
  return resolved || fallback;
}

function compute24hChangePctFromHourlyCandles(
  candles: Array<{ close: number }> | null | undefined,
): number | null {
  if (!candles || candles.length < 2) return null;
  const latestClose = Number(candles[candles.length - 1]?.close);
  const baseIndex = Math.max(0, candles.length - 1 - 24);
  const baseClose = Number(candles[baseIndex]?.close);
  if (!Number.isFinite(latestClose) || !Number.isFinite(baseClose) || baseClose <= 0) return null;
  return ((latestClose - baseClose) / baseClose) * 100;
}

function toWatchlistKey(chain: string, contract: string): string {
  return `${chain.trim().toLowerCase()}:${contract.trim().toLowerCase()}`;
}

type TokenDetailLike = {
  chain?: string | null;
  contract?: string | null;
  symbol?: string | null;
  name?: string | null;
  image?: string | null;
  currentPriceUsd?: number | null;
  priceChange24h?: number | null;
  holders?: number | null;
  liquidityUsd?: number | null;
  top10HolderPercent?: number | null;
  lockLpPercent?: number | null;
  currentPrice?: number | null;
  change24h?: number | null;
};

function toTokenDetailLike(raw: unknown): TokenDetailLike | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  return {
    chain: typeof row.chain === 'string' ? row.chain : null,
    contract: typeof row.contract === 'string' ? row.contract : null,
    symbol: typeof row.symbol === 'string' ? row.symbol : null,
    name: typeof row.name === 'string' ? row.name : null,
    image: typeof row.image === 'string' ? row.image : null,
    currentPriceUsd: Number.isFinite(Number(row.currentPriceUsd)) ? Number(row.currentPriceUsd) : null,
    priceChange24h: Number.isFinite(Number(row.priceChange24h)) ? Number(row.priceChange24h) : null,
    holders: Number.isFinite(Number(row.holders)) ? Number(row.holders) : null,
    liquidityUsd: Number.isFinite(Number(row.liquidityUsd)) ? Number(row.liquidityUsd) : null,
    top10HolderPercent: Number.isFinite(Number(row.top10HolderPercent)) ? Number(row.top10HolderPercent) : null,
    lockLpPercent: Number.isFinite(Number(row.lockLpPercent)) ? Number(row.lockLpPercent) : null,
    currentPrice: Number.isFinite(Number(row.currentPrice)) ? Number(row.currentPrice) : null,
    change24h: Number.isFinite(Number(row.change24h)) ? Number(row.change24h) : null,
  };
}

export function TokenDetailScreen({ chain, contract, onBack }: TokenDetailScreenProps) {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { showError, showSuccess } = useToast();
  const queryClient = useQueryClient();
  const [klinePeriod, setKlinePeriod] = useState<KlinePeriod>('1h');
  const [chartMode, setChartMode] = useState<'line' | 'candle'>('line');
  const [pendingKlinePeriod, setPendingKlinePeriod] = useState<KlinePeriod | null>(null);
  const [isWatchlistToggling, setIsWatchlistToggling] = useState(false);
  const [tradePreset, setTradePreset] = useState<TradePreset | null>(null);
  const [isTradeModalOpen, setIsTradeModalOpen] = useState(false);

  const normalizedChain = chain.trim().toLowerCase();
  const normalizedContract = contract.trim().toLowerCase();

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [normalizedChain, normalizedContract]);

  const routePreview = useMemo<TopMarketAsset | null>(
    () =>
      queryClient.getQueryData<TopMarketAsset>([
        TOKEN_ROUTE_PREVIEW_QUERY_KEY,
        normalizedChain,
        normalizedContract,
      ]) ?? null,
    [normalizedChain, normalizedContract, queryClient],
  );

  const previewInstrumentId = routePreview?.instrument_id?.trim() || null;

  const { data: resolvedIdentity } = useQuery({
    queryKey: ['trade-token-identity', normalizedChain, normalizedContract],
    queryFn: () =>
      resolveAssetIdentity({
        chain: normalizedChain,
        contract: normalizedContract || 'native',
        marketType: 'spot',
        symbol: routePreview?.symbol,
        nameHint: routePreview?.name,
      }),
    staleTime: 5 * 60_000,
    enabled: !previewInstrumentId,
  });

  const activeInstrumentId = previewInstrumentId
    || resolvedIdentity?.instrument_id?.trim()
    || null;

  const { data: instrumentMarket, isLoading: isInstrumentDetailLoading } = useQuery({
    queryKey: ['trade-token-market-by-instrument', activeInstrumentId],
    queryFn: () => getMarketByInstrumentId(activeInstrumentId ?? ''),
    enabled: Boolean(activeInstrumentId),
    staleTime: 60_000,
    refetchInterval: 90_000,
  });

  const providerDetail = useMemo(
    () => toTokenDetailLike(instrumentMarket?.providerDetail),
    [instrumentMarket?.providerDetail],
  );

  const { data: detail, isLoading: isLegacyDetailLoading } = useQuery({
    queryKey: ['trade-token-detail-legacy', normalizedChain, normalizedContract],
    queryFn: () => getCoinDetail(normalizedChain, normalizedContract),
    staleTime: 15_000,
    refetchInterval: 20_000,
    enabled: !activeInstrumentId,
  });

  const { data: klineData, isLoading: isKlineLoading } = useQuery({
    queryKey: ['trade-token-kline', normalizedChain, normalizedContract, activeInstrumentId, klinePeriod],
    queryFn: () => {
      if (activeInstrumentId) {
        return getMarketCandlesByInstrumentId(activeInstrumentId, klinePeriod, 60);
      }
      return getTokenKline(normalizedChain, normalizedContract, klinePeriod, 60);
    },
    staleTime: 20_000,
    refetchInterval: 30_000,
  });

  const { data: watchlistData } = useQuery({
    queryKey: ['market-watchlist', 200],
    queryFn: () => getMarketWatchlist({ limit: 200 }),
    staleTime: 15_000,
  });
  const { data: appConfig } = useQuery({
    queryKey: ['app-config'],
    queryFn: getAppConfig,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const watchlistKeySet = useMemo(
    () =>
      new Set(
        (watchlistData?.assets ?? []).map((item) =>
          toWatchlistKey(item.chain, item.contract),
        ),
      ),
    [watchlistData?.assets],
  );
  const currentWatchKey = toWatchlistKey(normalizedChain, normalizedContract);
  const isInWatchlist = watchlistKeySet.has(currentWatchKey);

  const rawPriceChangePct =
    providerDetail?.priceChange24h
    ?? providerDetail?.change24h
    ?? detail?.priceChange24h
    ?? routePreview?.price_change_percentage_24h;
  const shouldUseKlineChangeFallback = !Number.isFinite(Number(rawPriceChangePct));

  const { data: fallbackChangeKlineData } = useQuery({
    queryKey: ['trade-token-kline-change-fallback', normalizedChain, normalizedContract, activeInstrumentId],
    queryFn: () => {
      if (activeInstrumentId) {
        return getMarketCandlesByInstrumentId(activeInstrumentId, '1h', 48);
      }
      return getTokenKline(normalizedChain, normalizedContract, '1h', 48);
    },
    staleTime: 20_000,
    refetchInterval: 30_000,
    enabled: shouldUseKlineChangeFallback,
  });

  useEffect(() => {
    ingestAgentEvent('asset_viewed', {
      asset: (providerDetail?.symbol ?? detail?.symbol ?? routePreview?.symbol)?.toUpperCase(),
      itemId: activeInstrumentId ?? undefined,
      chain: normalizedChain,
      contract: normalizedContract,
      source: 'trade_detail',
    }).catch(() => undefined);
  }, [activeInstrumentId, detail?.symbol, normalizedChain, normalizedContract, providerDetail?.symbol, routePreview?.symbol]);

  const chartCandles = useMemo<CandlePoint[]>(
    () => normalizeCandlesForLiveline(klineData),
    [klineData],
  );

  const chartLine = useMemo<LivelinePoint[]>(
    () => toLivelinePoints(chartCandles),
    [chartCandles],
  );

  const latestChartValue =
    chartLine.length > 0
      ? chartLine[chartLine.length - 1].value
      : providerDetail?.currentPriceUsd
        ?? providerDetail?.currentPrice
        ?? detail?.currentPriceUsd
        ?? routePreview?.current_price
        ?? 0;

  const candleWidth = KLINE_CANDLE_WIDTH_SECONDS[klinePeriod];
  const chartWindow = Math.max(candleWidth * Math.min(chartCandles.length || 30, 60), candleWidth * 10);
  const displayContract = (providerDetail?.contract ?? detail?.contract ?? normalizedContract).trim();
  const displayChain = (providerDetail?.chain ?? detail?.chain ?? normalizedChain).trim().toUpperCase();
  const displayName = providerDetail?.name ?? detail?.name ?? routePreview?.name ?? displayContract;
  const displaySymbol = (providerDetail?.symbol ?? detail?.symbol ?? routePreview?.symbol ?? '').trim();
  const displayImage = providerDetail?.image ?? detail?.image ?? routePreview?.image ?? null;
  const tradeMarketChain = (providerDetail?.chain ?? detail?.chain ?? routePreview?.chain ?? normalizedChain).trim().toLowerCase();
  const tradeContract = (providerDetail?.contract ?? detail?.contract ?? normalizedContract).trim();
  const tradeChainId = getChainIdByMarketChain(tradeMarketChain);
  const tradeTokenConfig = tradeChainId ? getTradeTokenConfig(tradeChainId) : null;
  const canTradeToken = Boolean(tradeChainId && tradeTokenConfig && /^0x[a-fA-F0-9]{40}$/.test(tradeContract));

  const fallbackPriceChangePct = useMemo(
    () => compute24hChangePctFromHourlyCandles(fallbackChangeKlineData),
    [fallbackChangeKlineData],
  );
  const priceChangePct = rawPriceChangePct ?? fallbackPriceChangePct;
  const hasPriceChangePct = Number.isFinite(Number(priceChangePct));
  const numericPriceChangePct = hasPriceChangePct ? Number(priceChangePct) : 0;
  const priceChangeTone =
    !hasPriceChangePct || numericPriceChangePct === 0
      ? 'text-base-content/70'
      : numericPriceChangePct > 0
        ? 'text-success'
        : 'text-error';
  const isPriceLoading = isLegacyDetailLoading || isInstrumentDetailLoading;
  const isChartLoading = isKlineLoading && chartCandles.length === 0;
  const shouldShowHeaderSkeleton = (isLegacyDetailLoading || isInstrumentDetailLoading) && !detail && !providerDetail;
  const chartColor = useMemo(
    () => resolveThemeColor('--color-base-content', resolvedTheme === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)'),
    [resolvedTheme],
  );

  async function switchKlinePeriod(nextPeriod: KlinePeriod): Promise<void> {
    if (nextPeriod === klinePeriod || pendingKlinePeriod) return;
    setPendingKlinePeriod(nextPeriod);
    try {
      await queryClient.fetchQuery({
        queryKey: ['trade-token-kline', normalizedChain, normalizedContract, activeInstrumentId, nextPeriod],
        queryFn: () => {
          if (activeInstrumentId) {
            return getMarketCandlesByInstrumentId(activeInstrumentId, nextPeriod, 60);
          }
          return getTokenKline(normalizedChain, normalizedContract, nextPeriod, 60);
        },
        staleTime: 20_000,
      });
      setKlinePeriod(nextPeriod);
    } finally {
      setPendingKlinePeriod(null);
    }
  }

  async function toggleWatchlist(): Promise<void> {
    if (isWatchlistToggling) return;
    setIsWatchlistToggling(true);
    try {
      if (isInWatchlist) {
        await removeMarketWatchlistAsset({
          chain: normalizedChain,
          contract: normalizedContract,
        });
        showSuccess(t('trade.watchRemoved'));
      } else {
        await addMarketWatchlistAsset({
          watchType: 'crypto',
          itemId: `${normalizedChain}:${normalizedContract}`,
          chain: normalizedChain,
          contract: normalizedContract,
          symbol: (providerDetail?.symbol ?? detail?.symbol ?? routePreview?.symbol ?? '').trim() || undefined,
          name: (providerDetail?.name ?? detail?.name ?? routePreview?.name ?? '').trim() || undefined,
          image: displayImage,
          source: 'token_detail',
          change24h: priceChangePct ?? null,
        });
        ingestAgentEvent('asset_favorited', {
          asset: (providerDetail?.symbol ?? detail?.symbol ?? routePreview?.symbol)?.toUpperCase(),
          itemId: activeInstrumentId ?? undefined,
          chain: normalizedChain,
          contract: normalizedContract,
          source: 'trade_detail',
        }).catch(() => undefined);
        showSuccess(t('trade.watchAdded'));
      }
      await queryClient.invalidateQueries({ queryKey: ['market-watchlist'] });
    } catch (error) {
      showError(`${t('common.error')}: ${(error as Error).message}`);
    } finally {
      setIsWatchlistToggling(false);
    }
  }

  function openTrade(mode: 'buy' | 'sell'): void {
    if (!tradeChainId || !tradeTokenConfig || !canTradeToken) {
      showError(t('wallet.tradeChainNotSupported'));
      return;
    }

    const tokenPreset = {
      address: tradeContract,
      symbol: displaySymbol || t('wallet.token'),
    };
    const preset: TradePreset =
      mode === 'buy'
        ? {
            mode: 'buy',
            chainId: tradeChainId,
            sellToken: cloneTradeToken(tradeTokenConfig.usdc),
            buyToken: tokenPreset,
            assetSymbolForEvent: displaySymbol || undefined,
          }
        : {
            mode: 'sell',
            chainId: tradeChainId,
            sellToken: tokenPreset,
            buyToken: cloneTradeToken(tradeTokenConfig.usdc),
            assetSymbolForEvent: displaySymbol || undefined,
          };

    setTradePreset(preset);
    setIsTradeModalOpen(true);
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-5 pb-44">
      <header className="mt-4 flex items-center justify-between gap-3">
        <button
          type="button"
          className="btn btn-sm btn-ghost border-0 px-2"
          onClick={onBack}
          aria-label={t('trade.backToList')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          className={`btn btn-sm border-0 px-3 ${isInWatchlist ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => void toggleWatchlist()}
          disabled={isWatchlistToggling}
        >
          {isWatchlistToggling ? (
            <span className="loading loading-spinner loading-xs" />
          ) : isInWatchlist ? (
            t('trade.watching')
          ) : (
            t('trade.watch')
          )}
        </button>
      </header>

      <section className="p-0">
        {shouldShowHeaderSkeleton ? (
          <div>
            <div className="flex flex-col items-start gap-3">
              <SkeletonBlock className="h-12 w-12 rounded-full" />
              <div className="min-w-0">
                <SkeletonBlock className="h-5 w-48" />
                <SkeletonBlock className="mt-2 h-4 w-20" />
              </div>
            </div>
            <div className="mt-4">
              <SkeletonBlock className="h-9 w-44" />
              <SkeletonBlock className="mt-2 h-4 w-24" />
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col items-start gap-3">
              {displayImage ? (
                <CachedIconImage
                  src={displayImage}
                  alt={displaySymbol || displayName}
                  className="h-12 w-12 rounded-full bg-base-300 object-cover"
                  loading="lazy"
                  fallback={(
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-base-300 text-lg font-semibold text-base-content/70">
                      {getTokenInitial(displaySymbol, displayName)}
                    </div>
                  )}
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-base-300 text-lg font-semibold text-base-content/70">
                  {getTokenInitial(displaySymbol, displayName)}
                </div>
              )}
              <div className="min-w-0">
                <p className="m-0 flex items-baseline gap-2">
                  <span className="truncate text-lg font-bold text-base-content/75">{displayName}</span>
                  {displaySymbol && <span className="text-sm font-medium uppercase text-base-content/50">{displaySymbol}</span>}
                </p>
              </div>
            </div>
            <div className="mt-4">
              <p className="m-0 text-3xl font-bold">
                {isPriceLoading
                  ? Number.isFinite(Number(routePreview?.current_price))
                    ? formatUsdAdaptive(Number(routePreview?.current_price), i18n.language)
                    : t('trade.priceUnavailable')
                  : Number.isFinite(Number(providerDetail?.currentPriceUsd))
                    ? formatUsdAdaptive(Number(providerDetail?.currentPriceUsd), i18n.language)
                    : Number.isFinite(Number(providerDetail?.currentPrice))
                      ? formatUsdAdaptive(Number(providerDetail?.currentPrice), i18n.language)
                      : detail?.currentPriceUsd != null && Number.isFinite(detail.currentPriceUsd)
                        ? formatUsdAdaptive(detail.currentPriceUsd, i18n.language)
                        : t('trade.priceUnavailable')}
              </p>
              <p className={`m-0 mt-1 flex items-center gap-1 text-base font-medium ${priceChangeTone}`}>
                <span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center">
                  {hasPriceChangePct && numericPriceChangePct > 0 ? (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 19V5" />
                      <path d="M6 11l6-6 6 6" />
                    </svg>
                  ) : hasPriceChangePct && numericPriceChangePct < 0 ? (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 5v14" />
                      <path d="M18 13l-6 6-6-6" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14" />
                      <path d="M15 8l4 4-4 4" />
                    </svg>
                  )}
                </span>
                <span>{formatPct(priceChangePct)}</span>
              </p>
            </div>
          </>
        )}
      </section>

      <section className="p-0">
        <div className="mt-3 flex flex-wrap gap-2">
          {KLINE_PERIOD_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`btn btn-xs border-0 px-3 ${klinePeriod === option.value ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => void switchKlinePeriod(option.value)}
              disabled={pendingKlinePeriod != null}
            >
              {pendingKlinePeriod === option.value ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                t(option.labelKey)
              )}
            </button>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className={`btn btn-xs border-0 px-3 ${chartMode === 'line' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setChartMode('line')}
          >
            line
          </button>
          <button
            type="button"
            className={`btn btn-xs border-0 px-3 ${chartMode === 'candle' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setChartMode('candle')}
          >
            candle
          </button>
        </div>
        {isChartLoading ? (
          <div className="mt-3">
            <div className="h-72 overflow-hidden rounded-lg bg-base-200/30 px-2 py-2">
              <svg viewBox="0 0 640 220" className="h-full w-full" role="img" aria-label={t('trade.loadingKline')}>
                <defs>
                  <linearGradient id="loading-kline-line" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="currentColor" stopOpacity="0.3" />
                    <stop offset="50%" stopColor="currentColor" stopOpacity="0.9" />
                    <stop offset="100%" stopColor="currentColor" stopOpacity="0.3" />
                  </linearGradient>
                </defs>
                <line
                  x1="24"
                  y1="110"
                  x2="616"
                  y2="110"
                  stroke="url(#loading-kline-line)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  className="text-base-content/70"
                />
              </svg>
            </div>
          </div>
        ) : chartCandles.length === 0 ? (
          <p className="m-0 mt-3 text-sm text-base-content/60">{t('trade.noKline')}</p>
        ) : (
          <div className="mt-2 h-72 overflow-hidden p-0">
            <Liveline
              mode="candle"
              data={chartLine}
              value={latestChartValue}
              candles={chartCandles}
              candleWidth={candleWidth}
              liveCandle={chartCandles[chartCandles.length - 1]}
              lineMode={chartMode === 'line'}
              lineData={chartLine}
              lineValue={latestChartValue}
              theme={resolvedTheme}
              color={chartColor}
              badge={false}
              window={chartWindow}
              formatValue={(value) => formatUsdAdaptive(value, i18n.language)}
              formatTime={() => ''}
              grid={false}
              scrub
              padding={{ top: 6, right: 6, bottom: 6, left: 6 }}
            />
          </div>
        )}
      </section>

      <section className="p-0">
        <h2 className="m-0 text-lg font-bold">{t('trade.tokenInfo')}</h2>
        {(isLegacyDetailLoading || isInstrumentDetailLoading) && !detail && !providerDetail ? (
          <div className="mt-3 grid grid-cols-2 gap-3">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={`token-info-skeleton-${index}`} className="rounded bg-base-200/40 p-2">
                <SkeletonBlock className="h-3 w-16" />
                <SkeletonBlock className="mt-2 h-4 w-20" />
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.chain')}</p>
              <p className="m-0 mt-1 font-medium">{displayChain || '--'}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.contract')}</p>
              <p className="m-0 mt-1 truncate font-medium">{displayContract || t('trade.nativeToken')}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.marketCap')}</p>
              <p className="m-0 mt-1 font-medium">{formatCompact(routePreview?.market_cap, i18n.language)}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.turnover24h')}</p>
              <p className="m-0 mt-1 font-medium">{formatCompact(routePreview?.turnover_24h, i18n.language)}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.holders')}</p>
              <p className="m-0 mt-1 font-medium">{formatCompact(providerDetail?.holders ?? detail?.holders, i18n.language)}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.liquidity')}</p>
              <p className="m-0 mt-1 font-medium">{formatCompact(providerDetail?.liquidityUsd ?? detail?.liquidityUsd, i18n.language)}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.top10HolderPercent')}</p>
              <p className="m-0 mt-1 font-medium">{formatPercentFromRatio(providerDetail?.top10HolderPercent ?? detail?.top10HolderPercent)}</p>
            </div>
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.lockLpPercent')}</p>
              <p className="m-0 mt-1 font-medium">{formatPercentFromRatio(providerDetail?.lockLpPercent ?? detail?.lockLpPercent)}</p>
            </div>
          </div>
        )}
      </section>

      <div className="fixed bottom-5 left-1/2 z-30 w-full max-w-105 -translate-x-1/2 px-5">
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            className="btn btn-success border-0"
            onClick={() => openTrade('buy')}
          >
            {t('trade.buy')}
          </button>
          <button
            type="button"
            className="btn btn-error border-0"
            onClick={() => openTrade('sell')}
          >
            {t('trade.sell')}
          </button>
        </div>
      </div>
      {isTradeModalOpen && tradePreset ? (
        <Modal visible originRect={null} onClose={() => setIsTradeModalOpen(false)}>
          <TradeContent
            active={isTradeModalOpen}
            preset={tradePreset}
            supportedChains={appConfig?.supportedChains ?? []}
            onBack={() => setIsTradeModalOpen(false)}
            onClose={() => setIsTradeModalOpen(false)}
          />
        </Modal>
      ) : null}
    </section>
  );
}
