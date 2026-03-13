export type TradeMarketDetailType = 'perp' | 'prediction';

export function normalizeTradeMarketDetailType(value: string | null | undefined): TradeMarketDetailType | null {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'perp' || normalized === 'prediction') {
    return normalized;
  }
  return null;
}

export function toWatchTypeFromTradeMarketType(type: TradeMarketDetailType): 'perps' | 'prediction' {
  return type === 'perp' ? 'perps' : 'prediction';
}

export function normalizeWatchlistItemId(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
  return normalized || null;
}
