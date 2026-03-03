import { Liveline } from 'liveline';
import type { CandlePoint, LivelinePoint } from 'liveline';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { formatUsdAdaptive } from '../../../utils/currency';

type MarketKlineSectionProps = {
  normalizedType: 'stock' | 'perp' | 'prediction';
  hasKlineSupport: boolean;
  klinePeriodButtons: ReactNode;
  chartMode: 'line' | 'candle';
  setChartMode: (mode: 'line' | 'candle') => void;
  isChartLoading: boolean;
  chartCandles: CandlePoint[];
  chartLine: LivelinePoint[];
  latestChartValue: number;
  candleWidth: number;
  chartWindow: number;
  resolvedTheme: 'light' | 'dark';
  chartColor: string;
  locale: string;
};

export function MarketKlineSection({
  normalizedType,
  hasKlineSupport,
  klinePeriodButtons,
  chartMode,
  setChartMode,
  isChartLoading,
  chartCandles,
  chartLine,
  latestChartValue,
  candleWidth,
  chartWindow,
  resolvedTheme,
  chartColor,
  locale,
}: MarketKlineSectionProps) {
  const { t } = useTranslation();

  return (
    <section className="p-0">
      <h2 className="m-0 text-lg font-bold">{t('trade.klineTitle')}</h2>
      {hasKlineSupport ? (
        <>
          {klinePeriodButtons}
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
                    <linearGradient id="loading-market-kline-line" x1="0%" y1="0%" x2="100%" y2="0%">
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
                    stroke="url(#loading-market-kline-line)"
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
                formatValue={(value) => (
                  normalizedType === 'prediction'
                    ? `${value.toFixed(2)}%`
                    : formatUsdAdaptive(value, locale)
                )}
                formatTime={() => ''}
                grid={false}
                scrub
                padding={{ top: 6, right: 6, bottom: 6, left: 6 }}
              />
            </div>
          )}
        </>
      ) : (
        <p className="m-0 mt-3 text-sm text-base-content/60">{t('trade.noKline')}</p>
      )}
    </section>
  );
}
