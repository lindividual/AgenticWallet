type CandleLike = {
  time: number;
};

const PERIOD_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
  '1w': 604_800,
};

export function periodToSeconds(period: string): number {
  const normalized = (period ?? '').trim().toLowerCase();
  return PERIOD_SECONDS[normalized] ?? 3600;
}

export function getLatestCandleTime(candles: CandleLike[]): number | null {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  let latest = Number.NEGATIVE_INFINITY;
  for (const candle of candles) {
    const time = Number(candle?.time);
    if (!Number.isFinite(time)) continue;
    if (time > latest) latest = time;
  }
  return Number.isFinite(latest) ? latest : null;
}

export function isKlineStale(candles: CandleLike[], period: string): boolean {
  const latest = getLatestCandleTime(candles);
  if (latest == null) return true;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const lagSeconds = nowSeconds - latest;
  const periodSeconds = periodToSeconds(period);
  // Consider stale when lag exceeds 12 bars (or at least 6h).
  const staleThresholdSeconds = Math.max(periodSeconds * 12, 6 * 3600);
  return lagSeconds > staleThresholdSeconds;
}

export function shouldPreferFallbackCandles(
  primary: CandleLike[],
  fallback: CandleLike[],
  period: string,
): boolean {
  if (!fallback.length) return false;
  if (!primary.length) return true;
  if (!isKlineStale(primary, period)) return false;

  const primaryLatest = getLatestCandleTime(primary);
  const fallbackLatest = getLatestCandleTime(fallback);
  if (fallbackLatest == null) return false;
  if (primaryLatest == null) return true;
  return fallbackLatest > primaryLatest;
}
