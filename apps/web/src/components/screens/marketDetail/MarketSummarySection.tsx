import { useTranslation } from 'react-i18next';
import { formatUsdAdaptive } from '../../../utils/currency';
import { CachedIconImage } from '../../CachedIconImage';
import { SkeletonBlock } from '../../Skeleton';

function getLabelInitial(symbol: string | null | undefined, name: string | null | undefined): string {
  const label = (symbol ?? name ?? '').trim();
  return label ? label[0].toUpperCase() : '?';
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

function ChangeTriangle({ direction }: { direction: 'up' | 'down' | 'flat' }) {
  const rotationClass = direction === 'up' ? '' : direction === 'down' ? 'rotate-180' : 'rotate-90';

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 10 10"
      className={`h-2.5 w-2.5 ${rotationClass}`}
      fill="currentColor"
    >
      <path d="M5 1.5 8.5 7.5h-7Z" />
    </svg>
  );
}

type MarketSummarySectionProps = {
  isLoading: boolean;
  displayImage: string | null;
  displayName: string;
  displaySymbol: string;
  normalizedType: 'perp' | 'prediction';
  displayPrice: number | null;
  displayProbability: number | null;
  displayChange24h: number | null;
};

export function MarketSummarySection({
  isLoading,
  displayImage,
  displayName,
  displaySymbol,
  normalizedType,
  displayPrice,
  displayProbability,
  displayChange24h,
}: MarketSummarySectionProps) {
  const { t, i18n } = useTranslation();
  const hasPrimaryValue = normalizedType === 'prediction'
    ? Number.isFinite(Number(displayProbability))
    : Number.isFinite(Number(displayPrice));
  const hasChangeValue = Number.isFinite(Number(displayChange24h));
  const numericChange = hasChangeValue ? Number(displayChange24h) : 0;
  const changeTone =
    !hasChangeValue || numericChange === 0
      ? 'text-base-content/70'
      : numericChange > 0
        ? 'text-success'
        : 'text-error';

  return (
    <section className="p-0">
      {isLoading ? (
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
                    {getLabelInitial(displaySymbol, displayName)}
                  </div>
                )}
              />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-base-300 text-lg font-semibold text-base-content/70">
                {getLabelInitial(displaySymbol, displayName)}
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
              {hasPrimaryValue
                ? normalizedType === 'prediction'
                  ? formatProbability(displayProbability)
                  : formatUsdAdaptive(Number(displayPrice), i18n.language)
                : t('trade.priceUnavailable')}
            </p>
            {normalizedType === 'prediction' ? (
              <p className="m-0 mt-1 text-base font-medium text-base-content/70">{t('trade.probability')}</p>
            ) : (
              <p className={`m-0 mt-1 flex items-center gap-1 text-base font-medium ${changeTone}`}>
                <span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center">
                  {hasChangeValue && numericChange > 0 ? (
                    <ChangeTriangle direction="up" />
                  ) : hasChangeValue && numericChange < 0 ? (
                    <ChangeTriangle direction="down" />
                  ) : (
                    <ChangeTriangle direction="flat" />
                  )}
                </span>
                <span>{formatPct(displayChange24h)}</span>
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
