export function formatUsdAdaptive(value: number, locale: string): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  const fractionDigits = Math.abs(safeValue) < 1 ? 6 : 2;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(safeValue);
}

