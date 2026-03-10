import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { KlineCandle, SimEvmBalance, WalletPortfolioResponse } from '../../api';
import {
  getAppConfig,
  getCoinDetail,
  getMarketByInstrumentId,
  getTokenKline,
  getTransferHistory,
  getWalletPortfolio,
  resolveAssetIdentity,
} from '../../api';
import { formatUsdAdaptive } from '../../utils/currency';
import { encodeTokenContractParam } from '../../utils/tokenRoute';
import { cloneTradeToken, getTradeTokenConfig } from '../../utils/tradeTokens';
import { CachedIconImage } from '../CachedIconImage';
import { Modal } from '../modals/Modal';
import { ReceiveCryptoContent } from '../modals/ReceiveCryptoContent';
import { TopUpContent } from '../modals/TopUpContent';
import { TradeContent, type TradePreset } from '../modals/TradeContent';
import { TransferContent } from '../modals/TransferContent';
import type { AuthState } from '../../hooks/useWalletApp';

type WalletAssetDetailScreenProps = {
  auth: AuthState;
  chain: string;
  contract: string;
  onBack: () => void;
};

type ActiveModalContent = 'topUp' | 'receive' | 'transfer' | 'trade';
type TransferPresetAsset = {
  chainId: number;
  tokenAddress: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
};

type WalletAssetHolding = {
  assetId: string | null;
  symbol: string;
  name: string;
  logo: string | null;
  amountText: string;
  amountValue: number;
  valueUsd: number;
  transferAsset: SimEvmBalance;
};

function normalizeText(raw: string | null | undefined): string {
  return (raw ?? '').trim();
}

function normalizeLower(raw: string | null | undefined): string {
  return normalizeText(raw).toLowerCase();
}

function normalizeAssetId(raw: string | null | undefined): string | null {
  const value = normalizeLower(raw);
  return value || null;
}

