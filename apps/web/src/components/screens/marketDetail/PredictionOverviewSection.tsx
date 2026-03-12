import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PredictionEventOutcome } from '../../../api';
import { CachedIconImage } from '../../CachedIconImage';

function formatCompactUsd(value: number | null | undefined, locale: string): string {
  if (!Number.isFinite(Number(value))) return '--';
  return `$${new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Number(value))}`;
}

function formatProbability(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  return `${Number(value).toFixed(1)}%`;
}

function formatDate(value: string | null | undefined, locale: string): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

type PredictionOverviewSectionProps = {
  title: string;
  image: string | null;
  description: string | null;
  volume24h: number | null;
  endDate: string | null;
  topOptions: PredictionEventOutcome[];
  locale: string;
};

export function PredictionOverviewSection({
  title,
  image,
  description,
  volume24h,
  endDate,
  topOptions,
  locale,
}: PredictionOverviewSectionProps) {
  const { t } = useTranslation();
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
  const shouldShowDescriptionToggle = (description?.trim().length ?? 0) > 120;

  return (
    <section className="p-0">
      <div className="flex items-start gap-4">
        {image ? (
          <CachedIconImage
            src={image}
            alt={title}
            className="h-14 w-14 rounded-2xl bg-base-300 object-cover"
            loading="lazy"
            fallback={<div className="h-14 w-14 rounded-2xl bg-base-300" />}
          />
        ) : (
          <div className="h-14 w-14 rounded-2xl bg-base-300" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-2xl font-bold leading-tight tracking-tight text-base-content">{title}</h1>
        </div>
      </div>

      {description ? (
        <div className="mt-4">
          <p
            className={[
              'm-0 max-w-3xl text-sm leading-6 text-base-content/68',
              !isDescriptionExpanded ? 'overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]' : '',
            ].join(' ')}
          >
            {description}
          </p>
          {shouldShowDescriptionToggle ? (
            <button
              type="button"
              className="mt-2 text-sm font-semibold text-base-content/72"
              onClick={() => setIsDescriptionExpanded((value) => !value)}
            >
              {isDescriptionExpanded ? t('common.less') : t('common.more')}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {topOptions.map((option, index) => (
          <div key={option.id} className="rounded-2xl border border-base-content/10 bg-base-100/75 p-3">
            <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-base-content/40">
              #{index + 1}
            </p>
            <p className="m-0 mt-2 truncate text-sm font-semibold text-base-content">{option.label}</p>
            <p className="m-0 mt-1 text-2xl font-black text-base-content">{formatProbability(option.probability)}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap gap-3 text-sm">
        <div className="rounded-full border border-base-content/10 bg-base-100/75 px-4 py-2 text-base-content/72">
          24h Vol. {formatCompactUsd(volume24h, locale)}
        </div>
        <div className="rounded-full border border-base-content/10 bg-base-100/75 px-4 py-2 text-base-content/72">
          {formatDate(endDate, locale)}
        </div>
      </div>
    </section>
  );
}
