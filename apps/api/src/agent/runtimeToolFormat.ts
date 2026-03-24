type NumericCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  turnover?: number | null;
};

type TokenDetailLike = {
  chain: string;
  contract: string;
  symbol: string;
  name: string;
  currentPriceUsd: number | null;
  priceChange24h: number | null;
  holders?: number | null;
  liquidityUsd?: number | null;
  top10HolderPercent?: number | null;
  devHolderPercent?: number | null;
  lockLpPercent?: number | null;
  volume24h?: number | null;
  fdv?: number | null;
};

type TokenAuditLike = {
  supported: boolean;
  checking: boolean;
  riskCount: number;
  warnCount: number;
  buyTax: number | null;
  sellTax: number | null;
  freezeAuth: boolean;
  mintAuth: boolean;
  lpLock: boolean;
  highRisk: boolean;
  cannotSellAll: boolean;
  isProxy: boolean;
  top10HolderRiskLevel: number | null;
  riskChecks?: Array<{ labelName: string | null }>;
  warnChecks?: Array<{ labelName: string | null }>;
};

type TokenHoldingLike = {
  symbol: string | null;
  valueUsd: number;
  portfolioWeightPct: number | null;
  networkCount: number;
};

type WalletChainAccountLike = {
  networkKey: string;
  protocol: 'evm' | 'svm' | 'tvm' | 'btc';
  address: string;
};

type WalletHoldingLike = {
  symbol: string | null;
  name: string | null;
  valueUsd: number;
  portfolioWeightPct: number | null;
};

type ReceiveProtocolGroup = {
  protocol: 'evm' | 'tvm' | 'svm' | 'btc';
  label: string;
  address: string;
  chainNames: string[];
};

export type TokenContextToolResultInput = {
  requestedChain: string;
  requestedContract: string;
  requestedSymbol?: string | null;
  requestedName?: string | null;
  detail: TokenDetailLike | null;
  audit: TokenAuditLike | null;
  candles: NumericCandle[];
  isInWatchlist: boolean;
  holding: TokenHoldingLike | null;
};

export type WalletContextToolResultInput = {
  walletAddress: string | null;
  chainAccounts: WalletChainAccountLike[];
  totalUsd: number | null;
  topHoldings: WalletHoldingLike[];
  watchlistSymbols: string[];
  recentEventTypes: string[];
};

export type ReceiveAddressesToolResultInput = {
  groups: ReceiveProtocolGroup[];
};

