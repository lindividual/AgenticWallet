import type { KlineCandle } from '../api';
import type { CandlePoint, LivelinePoint } from 'liveline';

function toFiniteNumber(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeUnixSeconds(rawTime: unknown): number {
  const time = toFiniteNumber(rawTime);
  if (time == null) return 0;
  // Liveline expects unix seconds; convert ms timestamps defensively.
  if (time >= 1e11) return Math.round(time / 1000);
  return Math.round(time);
}

export function normalizeCandlesForLiveline(candles: KlineCandle[] | null | undefined): CandlePoint[] {
  if (!candles || candles.length === 0) return [];
  const normalized = candles
    .map((item) => {
      const time = normalizeUnixSeconds(item.time);
      const open = toFiniteNumber(item.open);
      const high = toFiniteNumber(item.high);
      const low = toFiniteNumber(item.low);
      const close = toFiniteNumber(item.close);
      if (!time || open == null || high == null || low == null || close == null) return null;
      return {
        time,
        open,
        high,
        low,
        close,
      } satisfies CandlePoint;
    })
    .filter((item): item is CandlePoint => item != null)
    .sort((a, b) => a.time - b.time);

  if (normalized.length <= 1) return normalized;
  const deduped: CandlePoint[] = [];
  for (const point of normalized) {
    const last = deduped[deduped.length - 1];
    if (last && last.time === point.time) {
      deduped[deduped.length - 1] = point;
    } else {
      deduped.push(point);
    }
  }
  return deduped;
}

export function toLivelinePoints(candles: CandlePoint[]): LivelinePoint[] {
  return candles.map((item) => ({
    time: item.time,
    value: item.close,
  }));
}

export function toOpenAnchoredLivelinePoints(
  candles: CandlePoint[],
  candleWidthSeconds: number,
): LivelinePoint[] {
  if (!candles.length) return [];
  if (!Number.isFinite(candleWidthSeconds) || candleWidthSeconds <= 0) {
    return toLivelinePoints(candles);
  }

  const first = candles[0];
  const points: LivelinePoint[] = [
    {
      time: first.time,
      value: first.open,
    },
  ];
  const nowSeconds = Math.floor(Date.now() / 1000);

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const isLastCandle = index === candles.length - 1;
    const projectedCloseTime = candle.time + candleWidthSeconds;
    points.push({
      // Clamp the active candle so the chart never projects into the future.
      // Liveline appends a live point at "now"; if our last close sits after now,
      // the final segment appears to bend backward.
      time: isLastCandle ? Math.min(projectedCloseTime, nowSeconds) : projectedCloseTime,
      value: candle.close,
    });
  }

  return points;
}

export function computeAdaptiveChartWindowSeconds(
  candles: CandlePoint[],
  candleWidthSeconds: number,
  maxCandleCount = 60,
): number {
  const baseCount = Math.min(candles.length || 30, maxCandleCount);
  const baseWindow = Math.max(candleWidthSeconds * baseCount, candleWidthSeconds * 10);
  if (!candles.length) return baseWindow;

  const latest = candles[candles.length - 1];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const stalenessSeconds = Math.max(0, nowSeconds - latest.time);
  return Math.max(baseWindow, stalenessSeconds + candleWidthSeconds * 10);
}

export function formatChartTimeLabel(
  time: number,
  locale: string,
  candleWidthSeconds: number,
): string {
  const normalizedTime = normalizeUnixSeconds(time);
  if (!normalizedTime) return '';

  const date = new Date(normalizedTime * 1000);
  const normalizedLocale = locale || undefined;

  if (candleWidthSeconds >= 86_400) {
    return new Intl.DateTimeFormat(normalizedLocale, {
      month: 'short',
      day: 'numeric',
    }).format(date);
  }

  return new Intl.DateTimeFormat(normalizedLocale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}
