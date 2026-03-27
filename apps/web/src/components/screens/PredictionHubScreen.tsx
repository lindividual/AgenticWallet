import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getPredictionAccount, getTradeBrowse, type TradeBrowsePredictionItem } from '../../api';
import { CachedIconImage } from '../CachedIconImage';
import { SkeletonBlock } from '../Skeleton';
import { formatUsdAdaptive } from '../../utils/currency';

type PredictionHubScreenProps = {
  onBack: () => void;
  onOpenIntro: () => void;
  onOpenMarketDetail: (itemId: string) => void;
};

function formatCompactUsd(value: number | null | undefined, locale: string): string {
  if (!Number.isFinite(Number(value))) return '--';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    notation: Math.abs(Number(value)) >= 1_000_000 ? 'compact' : 'standard',
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function getInitial(label: string): string {
  const normalized = label.trim();
  return normalized ? normalized[0].toUpperCase() : '?';
}

function PredictionListRow({
  market,
  locale,
  probabilityLabel,
  onOpen,
}: {
  market: TradeBrowsePredictionItem;
  locale: string;
  probabilityLabel: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-start justify-between gap-3 border-0 border-b border-base-content/10 bg-transparent px-4 py-4 text-left transition-colors last:border-b-0 hover:bg-base-200/60"
      onClick={onOpen}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="shrink-0">
          {market.image ? (
            <CachedIconImage
              src={market.image}
              alt={market.title}
              className="h-11 w-11 rounded-full bg-base-300 object-cover"
              loading="lazy"
              fallback={(
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-base-300 text-sm font-semibold text-base-content/70">
                  {getInitial(market.title)}
                </div>
              )}
            />
          ) : (
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-base-300 text-sm font-semibold text-base-content/70">
              {getInitial(market.title)}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="m-0 line-clamp-2 text-sm font-semibold leading-6">{market.title}</p>
          {market.description ? (
            <p className="m-0 mt-1 line-clamp-2 text-xs leading-5 text-base-content/55">
              {market.description}
            </p>
          ) : null}
          <p className="m-0 mt-2 text-xs text-base-content/55">
            {`${formatCompactUsd(market.volume24h, locale)} ${market.source.toUpperCase()}`}
          </p>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <p className="m-0 rounded-full bg-success/15 px-2 py-0.5 text-sm font-semibold text-success">
          {market.probability != null ? `${market.probability.toFixed(1)}%` : '--'}
        </p>
        <p className="m-0 mt-1 text-xs text-base-content/55">{probabilityLabel}</p>
      </div>
    </button>
  );
}

export function PredictionHubScreen({ onBack, onOpenIntro, onOpenMarketDetail }: PredictionHubScreenProps) {
  const { t, i18n } = useTranslation();

  const {
    data: predictionAccount,
    isFetching: isPredictionAccountFetching,
  } = useQuery({
    queryKey: ['prediction-account', 'eoa'],
    queryFn: () => getPredictionAccount({ signatureType: 'eoa' }),
    staleTime: 15_000,
    refetchInterval: 20_000,
  });

  const {
    data: tradeBrowseData,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['trade-browse'],
    queryFn: getTradeBrowse,
    staleTime: 60_000,
    refetchInterval: 90_000,
  });

  const isActivated = predictionAccount?.activationState === 'active';
  const hotEvents = (tradeBrowseData?.predictions ?? []).filter((item) => item.id.trim().length > 0).slice(0, 8);

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-5 pb-44">
      <header className="mt-4 flex items-center justify-between gap-3">
        <button
          type="button"
          className="btn btn-sm btn-ghost border-0 px-2"
          onClick={onBack}
          aria-label={t('wallet.back')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        {!isActivated ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={onOpenIntro}>
            {t('wallet.predictionLearnMore')}
          </button>
        ) : (
          <span className="rounded-full bg-success/15 px-3 py-1 text-xs font-semibold text-success">
            {t('wallet.predictionAccountActiveBadge')}
          </span>
        )}
      </header>

      <section className="overflow-hidden rounded-[2rem] border border-base-300 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.15),transparent_45%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.12),transparent_50%)] bg-base-100 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="m-0 text-3xl font-bold tracking-tight">{t('wallet.predictionHubTitle')}</h1>
            <p className="m-0 mt-3 text-sm leading-7 text-base-content/68">
              {t('wallet.predictionHubSubtitle')}
            </p>
          </div>
          {isPredictionAccountFetching ? <span className="loading loading-spinner loading-sm" /> : null}
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-base-300/80 bg-base-100/75 p-3">
            <p className="m-0 text-xs text-base-content/55">{t('wallet.predictionBalance')}</p>
            <p className="m-0 mt-1 text-base font-semibold tabular-nums">
              {isActivated && Number.isFinite(Number(predictionAccount?.balanceUsd))
                ? formatUsdAdaptive(Number(predictionAccount?.balanceUsd ?? 0), i18n.language)
                : t('wallet.accountUnavailableValue')}
            </p>
          </div>
          <div className="rounded-2xl border border-base-300/80 bg-base-100/75 p-3">
            <p className="m-0 text-xs text-base-content/55">{t('wallet.predictionHotEvents')}</p>
            <p className="m-0 mt-1 text-base font-semibold tabular-nums">{hotEvents.length}</p>
          </div>
        </div>

        {!isActivated ? (
          <div className="mt-4 rounded-2xl border border-warning/20 bg-warning/10 p-3 text-sm leading-7 text-base-content/75">
            {t('trade.predictionActivationRequired')}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <div>
          <h2 className="m-0 text-lg font-semibold">{t('wallet.predictionHotEvents')}</h2>
          <p className="m-0 mt-1 text-sm text-base-content/60">{t('wallet.predictionHotEventsHint')}</p>
        </div>

        <div className="overflow-hidden rounded-3xl bg-base-200/35">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="border-b border-base-content/10 px-4 py-4 last:border-b-0">
                <div className="flex items-start gap-3">
                  <SkeletonBlock className="h-11 w-11 rounded-full" />
                  <div className="min-w-0 flex-1">
                    <SkeletonBlock className="h-4 w-4/5" />
                    <SkeletonBlock className="mt-2 h-3 w-full" />
                    <SkeletonBlock className="mt-2 h-3 w-2/3" />
                  </div>
                  <SkeletonBlock className="h-6 w-14 rounded-full" />
                </div>
              </div>
            ))
          ) : isError ? (
            <div className="px-4 py-5 text-sm text-base-content/65">{t('trade.loadFailed')}</div>
          ) : hotEvents.length === 0 ? (
            <div className="px-4 py-5 text-sm text-base-content/65">{t('wallet.predictionHotEventsEmpty')}</div>
          ) : (
            hotEvents.map((market) => (
              <PredictionListRow
                key={market.id}
                market={market}
                locale={i18n.language}
                probabilityLabel={t('trade.probability')}
                onOpen={() => onOpenMarketDetail(market.id)}
              />
            ))
          )}
        </div>
      </section>
    </section>
  );
}
