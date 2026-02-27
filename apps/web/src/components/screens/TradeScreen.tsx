import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Liveline } from 'liveline';
import type { CandlePoint, LivelinePoint } from 'liveline';
import {
  getCoinDetail,
  getTokenKline,
  getTopMarketAssets,
  type KlinePeriod,
  type TopMarketAsset,
} from '../../api';
import { AssetListItem } from '../AssetListItem';

function formatUsd(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

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

function getTokenInitial(token: TopMarketAsset): string {
  const label = (token.symbol ?? token.name ?? '').trim();
  return label ? label[0].toUpperCase() : '?';
}

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

function formatRiskLabel(rawRisk: string | null | undefined, t: (key: string) => unknown): string {
  if (!rawRisk) return '--';
  const normalized = rawRisk.trim().toLowerCase();
  if (normalized === 'low') return String(t('trade.riskLow'));
  if (normalized === 'medium') return String(t('trade.riskMedium'));
  if (normalized === 'high') return String(t('trade.riskHigh'));
  return normalized.toUpperCase();
}

export function TradeScreen() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<TopMarketAsset | null>(null);
  const [klinePeriod, setKlinePeriod] = useState<KlinePeriod>('1h');
  const [pendingKlinePeriod, setPendingKlinePeriod] = useState<KlinePeriod | null>(null);

  const {
    data: assetsData,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['trade-top-tokens'],
    queryFn: () =>
      getTopMarketAssets({
        limit: 30,
        name: 'topGainers',
        chains: ['eth', 'bnb', 'base'],
      }),
    staleTime: 60_000,
    refetchInterval: 90_000,
  });

  const {
    data: detail,
    isLoading: isDetailLoading,
    refetch: refetchDetail,
    isFetching: isDetailFetching,
  } = useQuery({
    queryKey: ['trade-token-detail', selected?.chain, selected?.contract],
    queryFn: () => getCoinDetail((selected as TopMarketAsset).chain, (selected as TopMarketAsset).contract),
    enabled: Boolean(selected),
    staleTime: 15_000,
    refetchInterval: 20_000,
  });

  const {
    data: klineData,
    isLoading: isKlineLoading,
    refetch: refetchKline,
    isFetching: isKlineFetching,
  } = useQuery({
    queryKey: ['trade-token-kline', selected?.chain, selected?.contract, klinePeriod],
    queryFn: () =>
      getTokenKline((selected as TopMarketAsset).chain, (selected as TopMarketAsset).contract, klinePeriod, 60),
    enabled: Boolean(selected),
    placeholderData: (previous) => previous,
    staleTime: 20_000,
    refetchInterval: 30_000,
  });

  const tokens = useMemo(() => assetsData ?? [], [assetsData]);
  const chartCandles = useMemo<CandlePoint[]>(
    () =>
      (klineData ?? []).map((item) => ({
        time: item.time,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
      })),
    [klineData],
  );
  const chartLine = useMemo<LivelinePoint[]>(
    () =>
      chartCandles.map((item) => ({
        time: item.time,
        value: item.close,
      })),
    [chartCandles],
  );
  const latestChartValue =
    chartLine.length > 0
      ? chartLine[chartLine.length - 1].value
      : detail?.currentPriceUsd ?? selected?.current_price ?? 0;

  async function switchKlinePeriod(nextPeriod: KlinePeriod): Promise<void> {
    if (!selected || nextPeriod === klinePeriod || pendingKlinePeriod) return;
    setPendingKlinePeriod(nextPeriod);
    try {
      await queryClient.fetchQuery({
        queryKey: ['trade-token-kline', selected.chain, selected.contract, nextPeriod],
        queryFn: () => getTokenKline(selected.chain, selected.contract, nextPeriod, 60),
        staleTime: 20_000,
      });
      setKlinePeriod(nextPeriod);
    } finally {
      setPendingKlinePeriod(null);
    }
  }

  if (selected) {
    const displayContract = (detail?.contract ?? selected.contract).trim();
    const displayChain = (detail?.chain ?? selected.chain).trim().toUpperCase();
    const candleWidth = KLINE_CANDLE_WIDTH_SECONDS[klinePeriod];
    const chartWindow = Math.max(candleWidth * Math.min(chartCandles.length || 30, 60), candleWidth * 10);

    return (
      <section className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-5 pb-44">
        <header className="mt-4 flex items-center justify-between">
          <button type="button" className="btn btn-sm btn-ghost border-0 px-3" onClick={() => setSelected(null)}>
            {t('trade.backToList')}
          </button>
          <h1 className="m-0 text-xl font-bold tracking-tight">{t('trade.detailTitle')}</h1>
        </header>

        <section className="p-0">
          <div className="flex items-center gap-3">
            {selected.image ? (
              <img
                src={selected.image ?? ''}
                alt={detail?.symbol ?? selected.symbol}
                className="h-12 w-12 rounded-full bg-base-300 object-cover"
                loading="lazy"
              />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-base-300 text-lg font-semibold text-base-content/70">
                {getTokenInitial(selected)}
              </div>
            )}
            <div className="min-w-0">
              <p className="m-0 truncate text-lg font-bold">{detail?.name ?? selected.name}</p>
              <p className="m-0 truncate text-sm text-base-content/60">
                {(detail?.symbol ?? selected.symbol).toUpperCase()} · {displayChain}
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-end justify-between gap-3">
            <div>
              <p className="m-0 text-sm text-base-content/60">{t('trade.currentPrice')}</p>
              <p className="m-0 text-2xl font-bold">
                {detail?.currentPriceUsd != null && Number.isFinite(detail.currentPriceUsd)
                  ? formatUsd(detail.currentPriceUsd, i18n.language)
                  : t('trade.priceUnavailable')}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-ghost border-0 px-3"
              onClick={() => void refetchDetail()}
              disabled={isDetailFetching}
            >
              {isDetailFetching ? t('trade.refreshing') : t('trade.refreshPrice')}
            </button>
          </div>
          <p className="m-0 mt-2 text-xs text-base-content/60">
            {t('trade.riskLevel')}: {formatRiskLabel(selected.risk_level, t)}
          </p>
        </section>

        <section className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 text-lg font-bold">{t('trade.klineTitle')}</h2>
            <button
              type="button"
              className="btn btn-sm btn-ghost border-0 px-3"
              onClick={() => void refetchKline()}
              disabled={isKlineFetching || pendingKlinePeriod != null}
            >
              {isKlineFetching ? t('trade.refreshing') : t('trade.refreshKline')}
            </button>
          </div>
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
          {isKlineLoading && chartCandles.length === 0 ? (
            <p className="m-0 mt-3 text-sm text-base-content/60">{t('trade.loadingKline')}</p>
          ) : chartCandles.length === 0 ? (
            <p className="m-0 mt-3 text-sm text-base-content/60">{t('trade.noKline')}</p>
          ) : (
            <div className="mt-3 h-72 overflow-hidden rounded bg-base-200/40 p-2">
              <Liveline
                mode="candle"
                data={chartLine}
                value={latestChartValue}
                candles={chartCandles}
                candleWidth={candleWidth}
                liveCandle={chartCandles[chartCandles.length - 1]}
                theme="light"
                color="#3b82f6"
                window={chartWindow}
                formatValue={(value) => formatUsd(value, i18n.language)}
                grid
                scrub
              />
            </div>
          )}
        </section>

        <section className="p-0">
          <h2 className="m-0 text-lg font-bold">{t('trade.tokenInfo')}</h2>
          {isDetailLoading ? (
            <p className="m-0 mt-3 text-sm text-base-content/60">{t('trade.loadingDetail')}</p>
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
                <p className="m-0 mt-1 font-medium">{formatCompact(selected.market_cap, i18n.language)}</p>
              </div>
              <div className="rounded bg-base-200/40 p-2">
                <p className="m-0 text-xs text-base-content/60">{t('trade.turnover24h')}</p>
                <p className="m-0 mt-1 font-medium">{formatCompact(selected.turnover_24h, i18n.language)}</p>
              </div>
              <div className="rounded bg-base-200/40 p-2">
                <p className="m-0 text-xs text-base-content/60">{t('trade.holders')}</p>
                <p className="m-0 mt-1 font-medium">{formatCompact(detail?.holders, i18n.language)}</p>
              </div>
              <div className="rounded bg-base-200/40 p-2">
                <p className="m-0 text-xs text-base-content/60">{t('trade.liquidity')}</p>
                <p className="m-0 mt-1 font-medium">{formatCompact(detail?.liquidityUsd, i18n.language)}</p>
              </div>
              <div className="rounded bg-base-200/40 p-2">
                <p className="m-0 text-xs text-base-content/60">{t('trade.top10HolderPercent')}</p>
                <p className="m-0 mt-1 font-medium">{formatPercentFromRatio(detail?.top10HolderPercent)}</p>
              </div>
              <div className="rounded bg-base-200/40 p-2">
                <p className="m-0 text-xs text-base-content/60">{t('trade.lockLpPercent')}</p>
                <p className="m-0 mt-1 font-medium">{formatPercentFromRatio(detail?.lockLpPercent)}</p>
              </div>
            </div>
          )}
        </section>

        <div className="fixed bottom-20 left-1/2 z-30 w-full max-w-105 -translate-x-1/2 px-5">
          <div className="grid grid-cols-2 gap-3">
            <button type="button" className="btn btn-success border-0">
              {t('trade.buy')}
            </button>
            <button type="button" className="btn btn-error border-0">
              {t('trade.sell')}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-5 pb-28">
      <header className="mt-4">
        <h1 className="m-0 text-2xl font-bold tracking-tight">{t('trade.title')}</h1>
        <p className="m-0 mt-2 text-sm text-base-content/60">{t('trade.subtitle')}</p>
      </header>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-sm btn-ghost border-0 px-3"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          {isFetching ? t('trade.refreshing') : t('trade.refresh')}
        </button>
      </div>

      {isLoading && <div className="bg-base-100 p-4">{t('trade.loadingAssets')}</div>}
      {isError && (
        <div className="bg-error/10 p-4 text-error">
          {t('trade.loadFailed', { message: (error as Error).message })}
        </div>
      )}
      {!isLoading && !isError && tokens.length === 0 && (
        <div className="bg-base-200 p-4 text-sm">{t('trade.empty')}</div>
      )}

      <section className="flex flex-col gap-2">
        {tokens.map((token) => (
          <button
            key={token.id}
            type="button"
            className="w-full cursor-pointer px-3 text-left transition-colors hover:bg-base-200/60"
            onClick={() => setSelected(token)}
          >
            <AssetListItem
              className="py-3"
              leftIcon={
                token.image ? (
                  <img
                    src={token.image}
                    alt={token.symbol}
                    className="h-10 w-10 rounded-full bg-base-300 object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-base-300 text-base font-semibold text-base-content/70">
                    {getTokenInitial(token)}
                  </div>
                )
              }
              leftPrimary={token.symbol.toUpperCase()}
              leftSecondary={token.name ?? t('trade.unknownAsset')}
              rightPrimary={
                token.current_price != null
                  ? formatUsd(token.current_price, i18n.language)
                  : t('trade.priceUnavailable')
              }
              rightSecondary={`${formatPct(token.price_change_percentage_24h)} · ${token.chain.toUpperCase()}`}
            />
          </button>
        ))}
      </section>
    </section>
  );
}