function normalizeIconUrl(raw: string | null | undefined): string | null {
  const value = normalizeText(raw);
  if (!value) return null;
  if (value.startsWith('ipfs://ipfs/')) {
    return `https://ipfs.io/ipfs/${value.slice('ipfs://ipfs/'.length)}`;
  }
  if (value.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${value.slice('ipfs://'.length)}`;
  }
  return value;
}

function resolveHoldingIcon(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const normalized = normalizeIconUrl(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function resolveAssetIdFallbackIcon(assetId: string | null, symbol: string): string | null {
  const normalizedAssetId = normalizeLower(assetId);
  if (normalizedAssetId === 'coingecko:usd-coin') return '/usdc.svg';
  if (normalizedAssetId === 'coingecko:tether') return '/usdt.svg';
  if (normalizedAssetId === 'coingecko:ethereum') return '/eth.svg';
  if (normalizedAssetId === 'coingecko:binancecoin') return '/bnb.svg';

  const normalizedSymbol = symbol.trim().toUpperCase();
  if (normalizedSymbol === 'USDC') return '/usdc.svg';
  if (normalizedSymbol === 'USDT') return '/usdt.svg';
  if (normalizedSymbol === 'ETH') return '/eth.svg';
  if (normalizedSymbol === 'BNB') return '/bnb.svg';
  return null;
}

function getAssetInitial(symbol: string | null | undefined, name: string | null | undefined): string {
  const label = (symbol ?? name ?? '').trim();
  if (!label) return '?';
  return label[0].toUpperCase();
}

function toDisplayAmount(rawAmount: string | undefined, decimals: number | undefined): number {
  const amount = Number(rawAmount ?? 0);
  if (!Number.isFinite(amount)) return 0;
  const divisor = 10 ** (decimals ?? 0);
  if (!Number.isFinite(divisor) || divisor <= 0) return amount;
  return amount / divisor;
}

function formatDisplayAmount(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function formatTokenAmount(rawAmount: string | undefined, decimals: number | undefined): string {
  return formatDisplayAmount(toDisplayAmount(rawAmount, decimals));
}

function normalizeContractForMatch(raw: string | null | undefined): string {
  const value = normalizeLower(raw);
  if (!value || value === 'native' || value === '0x0000000000000000000000000000000000000000') return 'native';
  return value;
}

function matchesAssetVariant(variant: SimEvmBalance, chain: string, contract: string): boolean {
  const variantChain = normalizeLower((variant as SimEvmBalance & { market_chain?: string }).market_chain ?? variant.chain);
  const variantContract = normalizeContractForMatch(
    (variant as SimEvmBalance & { contract_key?: string }).contract_key ?? variant.address,
  );
  return variantChain === normalizeLower(chain) && variantContract === normalizeContractForMatch(contract);
}

function resolveSelectedHolding(
  portfolio: WalletPortfolioResponse | null | undefined,
  chain: string,
  contract: string,
): WalletAssetHolding | null {
  if (!portfolio) return null;

  const merged = portfolio.mergedHoldings ?? [];
  for (const item of merged) {
    const variants = [...(item.variants ?? [])].sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
    if (!variants.some((variant) => matchesAssetVariant(variant, chain, contract))) continue;
    const primary = variants[0];
    if (!primary) continue;
    const totalAmount = variants.reduce((sum, variant) => sum + toDisplayAmount(variant.amount, variant.decimals), 0);
    return {
      assetId: normalizeAssetId(item.asset_id) ?? normalizeAssetId(primary.asset_id),
      symbol: (item.symbol ?? primary.symbol ?? '').trim().toUpperCase() || '--',
      name: (item.name ?? primary.name ?? '').trim() || '--',
      logo: resolveHoldingIcon(
        item.logo,
        primary.logo,
        primary.logo_uri,
        primary.url,
        resolveAssetIdFallbackIcon(normalizeAssetId(item.asset_id) ?? normalizeAssetId(primary.asset_id), item.symbol ?? primary.symbol ?? ''),
      ),
      amountText: formatDisplayAmount(totalAmount),
      amountValue: totalAmount,
      valueUsd: Number(item.total_value_usd ?? primary.value_usd ?? 0),
      transferAsset: primary,
    };
  }

  const grouped = [...portfolio.holdings].reduce<Map<string, { totalValueUsd: number; variants: SimEvmBalance[] }>>(
    (acc, asset) => {
      const key = normalizeAssetId(asset.asset_id) ?? `${asset.chain_id}:${normalizeLower(asset.address)}`;
      const current = acc.get(key);
      const valueUsd = Number(asset.value_usd ?? 0);
      if (current) {
        current.totalValueUsd += valueUsd;
        current.variants.push(asset);
        return acc;
      }
      acc.set(key, { totalValueUsd: valueUsd, variants: [asset] });
      return acc;
    },
    new Map(),
  );

  for (const group of grouped.values()) {
    const variants = [...group.variants].sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
    if (!variants.some((variant) => matchesAssetVariant(variant, chain, contract))) continue;
    const primary = variants[0];
    if (!primary) continue;
    const totalAmount = variants.reduce((sum, variant) => sum + toDisplayAmount(variant.amount, variant.decimals), 0);
    return {
      assetId: normalizeAssetId(primary.asset_id),
      symbol: (primary.symbol ?? primary.name ?? '').trim().toUpperCase() || '--',
      name: (primary.name ?? primary.symbol ?? '').trim() || '--',
      logo: resolveHoldingIcon(
        primary.logo,
        primary.logo_uri,
        primary.url,
        resolveAssetIdFallbackIcon(normalizeAssetId(primary.asset_id), primary.symbol ?? primary.name ?? ''),
      ),
      amountText: formatDisplayAmount(totalAmount),
      amountValue: totalAmount,
      valueUsd: group.totalValueUsd,
      transferAsset: primary,
    };
  }

  return null;
}

function formatPct(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(2)}%`;
}

function toneClass(value: number | null | undefined): string {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric === 0) return 'text-base-content/60';
  return numeric > 0 ? 'text-success' : 'text-error';
}

