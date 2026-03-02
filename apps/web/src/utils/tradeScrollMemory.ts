export const TRADE_SCROLL_Y_STORAGE_KEY = 'agentic-wallet:trade-scroll-y';

export function readTradeScrollY(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.sessionStorage.getItem(TRADE_SCROLL_Y_STORAGE_KEY);
    if (raw == null) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

export function saveTradeScrollY(value: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(TRADE_SCROLL_Y_STORAGE_KEY, String(Math.max(0, Math.floor(value))));
  } catch {
    // Ignore storage errors in private mode or quota edge cases.
  }
}
