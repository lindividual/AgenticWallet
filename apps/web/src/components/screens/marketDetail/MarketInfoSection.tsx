import { useTranslation } from 'react-i18next';
import { SkeletonBlock } from '../../Skeleton';

function formatCompact(value: number | null | undefined, locale: string): string {
  if (!Number.isFinite(Number(value))) return '--';
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function formatPct(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(2)}%`;
}

function formatProbability(probability: number | null | undefined): string {
  if (!Number.isFinite(Number(probability))) return '--';
  return `${Number(probability).toFixed(1)}%`;
}

type MarketInfoSectionProps = {
  isLoading: boolean;
  normalizedType: 'stock' | 'perp' | 'prediction';
  displaySource: string | null;
  normalizedItemId: string;
  displayVolume24h: number | null;
  displayProbability: number | null;
  displayMetaLabel: string | null;
  displayMetaValue: number | null;
  displayChange24h: number | null;
  displayContract: string | null;
  displayChain: string | null;
  locale: string;
};

export function MarketInfoSection({
  isLoading,
  normalizedType,
  displaySource,
  normalizedItemId,
  displayVolume24h,
  displayProbability,
  displayMetaLabel,
  displayMetaValue,
  displayChange24h,
  displayContract,
  displayChain,
  locale,
}: MarketInfoSectionProps) {
  const { t } = useTranslation();

  return (
    <section className="p-0">
      <h2 className="m-0 text-lg font-bold">{t('trade.marketInfo')}</h2>
      {isLoading ? (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={`market-info-skeleton-${index}`} className="rounded bg-base-200/40 p-2">
              <SkeletonBlock className="h-3 w-16" />
              <SkeletonBlock className="mt-2 h-4 w-20" />
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded bg-base-200/40 p-2">
            <p className="m-0 text-xs text-base-content/60">{t('trade.marketType')}</p>
            <p className="m-0 mt-1 font-medium">
              {normalizedType === 'stock'
                ? t('trade.stocks')
                : normalizedType === 'perp'
                  ? t('trade.perps')
                  : t('trade.prediction')}
            </p>
          </div>
          <div className="rounded bg-base-200/40 p-2">
            <p className="m-0 text-xs text-base-content/60">{t('trade.dataSource')}</p>
            <p className="m-0 mt-1 font-medium uppercase">{displaySource ?? '--'}</p>
          </div>
          <div className="rounded bg-base-200/40 p-2">
            <p className="m-0 text-xs text-base-content/60">{t('trade.itemId')}</p>
            <p className="m-0 mt-1 truncate font-medium">{normalizedItemId || '--'}</p>
          </div>
          <div className="rounded bg-base-200/40 p-2">
            <p className="m-0 text-xs text-base-content/60">{t('trade.turnover24h')}</p>
            <p className="m-0 mt-1 font-medium">{formatCompact(displayVolume24h, locale)}</p>
          </div>
          {normalizedType === 'prediction' ? (
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{t('trade.probability')}</p>
              <p className="m-0 mt-1 font-medium">{formatProbability(displayProbability)}</p>
            </div>
          ) : (
            <div className="rounded bg-base-200/40 p-2">
              <p className="m-0 text-xs text-base-content/60">{displayMetaLabel ?? t('trade.change24h')}</p>
              <p className="m-0 mt-1 font-medium">
                {displayMetaValue != null ? formatCompact(displayMetaValue, locale) : formatPct(displayChange24h)}
              </p>
            </div>
          )}
          <div className="rounded bg-base-200/40 p-2">
            <p className="m-0 text-xs text-base-content/60">{t('trade.contract')}</p>
            <p className="m-0 mt-1 truncate font-medium">
              {displayContract ?? displayChain ?? '--'}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
