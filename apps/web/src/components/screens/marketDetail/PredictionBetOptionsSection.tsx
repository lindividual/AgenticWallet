import { useTranslation } from 'react-i18next';
import type { TradeBrowsePredictionOption } from '../../../api';

function formatProbability(probability: number | null | undefined): string {
  if (!Number.isFinite(Number(probability))) return '--';
  return `${Number(probability).toFixed(1)}%`;
}

type PredictionBetOptionsSectionProps = {
  options: TradeBrowsePredictionOption[];
  selectedOptionId: string | null;
  onSelectOption: (id: string) => void;
  onBet: (optionLabel: string) => void;
  hasExternalUrl: boolean;
};

export function PredictionBetOptionsSection({
  options,
  selectedOptionId,
  onSelectOption,
  onBet,
  hasExternalUrl,
}: PredictionBetOptionsSectionProps) {
  const { t } = useTranslation();

  return (
    <section className="p-0">
      <h2 className="m-0 text-lg font-bold">{t('trade.betOptions')}</h2>
      {!options.length ? (
        <p className="m-0 mt-3 text-sm text-base-content/60">{t('trade.noPredictionOptions')}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {options.map((option) => {
            const selected = selectedOptionId === option.id;
            return (
              <div
                key={option.id}
                className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
                  selected ? 'border-primary/60 bg-primary/10' : 'border-base-content/10 bg-base-200/30'
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => onSelectOption(option.id)}
                >
                  <p className="m-0 text-sm font-semibold">{option.label}</p>
                  <p className="m-0 mt-0.5 text-xs text-base-content/60">
                    {t('trade.probability')}: {formatProbability(option.probability)}
                  </p>
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-primary border-0"
                  onClick={() => onBet(option.label)}
                  disabled={!hasExternalUrl}
                >
                  {t('trade.betNow')}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
