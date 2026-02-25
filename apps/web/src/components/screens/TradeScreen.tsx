import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getCoinDetail, getTopMarketAssetsBySupportedChains, type TopMarketAsset } from '../../api';
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

function getTokenInitial(token: TopMarketAsset): string {
  const label = (token.symbol ?? token.name ?? '').trim();
  return label ? label[0].toUpperCase() : '?';
}

export function TradeScreen() {
  const { t, i18n } = useTranslation();
  const [selected, setSelected] = useState<TopMarketAsset | null>(null);

  const {
    data: assetsData,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['trade-top-tokens'],
    queryFn: () => getTopMarketAssetsBySupportedChains(30, ['ethereum', 'binance-smart-chain', 'base']),
    staleTime: 60_000,
    refetchInterval: 90_000,
  });

  const {
    data: detail,
    isLoading: isDetailLoading,
    refetch: refetchDetail,
    isFetching: isDetailFetching,
  } = useQuery({
    queryKey: ['trade-token-detail', selected?.id],
    queryFn: () => getCoinDetail((selected as TopMarketAsset).id),
    enabled: Boolean(selected),
    staleTime: 15_000,
    refetchInterval: 20_000,
  });

  const tokens = useMemo(() => assetsData ?? [], [assetsData]);

  if (selected) {
    return (
      <section className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-5 pb-28">
        <header className="mt-4 flex items-center justify-between">
          <button type="button" className="btn btn-sm btn-outline px-3" onClick={() => setSelected(null)}>
            {t('trade.backToList')}
          </button>
          <h1 className="m-0 text-xl font-bold tracking-tight">{t('trade.detailTitle')}</h1>
        </header>

        <section className="border border-base-300 bg-base-100 p-4">
          <div className="flex items-center gap-3">
            {(detail?.image ?? selected.image) ? (
              <img
                src={detail?.image ?? selected.image}
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
                {(detail?.symbol ?? selected.symbol).toUpperCase()} · #{selected.market_cap_rank ?? '--'}
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
              className="btn btn-sm btn-outline px-3"
              onClick={() => void refetchDetail()}
              disabled={isDetailFetching}
            >
              {isDetailFetching ? t('trade.refreshing') : t('trade.refreshPrice')}
            </button>
          </div>
        </section>

        <section className="border border-base-300 bg-base-100 p-4">
          <h2 className="m-0 text-lg font-bold">{t('trade.aboutAsset')}</h2>
          {isDetailLoading ? (
            <p className="m-0 mt-3 text-sm text-base-content/60">{t('trade.loadingDetail')}</p>
          ) : detail?.description ? (
            <p className="m-0 mt-3 text-sm leading-6 text-base-content/80">
              {detail?.description}
            </p>
          ) : (
            <p className="m-0 mt-3 text-sm text-base-content/60">{t('trade.noDescription')}</p>
          )}
          {detail?.homepage ? (
            <a
              className="mt-3 inline-block text-sm underline"
              href={detail.homepage}
              target="_blank"
              rel="noreferrer"
            >
              {t('trade.visitWebsite')}
            </a>
          ) : null}
        </section>
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
          className="btn btn-sm btn-outline px-3"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          {isFetching ? t('trade.refreshing') : t('trade.refresh')}
        </button>
      </div>

      {isLoading && <div className="border border-base-300 bg-base-100 p-4">{t('trade.loadingAssets')}</div>}
      {isError && (
        <div className="border border-error bg-error/10 p-4 text-error">
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
            className="w-full cursor-pointer border border-base-300 px-3 text-left transition-colors hover:bg-base-200"
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
              rightPrimary={formatUsd(token.current_price ?? 0, i18n.language)}
              rightSecondary={`${formatPct(token.price_change_percentage_24h)} · #${token.market_cap_rank ?? '--'}`}
            />
          </button>
        ))}
      </section>
    </section>
  );
}