function formatUsd(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return 'unavailable';
  const numeric = Number(value);
  if (Math.abs(numeric) >= 1_000_000_000) return `$${(numeric / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(numeric) >= 1_000_000) return `$${(numeric / 1_000_000).toFixed(2)}M`;
  if (Math.abs(numeric) >= 1_000) return `$${(numeric / 1_000).toFixed(2)}K`;
  if (Math.abs(numeric) >= 1) return `$${numeric.toFixed(2)}`;
  return `$${numeric.toFixed(6)}`;
}

function formatPercent(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return 'unavailable';
  return `${Number(value).toFixed(2)}%`;
}

function truncateAddress(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function collectCheckLabels(checks: Array<{ labelName: string | null }> | undefined, limit = 3): string {
  return (checks ?? [])
    .map((item) => item.labelName?.trim() ?? '')
    .filter(Boolean)
    .slice(0, limit)
    .join(', ');
}

export function summarizeKlineTrend(candles: NumericCandle[]): string {
  if (candles.length < 2) return 'Trend summary unavailable.';

  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!Number.isFinite(first.close) || !Number.isFinite(last.close) || first.close === 0) {
    return 'Trend summary unavailable.';
  }

  let high = first.high;
  let low = first.low;
  let upMoves = 0;
  let downMoves = 0;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    high = Math.max(high, candle.high);
    low = Math.min(low, candle.low);
    if (index === 0) continue;
    if (candle.close >= candles[index - 1].close) {
      upMoves += 1;
    } else {
      downMoves += 1;
    }
  }

  const changePct = ((last.close - first.close) / first.close) * 100;
  const rangePct = low > 0 ? ((high - low) / low) * 100 : null;
  const direction = changePct >= 6
    ? 'strong upward'
    : changePct >= 1
      ? 'upward'
      : changePct <= -6
        ? 'strong downward'
        : changePct <= -1
          ? 'downward'
          : 'sideways';
  const consistency = upMoves === downMoves
    ? 'mixed'
    : upMoves > downMoves
      ? 'buyers had more control'
      : 'sellers had more control';

  return [
    `Recent trend looks ${direction} (${formatPercent(changePct)} across ${candles.length} candles).`,
    rangePct != null ? `Observed price range was ${formatPercent(rangePct)}.` : '',
    consistency,
  ]
    .filter(Boolean)
    .join(' ');
}

export function buildTokenContextToolResult(input: TokenContextToolResultInput): string {
  const detail = input.detail;
  const symbol = detail?.symbol ?? input.requestedSymbol ?? 'unknown';
  const name = detail?.name ?? input.requestedName ?? 'Unknown token';
  const riskLabels = collectCheckLabels(input.audit?.riskChecks);
  const warningLabels = collectCheckLabels(input.audit?.warnChecks);
  const riskSummary = input.audit
    ? [
        `supported=${input.audit.supported}`,
        `checking=${input.audit.checking}`,
        `riskCount=${input.audit.riskCount}`,
        `warnCount=${input.audit.warnCount}`,
        `highRisk=${input.audit.highRisk}`,
        `cannotSellAll=${input.audit.cannotSellAll}`,
        `mintAuth=${input.audit.mintAuth}`,
        `freezeAuth=${input.audit.freezeAuth}`,
        `isProxy=${input.audit.isProxy}`,
        `lpLock=${input.audit.lpLock}`,
        `buyTax=${formatPercent(input.audit.buyTax)}`,
        `sellTax=${formatPercent(input.audit.sellTax)}`,
        input.audit.top10HolderRiskLevel != null ? `top10HolderRiskLevel=${input.audit.top10HolderRiskLevel}` : '',
      ]
        .filter(Boolean)
        .join(', ')
    : 'unavailable';

  const holdingSummary = input.holding
    ? `User position: ${formatUsd(input.holding.valueUsd)}${input.holding.portfolioWeightPct != null ? ` (${formatPercent(input.holding.portfolioWeightPct)} of portfolio)` : ''}; networks=${input.holding.networkCount}.`
    : 'User position: none detected in current wallet portfolio.';

  return [
    `Tool result for read_token_context (${input.requestedChain}:${input.requestedContract}):`,
    `Identity: ${name} (${symbol}) on ${detail?.chain ?? input.requestedChain}; contract=${detail?.contract || input.requestedContract}.`,
    `Market: price=${formatUsd(detail?.currentPriceUsd)}, change24h=${formatPercent(detail?.priceChange24h)}, liquidity=${formatUsd(detail?.liquidityUsd)}, volume24h=${formatUsd(detail?.volume24h)}, holders=${detail?.holders ?? 'unavailable'}, fdv=${formatUsd(detail?.fdv)}.`,
    `Holder structure: top10=${formatPercent(detail?.top10HolderPercent)}, dev=${formatPercent(detail?.devHolderPercent)}, lpLock=${formatPercent(detail?.lockLpPercent)}.`,
    `Watchlist: ${input.isInWatchlist ? 'already in watchlist' : 'not currently in watchlist'}.`,
    `Risk audit: ${riskSummary}.`,
    riskLabels ? `Top risk labels: ${riskLabels}.` : '',
    warningLabels ? `Top warning labels: ${warningLabels}.` : '',
    `Trend summary: ${summarizeKlineTrend(input.candles)}`,
    holdingSummary,
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildWalletContextToolResult(input: WalletContextToolResultInput): string {
  const topHoldings = input.topHoldings
    .slice(0, 5)
    .map((item) => `${item.symbol ?? item.name ?? 'unknown'} ${formatUsd(item.valueUsd)}${item.portfolioWeightPct != null ? ` (${formatPercent(item.portfolioWeightPct)})` : ''}`)
    .join(', ');

  const protocolCoverage = ['evm', 'tvm', 'svm', 'btc']
    .map((protocol) => {
      const protocolAccounts = input.chainAccounts.filter((item) => item.protocol === protocol);
      if (protocolAccounts.length === 0) return null;
      return `${protocol}=${protocolAccounts.map((item) => truncateAddress(item.address)).join(', ')}`;
    })
    .filter(Boolean)
    .join('; ');

  const concentration = input.topHoldings
    .slice(0, 3)
    .reduce((acc, item) => acc + Number(item.portfolioWeightPct ?? 0), 0);

  return [
    'Tool result for read_wallet_context:',
    `Wallet: ${input.walletAddress ? truncateAddress(input.walletAddress) : 'unavailable'}.`,
    `Portfolio total: ${formatUsd(input.totalUsd)}.`,
    topHoldings ? `Top holdings: ${topHoldings}.` : 'Top holdings: unavailable.',
    concentration > 0 ? `Top 3 concentration: ${formatPercent(concentration)}.` : '',
    protocolCoverage ? `Address coverage: ${protocolCoverage}.` : 'Address coverage: unavailable.',
    input.watchlistSymbols.length > 0 ? `Watchlist summary: ${input.watchlistSymbols.slice(0, 8).join(', ')}.` : '',
    input.recentEventTypes.length > 0 ? `Recent activity summary: ${input.recentEventTypes.slice(0, 6).join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildReceiveAddressesToolResult(input: ReceiveAddressesToolResultInput): string {
  return [
    'Tool result for read_receive_addresses:',
    ...input.groups.map((group) => {
      const chains = group.chainNames.length > 0 ? group.chainNames.join(', ') : 'none';
      return `${group.label}: address=${group.address}; supported chains=${chains}.`;
    }),
  ]
    .filter(Boolean)
    .join('\n');
}
