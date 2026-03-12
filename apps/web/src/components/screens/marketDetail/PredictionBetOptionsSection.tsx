import { useTranslation } from 'react-i18next';
import type { PredictionEventOutcome } from '../../../api';

function formatProbability(probability: number | null | undefined): string {
  if (!Number.isFinite(Number(probability))) return '--';
  return `${Number(probability).toFixed(1)}%`;
}

function formatCompactUsd(value: number | null | undefined, locale: string): string {
  if (!Number.isFinite(Number(value))) return '--';
  return `$${new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Number(value))}`;
}

type PredictionBetOptionsSectionProps = {
  layout: 'binary' | 'winner';
  outcomes: PredictionEventOutcome[];
  selectedOptionId: string | null;
  onSelectOption: (id: string) => void;
  betAmount: string;
  onBetAmountChange: (next: string) => void;
  onBet: (option: PredictionBetTarget) => void;
  pendingOptionId: string | null;
  locale: string;
};

export type PredictionBetTarget = {
  id: string;
  label: string;
  tokenId: string | null;
  probability: number | null;
  side: 'yes' | 'no';
};

export function PredictionBetOptionsSection({
  layout,
  outcomes,
  selectedOptionId,
  onSelectOption,
  betAmount,
  onBetAmountChange,
  onBet,
  pendingOptionId,
  locale,
}: PredictionBetOptionsSectionProps) {
  const { t } = useTranslation();

  return (
    <section className="p-0">
      <h2 className="m-0 text-lg font-bold">{t('trade.betOptions')}</h2>
      {layout === 'winner' && outcomes.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          <label className="flex flex-col gap-1 rounded-2xl border border-base-content/10 bg-base-100/70 px-4 py-3">
            <span className="text-xs text-base-content/60">{t('trade.betAmount')}</span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              className="input input-bordered h-9 w-full"
              value={betAmount}
              onChange={(event) => onBetAmountChange(event.target.value)}
              placeholder={t('trade.betAmountPlaceholder')}
            />
          </label>
          {outcomes.map((row) => {
            const selected = selectedOptionId === row.id;
            const yesPending = pendingOptionId === `${row.id}:yes`;
            const noPending = pendingOptionId === `${row.id}:no`;
            const hasPending = pendingOptionId != null;
            return (
              <div
                key={row.id}
                className={`rounded-2xl border p-4 transition ${
                  selected ? 'border-primary/60 bg-primary/10' : 'border-base-content/10 bg-base-100/70'
                }`}
              >
                <button type="button" className="w-full text-left" onClick={() => onSelectOption(row.id)}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="m-0 truncate text-base font-semibold">{row.label}</p>
                      <p className="m-0 mt-1 text-xs text-base-content/55">
                        {formatCompactUsd(row.volume24h, locale)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="m-0 text-3xl font-black text-base-content">{formatProbability(row.probability)}</p>
                      <p className="m-0 text-xs text-base-content/55">{t('trade.probability')}</p>
                    </div>
                  </div>
                </button>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className="btn btn-sm btn-success border-0"
                    disabled={!row.yesTokenId || hasPending}
                    onClick={() => onBet({
                      id: `${row.id}:yes`,
                      label: `${row.label} - Yes`,
                      tokenId: row.yesTokenId,
                      probability: row.probability,
                      side: 'yes',
                    })}
                  >
                    {yesPending ? <span className="loading loading-spinner loading-xs" /> : `${t('trade.buyYes')} ${formatProbability(row.probability)}`}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline border-base-content/15"
                    disabled={!row.noTokenId || hasPending}
                    onClick={() => onBet({
                      id: `${row.id}:no`,
                      label: `${row.label} - No`,
                      tokenId: row.noTokenId,
                      probability: row.noProbability,
                      side: 'no',
                    })}
                  >
                    {noPending ? <span className="loading loading-spinner loading-xs" /> : `${t('trade.buyNo')} ${formatProbability(row.noProbability)}`}
                  </button>
                </div>
                <p className="m-0 mt-3 text-xs text-base-content/50">
                  {t('trade.buyYes')}: {formatProbability(row.probability)}
                  {' · '}
                  {t('trade.buyNo')}: {formatProbability(row.noProbability)}
                </p>
              </div>
            );
          })}
        </div>
      ) : !outcomes.length ? (
        <p className="m-0 mt-3 text-sm text-base-content/60">{t('trade.noPredictionOptions')}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <label className="flex flex-col gap-1 rounded-2xl border border-base-content/10 bg-base-100/70 px-4 py-3">
            <span className="text-xs text-base-content/60">{t('trade.betAmount')}</span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              className="input input-bordered h-9 w-full"
              value={betAmount}
              onChange={(event) => onBetAmountChange(event.target.value)}
              placeholder={t('trade.betAmountPlaceholder')}
            />
          </label>
          {outcomes.map((option) => {
            const selected = selectedOptionId === option.id;
            const isPending = pendingOptionId === option.id;
            const disableBet = !option.yesTokenId || pendingOptionId != null;
            return (
              <div
                key={option.id}
                className={`rounded-2xl border p-4 ${
                  selected ? 'border-primary/60 bg-primary/10' : 'border-base-content/10 bg-base-100/70'
                }`}
              >
                <button type="button" className="w-full text-left" onClick={() => onSelectOption(option.id)}>
                  <p className="m-0 text-base font-semibold">{option.label}</p>
                  <p className="m-0 mt-2 text-3xl font-black">{formatProbability(option.probability)}</p>
                  <p className="m-0 mt-1 text-xs text-base-content/55">{t('trade.probability')}</p>
                </button>
                <button
                    type="button"
                    className="btn btn-sm btn-primary mt-4 w-full border-0"
                  onClick={() => onBet({
                    id: option.id,
                    label: option.label,
                    tokenId: option.yesTokenId,
                    probability: option.probability,
                    side: 'yes',
                  })}
                  disabled={disableBet}
                >
                  {isPending ? (
                    <span className="loading loading-spinner loading-xs" />
                  ) : (
                    t('trade.betNow')
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