function truncateMiddle(value: string, start = 6, end = 4): string {
  const normalized = value.trim();
  if (normalized.length <= start + end + 3) return normalized;
  return `${normalized.slice(0, start)}...${normalized.slice(-end)}`;
}

function buildSparklinePath(candles: KlineCandle[] | undefined, width: number, height: number): string {
  const values = (candles ?? []).map((item) => Number(item.close)).filter((item) => Number.isFinite(item));
  if (values.length < 2) return '';

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - 4 - ((value - min) / range) * (height - 8);
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  });
  return points.join(' ');
}

function formatTransferAmount(rawAmount: string | null | undefined): string {
  const numeric = Number(rawAmount ?? 0);
  if (!Number.isFinite(numeric)) return '0';
  return numeric.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export function WalletAssetDetailScreen({ auth, chain, contract, onBack }: WalletAssetDetailScreenProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeModalContent, setActiveModalContent] = useState<ActiveModalContent>('topUp');
  const [tradePreset, setTradePreset] = useState<TradePreset | null>(null);
  const [tradeBackTarget, setTradeBackTarget] = useState<'topUp' | 'close'>('close');
  const [presetTransferAsset, setPresetTransferAsset] = useState<TransferPresetAsset | null>(null);
  const topUpButtonRef = useRef<HTMLButtonElement | null>(null);
  const transferButtonRef = useRef<HTMLButtonElement | null>(null);

  const normalizedChain = normalizeLower(chain);
  const normalizedContract = contract.trim();
  const walletAddress = auth.wallet?.address ?? auth.wallet?.chainAccounts?.[0]?.address ?? '';
  const ownedWalletAddresses = useMemo(
    () =>
      new Set(
        [auth.wallet?.address, ...(auth.wallet?.chainAccounts?.map((item) => item.address) ?? [])]
          .map((value) => normalizeLower(value))
          .filter(Boolean),
      ),
    [auth.wallet?.address, auth.wallet?.chainAccounts],
  );

  const { data: appConfig } = useQuery({
    queryKey: ['app-config'],
    queryFn: getAppConfig,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const { data: portfolioData } = useQuery({
    queryKey: ['wallet-portfolio', walletAddress],
    queryFn: () => getWalletPortfolio(),
    enabled: Boolean(walletAddress),
    staleTime: 15_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
  const selectedHolding = useMemo(
    () => resolveSelectedHolding(portfolioData, normalizedChain, normalizedContract),
    [normalizedChain, normalizedContract, portfolioData],
  );

  const detailChain = normalizeLower(selectedHolding?.transferAsset.chain ?? normalizedChain);
  const detailContractCandidate = normalizeText(selectedHolding?.transferAsset.address ?? normalizedContract);
  const detailContract = normalizeContractForMatch(detailContractCandidate) === 'native'
    ? ''
    : detailContractCandidate;

  const { data: detail } = useQuery({
    queryKey: ['wallet-asset-detail', detailChain, detailContract],
    queryFn: () => getCoinDetail(detailChain, detailContract),
    enabled: Boolean(detailChain && detailContract),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const { data: klineData } = useQuery({
    queryKey: ['wallet-asset-kline', detailChain, detailContract],
    queryFn: () => getTokenKline(detailChain, detailContract, '1h', 24),
    enabled: Boolean(detailChain && detailContract),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const { data: transferHistory } = useQuery({
    queryKey: [
      'transfer-history',
      50,
      selectedHolding?.transferAsset.chain_id ?? null,
      selectedHolding ? normalizeContractForMatch(selectedHolding.transferAsset.address) : null,
      selectedHolding?.symbol ?? null,
    ],
    queryFn: () =>
      getTransferHistory({
        limit: 50,
        chainId: selectedHolding?.transferAsset.chain_id,
        tokenAddress:
          normalizeContractForMatch(selectedHolding?.transferAsset.address) === 'native'
            ? null
            : normalizeText(selectedHolding?.transferAsset.address) || undefined,
        tokenSymbol: selectedHolding?.symbol || undefined,
        assetType:
          normalizeContractForMatch(selectedHolding?.transferAsset.address) === 'native'
            ? 'native'
            : 'erc20',
      }),
    enabled: Boolean(walletAddress && selectedHolding),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const perpContractHint = normalizeContractForMatch(normalizedContract) === 'native'
    ? 'native'
    : (normalizeText(selectedHolding?.transferAsset.address) || normalizedContract);
  const { data: perpResolvedIdentity } = useQuery({
    queryKey: ['wallet-asset-perp-identity', normalizedChain, perpContractHint, selectedHolding?.symbol ?? '', selectedHolding?.name ?? ''],
    queryFn: () =>
      resolveAssetIdentity({
        chain: normalizedChain,
        contract: perpContractHint,
        marketType: 'perp',
        symbol: selectedHolding?.symbol || undefined,
        nameHint: selectedHolding?.name || undefined,
      }),
    enabled: Boolean(normalizedChain && (selectedHolding?.symbol || selectedHolding?.name)),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const perpInstrumentId = perpResolvedIdentity?.instrument_id?.trim() || null;
  const { data: perpInstrumentMarket } = useQuery({
    queryKey: ['wallet-asset-perp-market', perpInstrumentId],
    queryFn: () => getMarketByInstrumentId(perpInstrumentId ?? ''),
    enabled: Boolean(perpInstrumentId),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const supportedChains = appConfig?.supportedChains ?? [];
  const displaySymbol = (selectedHolding?.symbol ?? detail?.symbol ?? '').trim().toUpperCase() || t('wallet.unknownAsset');
  const displayName = (selectedHolding?.name ?? detail?.name ?? '').trim() || t('wallet.token');
  const displayLogo = selectedHolding?.logo ?? resolveHoldingIcon(detail?.image);
  const amountText = selectedHolding?.amountText ?? '--';
  const valueUsd = Number(selectedHolding?.valueUsd ?? 0);
  const currentPrice = Number.isFinite(Number(detail?.currentPriceUsd))
    ? Number(detail?.currentPriceUsd)
    : selectedHolding && selectedHolding.amountValue > 0
      ? valueUsd / selectedHolding.amountValue
      : null;
  const priceChangePct = Number.isFinite(Number(detail?.priceChange24h)) ? Number(detail?.priceChange24h) : null;
  const priceChangeClassName = toneClass(priceChangePct);
  const sparklinePath = useMemo(() => buildSparklinePath(klineData, 90, 28), [klineData]);
  const supportedTradeChain = selectedHolding?.transferAsset.chain_id ?? null;
  const tradeTokenConfig = supportedTradeChain ? getTradeTokenConfig(supportedTradeChain) : null;
  const tradeTokenAddress = normalizeText(selectedHolding?.transferAsset.address);
  const canTradeToken = Boolean(
    supportedTradeChain
      && tradeTokenConfig
      && /^0x[a-fA-F0-9]{40}$/.test(tradeTokenAddress)
      && normalizeContractForMatch(tradeTokenAddress) !== 'native',
  );
  const hasPerpCard = Boolean(
    perpInstrumentMarket?.instrument?.market_type === 'perp'
      && perpInstrumentMarket.instrument.venue?.trim().toLowerCase() === 'hyperliquid',
  );

  const historyRows = useMemo(() => {
    const rows = transferHistory?.transfers ?? [];

    return rows
      .slice(0, 3)
      .map((row) => {
        const direction = ownedWalletAddresses.has(normalizeLower(row.toAddress))
          ? t('wallet.assetDetailEventReceive')
          : ownedWalletAddresses.has(normalizeLower(row.fromAddress))
            ? t('wallet.assetDetailEventTransfer')
            : t('wallet.assetDetailEventTrade');
        const estimatedUsd = currentPrice != null && Number.isFinite(Number(row.amountInput))
          ? currentPrice * Number(row.amountInput)
          : null;
        return {
          row,
          direction,
          amountLabel: `${formatTransferAmount(row.amountInput)} ${displaySymbol}`,
          usdLabel: estimatedUsd != null ? formatUsdAdaptive(estimatedUsd, i18n.language) : '--',
        };
      });
  }, [currentPrice, displaySymbol, i18n.language, ownedWalletAddresses, t, transferHistory?.transfers]);

  function openTokenDetail(): void {
    const nextChain = normalizeText(selectedHolding?.transferAsset.chain ?? normalizedChain);
    const nextContract = normalizeText(selectedHolding?.transferAsset.address ?? normalizedContract);
    void navigate({
      to: '/token/$chain/$contract',
      params: {
        chain: nextChain,
        contract: encodeTokenContractParam(nextContract),
      },
    });
  }

  function showModal(content: ActiveModalContent): void {
    setActiveModalContent(content);
    setIsModalOpen(true);
  }

  function closeModal(): void {
    setIsModalOpen(false);
  }

  function openTopUpModal(): void {
    setTradePreset(null);
    showModal('topUp');
  }

  function openReceiveModal(): void {
    showModal('receive');
  }

  function backToTopUp(): void {
    showModal('topUp');
  }

  function buildDefaultTradePreset(mode: 'buy' | 'stableSwap'): TradePreset | null {
    const chainId = supportedChains[0]?.chainId ?? 1;
    const config = getTradeTokenConfig(chainId);
    if (!config) return null;

    if (mode === 'stableSwap') {
      return {
        mode: 'stableSwap',
        chainId,
        sellToken: cloneTradeToken(config.usdc),
        buyToken: cloneTradeToken(config.usdt),
      };
    }

    return {
      mode: 'buy',
      chainId,
      sellToken: cloneTradeToken(config.usdc),
      buyToken: cloneTradeToken(config.defaultBuy),
      assetSymbolForEvent: config.defaultBuy.symbol,
    };
  }

  function openTradeFromTopUp(mode: 'buy' | 'stableSwap'): void {
    const preset = buildDefaultTradePreset(mode);
    if (!preset) return;
    setTradeBackTarget('topUp');
    setTradePreset(preset);
    showModal('trade');
  }

  function openTransferModal(): void {
    const asset = selectedHolding?.transferAsset;
    const tokenAddress = normalizeText(asset?.address);
    const isValidTokenAddress = /^0x[a-fA-F0-9]{40}$/.test(tokenAddress);
    const isNative = normalizeContractForMatch(tokenAddress) === 'native';

    setPresetTransferAsset(
      asset && isValidTokenAddress && !isNative
        ? {
            chainId: asset.chain_id,
            tokenAddress,
            tokenSymbol: asset.symbol,
            tokenDecimals: asset.decimals,
          }
        : null,
    );
    setTradePreset(null);
    showModal('transfer');
  }

  function openTradeModal(): void {
    if (!canTradeToken || !tradeTokenConfig || !supportedTradeChain || !selectedHolding) return;
    setTradeBackTarget('close');
    setTradePreset({
      mode: 'buy',
      chainId: supportedTradeChain,
      sellToken: cloneTradeToken(tradeTokenConfig.usdc),
      buyToken: {
        address: tradeTokenAddress,
        symbol: displaySymbol,
        decimals: selectedHolding.transferAsset.decimals,
      },
      assetSymbolForEvent: displaySymbol,
    });
    showModal('trade');
  }

  const promoCards = [
    ...(hasPerpCard
      ? [{
          title: t('wallet.assetDetailPerpsTitle', { symbol: displaySymbol }),
          summary: t('wallet.assetDetailPerpsSummary'),
        }]
      : []),
  ];

  const tokenInfoSummary = detailContract
    ? truncateMiddle(detailContract)
    : `${normalizeText(selectedHolding?.transferAsset.chain).toUpperCase() || normalizedChain.toUpperCase()} · ${t('trade.nativeToken')}`;

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-5 pb-32">
      <header className="mt-4 flex items-center justify-between gap-3">
        <button
          type="button"
          className="btn btn-sm btn-ghost border-0 px-2"
          onClick={onBack}
          aria-label={t('trade.backToList')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>

        <div className="flex min-w-0 items-center gap-3">
          {displayLogo ? (
            <CachedIconImage
              src={displayLogo}
              alt={displaySymbol || displayName}
              className="h-7 w-7 rounded-full bg-base-300 object-cover"
              loading="lazy"
              fallback={(
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-base-300 text-sm font-semibold text-base-content/70">
                  {getAssetInitial(displaySymbol, displayName)}
                </div>
              )}
            />
          ) : (
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-base-300 text-sm font-semibold text-base-content/70">
              {getAssetInitial(displaySymbol, displayName)}
            </div>
          )}
          <p className="m-0 flex items-baseline gap-2">
            <span className="truncate text-xl font-semibold text-base-content/80">{displayName}</span>
            <span className="text-sm font-medium uppercase text-base-content/50">{displaySymbol}</span>
          </p>
        </div>

        <button
          type="button"
          className="btn btn-sm btn-ghost border-0 px-2"
          onClick={openTokenDetail}
          aria-label={t('wallet.assetDetailOpenToken')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </header>

      <section className="flex flex-col gap-2">
        <p className="m-0 text-5xl font-bold leading-none tracking-tight">{amountText}</p>
        <p className="m-0 text-[1.75rem] leading-tight text-base-content/60">
          {selectedHolding ? formatUsdAdaptive(valueUsd, i18n.language) : '--'}
        </p>
        <p className={`m-0 flex items-center gap-1 text-base font-medium ${priceChangeClassName}`}>
          <span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5" />
              <path d="M6 11l6-6 6 6" />
            </svg>
          </span>
          <span>{formatPct(priceChangePct)}</span>
        </p>
      </section>

      <section className="grid grid-cols-3 gap-3 pt-1">
        <button
          ref={topUpButtonRef}
          type="button"
          className="btn btn-outline text-base font-semibold"
          onClick={openTopUpModal}
        >
          {t('wallet.topUp')}
        </button>
        <button
          ref={transferButtonRef}
          type="button"
          className="btn btn-outline text-base font-semibold"
          onClick={openTransferModal}
          disabled={!selectedHolding}
        >
          {t('wallet.transfer')}
        </button>
        <button
          type="button"
          className="btn btn-primary text-base font-semibold"
          onClick={openTradeModal}
          disabled={!canTradeToken}
        >
          {t('wallet.trade')}
        </button>
      </section>

      {promoCards.length > 0 ? (
        <section className="grid grid-cols-2 gap-3">
          {promoCards.map((card) => (
            <article key={card.title} className="bg-base-200/40 p-3">
              <p className="m-0 text-sm text-base-content/60">{card.title}</p>
              <p className="m-0 mt-1 text-lg font-medium leading-tight">{card.summary}</p>
            </article>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 text-xl font-semibold">{t('wallet.assetDetailHistory')}</h2>
          <span className="text-base font-medium text-base-content/80">{t('wallet.assetDetailMore')}</span>
        </div>
        {historyRows.length > 0 ? (
          <div className="flex flex-col">
            {historyRows.map(({ row, direction, amountLabel, usdLabel }) => (
              <article key={row.id} className="flex items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-base-200 text-sm font-semibold text-base-content/70">
                    {getAssetInitial(displaySymbol, displayName)}
                  </div>
                  <div className="min-w-0">
                    <p className="m-0 truncate text-base font-semibold">{direction}</p>
                    <p className="m-0 truncate text-sm text-base-content/60">{amountLabel}</p>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p className="m-0 text-base font-semibold tabular-nums">{usdLabel}</p>
                  <p className={`m-0 text-sm tabular-nums ${priceChangeClassName}`}>{formatPct(priceChangePct)}</p>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="bg-base-200/40 p-4 text-sm text-base-content/60">{t('wallet.assetDetailHistoryEmpty')}</div>
        )}
      </section>

      <article className="bg-base-200/40 p-3">
        <p className="m-0 text-base font-medium">{t('wallet.assetDetailSecurityTitle')}</p>
        <p className="m-0 mt-1 text-sm text-base-content/60">{t('wallet.assetDetailSecuritySummary')}</p>
      </article>

      <article className="bg-base-200/40 p-3">
        <p className="m-0 text-base font-medium">{t('wallet.assetDetailTokenInfo')}</p>
        <p className="m-0 mt-1 text-sm text-base-content/60">{tokenInfoSummary}</p>
      </article>

      <button
        type="button"
        className="fixed bottom-0 left-1/2 z-30 w-full max-w-105 -translate-x-1/2 border-t border-base-300 bg-base-100 px-4 py-3 text-left"
        onClick={openTokenDetail}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col">
            <span className="text-sm uppercase text-base-content/60">{displaySymbol}</span>
            <span className="text-2xl font-semibold">{currentPrice != null ? formatUsdAdaptive(currentPrice, i18n.language) : '--'}</span>
          </div>
          <div className="h-10 w-[92px] overflow-hidden">
            {sparklinePath ? (
              <svg viewBox="0 0 90 32" className="h-full w-full" role="img" aria-label={displaySymbol}>
                <path d={sparklinePath} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-base-content" />
              </svg>
            ) : (
              <div className="h-full w-full bg-base-200/40" />
            )}
          </div>
        </div>
      </button>

      {isModalOpen && (
        <Modal visible originRect={null} onClose={closeModal}>
          <div className="relative flex-1 overflow-hidden">
            <div
              className={`absolute inset-0 transition-all duration-300 ${
                activeModalContent === 'topUp'
                  ? 'translate-x-0 opacity-100'
                  : 'pointer-events-none -translate-x-4 opacity-0'
              }`}
            >
              <TopUpContent
                active={activeModalContent === 'topUp'}
                onOpenReceive={openReceiveModal}
                onOpenTrade={openTradeFromTopUp}
                onClose={closeModal}
              />
            </div>
            <div
              className={`absolute inset-0 transition-all duration-300 ${
                activeModalContent === 'receive'
                  ? 'translate-x-0 opacity-100'
                  : 'pointer-events-none translate-x-4 opacity-0'
              }`}
            >
              <ReceiveCryptoContent
                walletAddress={walletAddress}
                supportedChains={supportedChains}
                onBack={backToTopUp}
                onCopyAddress={async () => {
                  if (!walletAddress) return;
                  await navigator.clipboard.writeText(walletAddress);
                }}
                onClose={closeModal}
              />
            </div>
            <div
              className={`absolute inset-0 transition-all duration-300 ${
                activeModalContent === 'transfer'
                  ? 'translate-x-0 opacity-100'
                  : 'pointer-events-none translate-x-4 opacity-0'
              }`}
            >
              <TransferContent
                active={activeModalContent === 'transfer'}
                presetAsset={presetTransferAsset}
                supportedChains={supportedChains}
                onBack={closeModal}
                onClose={closeModal}
                onSubmitted={() => {
                  closeModal();
                }}
              />
            </div>
            <div
              className={`absolute inset-0 transition-all duration-300 ${
                activeModalContent === 'trade'
                  ? 'translate-x-0 opacity-100'
                  : 'pointer-events-none translate-x-4 opacity-0'
              }`}
            >
              <TradeContent
                active={activeModalContent === 'trade'}
                preset={tradePreset}
                supportedChains={supportedChains}
                onBack={tradeBackTarget === 'topUp' ? backToTopUp : closeModal}
                onClose={closeModal}
                onSubmitted={() => {
                  closeModal();
                }}
              />
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
