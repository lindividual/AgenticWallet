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
