export type TradeMarketDetailType = 'stock' | 'perp' | 'prediction';

export function normalizeTradeMarketDetailType(value: string | null | undefined): TradeMarketDetailType | null {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'stock' || normalized === 'perp' || normalized === 'prediction') {
    return normalized;
  }
  return null;
}

export function toWatchTypeFromTradeMarketType(type: TradeMarketDetailType): 'stock' | 'perps' | 'prediction' {
  if (type === 'perp') return 'perps';
  return type;
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
