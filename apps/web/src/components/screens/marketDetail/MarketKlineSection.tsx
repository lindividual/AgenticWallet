import { Liveline } from 'liveline';
import type { CandlePoint, LivelinePoint } from 'liveline';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { formatUsdAdaptive } from '../../../utils/currency';

export type PredictionKlineSeries = {
  id: string;
  label: string;
  line: LivelinePoint[];
  latestValue: number | null;
  isSelected: boolean;
};

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
  predictionSeries: PredictionKlineSeries[];
  onSelectPredictionSeries?: (id: string) => void;
};

const PREDICTION_CHART_COLORS = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#ea580c',
  '#7c3aed',
  '#0891b2',
  '#ca8a04',
  '#db2777',
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatProbability(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  return `${Number(value).toFixed(1)}%`;
}

function buildPredictionSeriesPath(
  points: LivelinePoint[],
  bounds: { minTime: number; maxTime: number; minValue: number; maxValue: number },
  size: { width: number; height: number; paddingX: number; paddingY: number },
): string {
  if (!points.length) return '';
  const innerWidth = size.width - size.paddingX * 2;
  const innerHeight = size.height - size.paddingY * 2;
  const timeSpan = Math.max(1, bounds.maxTime - bounds.minTime);
  const valueSpan = Math.max(1, bounds.maxValue - bounds.minValue);

  const normalizedPoints = points.map((point) => {
    const x = size.paddingX + ((point.time - bounds.minTime) / timeSpan) * innerWidth;
    const y = size.paddingY + (1 - ((point.value - bounds.minValue) / valueSpan)) * innerHeight;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  if (normalizedPoints.length === 1) {
    const [single] = normalizedPoints[0].split(',');
    const y = normalizedPoints[0].split(',')[1];
    return `M ${single} ${y} L ${size.width - size.paddingX} ${y}`;
  }

  return `M ${normalizedPoints.join(' L ')}`;
}

function PredictionMultiLineChart({
  series,
  onSelectSeries,
}: {
  series: PredictionKlineSeries[];
  onSelectSeries?: (id: string) => void;
}) {
  const width = 720;
  const height = 280;
  const paddingX = 16;
  const paddingY = 12;
  const availableSeries = series.filter((item) => item.line.length > 0);
  const colorBySeriesId = new Map(
    availableSeries.map((item, index) => [item.id, PREDICTION_CHART_COLORS[index % PREDICTION_CHART_COLORS.length]]),
  );
  const legendSeries = availableSeries
    .slice()
    .sort((a, b) => (b.latestValue ?? Number.NEGATIVE_INFINITY) - (a.latestValue ?? Number.NEGATIVE_INFINITY))
    .filter((item, index) => item.isSelected || index < 7);

  if (!availableSeries.length) return null;

  const allPoints = availableSeries.flatMap((item) => item.line);
  const minTime = Math.min(...allPoints.map((item) => item.time));
  const maxTime = Math.max(...allPoints.map((item) => item.time));
  const rawMinValue = Math.min(...allPoints.map((item) => item.value));
  const rawMaxValue = Math.max(...allPoints.map((item) => item.value));
  const rawSpan = Math.max(1, rawMaxValue - rawMinValue);
  const minValue = clamp(rawMinValue - Math.max(2, rawSpan * 0.12), 0, 100);
  const maxValue = clamp(rawMaxValue + Math.max(2, rawSpan * 0.12), 0, 100);
  const centeredSpan = Math.max(8, maxValue - minValue);
  const center = (minValue + maxValue) / 2;
  const rangeMin = clamp(center - centeredSpan / 2, 0, 100);
  const rangeMax = clamp(center + centeredSpan / 2, 0, 100);
  const guideValues = [rangeMax, (rangeMax + rangeMin) / 2, rangeMin];
  const valueSpan = Math.max(1, rangeMax - rangeMin);
  const innerHeight = height - paddingY * 2;

  return (
    <div className="mt-3 rounded-xl border border-base-content/10 bg-base-200/20 p-3">
      <div className="h-72 overflow-hidden rounded-lg bg-base-100/70">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" role="img" aria-label="prediction multi-line chart">
          {guideValues.map((value) => {
            const y = paddingY + (1 - ((value - rangeMin) / valueSpan)) * innerHeight;
            return (
              <g key={value}>
                <line
                  x1={paddingX}
                  y1={y}
                  x2={width - paddingX}
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity="0.08"
                  strokeWidth="1"
                />
                <text x={width - paddingX} y={y - 4} textAnchor="end" fontSize="11" fill="currentColor" opacity="0.45">
                  {value.toFixed(0)}%
                </text>
              </g>
            );
          })}
          {availableSeries.map((item, index) => {
            const color = colorBySeriesId.get(item.id) ?? PREDICTION_CHART_COLORS[index % PREDICTION_CHART_COLORS.length];
            const path = buildPredictionSeriesPath(
              item.line,
              {
                minTime,
                maxTime,
                minValue: rangeMin,
                maxValue: rangeMax,
              },
              {
                width,
                height,
                paddingX,
                paddingY,
              },
            );
            const latestPoint = item.line[item.line.length - 1];
            const latestX = paddingX + ((latestPoint.time - minTime) / Math.max(1, maxTime - minTime)) * (width - paddingX * 2);
            const latestY = paddingY + (1 - ((latestPoint.value - rangeMin) / Math.max(1, rangeMax - rangeMin))) * innerHeight;
            return (
              <g key={item.id}>
                <path
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth={item.isSelected ? 3.5 : 2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={item.isSelected ? 1 : 0.75}
                />
                <circle cx={latestX} cy={latestY} r={item.isSelected ? 4.5 : 3} fill={color} opacity={0.95} />
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {legendSeries.map((item) => {
          const color = colorBySeriesId.get(item.id) ?? PREDICTION_CHART_COLORS[0];
          const content = (
            <>
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
              <span className="truncate">{item.label}</span>
              <span className="text-base-content/60">{formatProbability(item.latestValue)}</span>
            </>
          );

          if (onSelectSeries) {
            return (
              <button
                key={item.id}
                type="button"
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
                  item.isSelected ? 'border-primary/40 bg-primary/10 text-base-content' : 'border-base-content/10 bg-base-100/80 text-base-content/80'
                }`}
                onClick={() => onSelectSeries(item.id)}
              >
                {content}
              </button>
            );
          }

          return (
            <div
              key={item.id}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
                item.isSelected ? 'border-primary/40 bg-primary/10 text-base-content' : 'border-base-content/10 bg-base-100/80 text-base-content/80'
              }`}
            >
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChartModeToggleButton({
  chartMode,
  setChartMode,
}: {
  chartMode: 'line' | 'candle';
  setChartMode: (mode: 'line' | 'candle') => void;
}) {
  const isLineMode = chartMode === 'line';

  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs border-0 px-2.5"
      onClick={() => setChartMode(isLineMode ? 'candle' : 'line')}
      aria-label={isLineMode ? 'switch to candle chart' : 'switch to line chart'}
    >
      <span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center">
        {isLineMode ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.5 3.5v9" />
            <path d="M12.5 3.5v9" />
            <path d="M7.75 2.5v11" />
            <rect x="2.5" y="6.25" width="2" height="3.5" rx="1" fill="currentColor" stroke="none" />
            <rect x="6.75" y="4.25" width="2" height="4.5" rx="1" fill="currentColor" stroke="none" />
            <rect x="11.5" y="7.25" width="2" height="3" rx="1" fill="currentColor" stroke="none" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 10.5 5.25 7.75 7.75 9.5 11.5 5.5 14 6.75" />
          </svg>
        )}
      </span>
    </button>
  );
}

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
  predictionSeries,
  onSelectPredictionSeries,
}: MarketKlineSectionProps) {
  const { t } = useTranslation();
  const hasPredictionSeries = normalizedType === 'prediction' && predictionSeries.some((item) => item.line.length > 0);
  const showChartModeToggle = normalizedType !== 'prediction';

  return (
    <section className="p-0">
      {hasKlineSupport ? (
        <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              {klinePeriodButtons}
            </div>
            {showChartModeToggle ? (
              <ChartModeToggleButton chartMode={chartMode} setChartMode={setChartMode} />
            ) : null}
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
          ) : normalizedType === 'prediction' ? (
            hasPredictionSeries ? (
              <PredictionMultiLineChart
                series={predictionSeries}
                onSelectSeries={onSelectPredictionSeries}
              />
            ) : (
              <p className="m-0 mt-3 text-sm text-base-content/60">{t('trade.noKline')}</p>
            )
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
                formatValue={(value) => formatUsdAdaptive(value, locale)}
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
