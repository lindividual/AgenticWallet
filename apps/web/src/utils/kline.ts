import type { KlineCandle } from '../api';
import type { CandlePoint, LivelinePoint } from 'liveline';

function normalizeUnixSeconds(rawTime: number): number {
  if (!Number.isFinite(rawTime)) return 0;
  // Liveline expects unix seconds; convert ms timestamps defensively.
  if (rawTime >= 1e11) return Math.round(rawTime / 1000);
  return Math.round(rawTime);
}

export function normalizeCandlesForLiveline(candles: KlineCandle[] | null | undefined): CandlePoint[] {
  if (!candles || candles.length === 0) return [];
  return candles.map((item) => ({
    time: normalizeUnixSeconds(item.time),
    open: item.open,
    high: item.high,
    low: item.low,
    close: item.close,
  }));
}

export function toLivelinePoints(candles: CandlePoint[]): LivelinePoint[] {
  return candles.map((item) => ({
    time: item.time,
    value: item.close,
  }));
}
