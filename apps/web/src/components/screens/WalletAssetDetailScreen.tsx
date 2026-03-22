import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { KlineCandle, SimEvmBalance, WalletPortfolioResponse } from '../../api';
import {
  getAppConfig,
  getCoinDetail,
  searchMarketTokens,
  getTokenSecurityAudit,
  getTokenKline,
  getTransferHistory,
  getWalletPortfolio,
} from '../../api';
import { formatUsdAdaptive } from '../../utils/currency';
import { encodeTokenContractParam } from '../../utils/tokenRoute';
import { buildTransferSelectableAsset } from '../../utils/transferAssets';
import { cloneTradeToken, getTradeTokenConfig } from '../../utils/tradeTokens';
import { buildChainAssetId } from '../../utils/assetIdentity';
import { CachedIconImage } from '../CachedIconImage';
import { Modal } from '../modals/Modal';
import { ReceiveCryptoContent } from '../modals/ReceiveCryptoContent';
import { snapshotRect, type RectSnapshot } from '../modals/morphTransition';
import { TopUpContent } from '../modals/TopUpContent';
import { TradeContent, type TradePreset } from '../modals/TradeContent';
import { TransferContent } from '../modals/TransferContent';
import type { AuthState } from '../../hooks/useWalletApp';
import type { AgentChatOpenRequest } from '../../agent/types';
import { useToast } from '../../contexts/ToastContext';
import { buildWalletAccountsFingerprint } from '../../utils/chainIdentity';
import { hideWalletAsset } from '../../utils/walletHiddenAssets';

type WalletAssetDetailScreenProps = {
  auth: AuthState;
  chain: string;
  contract: string;
  onBack: () => void;
  onOpenAgentChat: (request?: AgentChatOpenRequest) => void;
};

type ActiveModalContent = 'topUp' | 'receive' | 'transfer' | 'trade';

const MODAL_CONTENT_SWITCH_MS = 280;

type WalletAssetHolding = {
  assetId: string | null;
  symbol: string;
  name: string;
  logo: string | null;
  amountText: string;
  amountValue: number;
  valueUsd: number;
  matchedChainAssetId: string | null;
  variants: WalletAssetHoldingVariant[];
};

type WalletAssetHoldingVariant = {
  chainAssetId: string;
  chain: string;
  networkKey: string;
  contract: string;
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

function normalizeChainAssetId(raw: string | null | undefined): string | null {
  const value = normalizeText(raw);
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
  if (normalizedAssetId === 'coingecko:bitcoin') return '/btc.svg';

  const normalizedSymbol = symbol.trim().toUpperCase();
  if (normalizedSymbol === 'USDC') return '/usdc.svg';
  if (normalizedSymbol === 'USDT') return '/usdt.svg';
  if (normalizedSymbol === 'ETH') return '/eth.svg';
  if (normalizedSymbol === 'BNB') return '/bnb.svg';
  if (normalizedSymbol === 'BTC') return '/btc.svg';
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
  const value = normalizeText(raw);
  if (!value || value === 'native' || value === '0x0000000000000000000000000000000000000000') return 'native';
  return value.startsWith('0x') ? value.toLowerCase() : value;
}

function normalizeComparableAddress(raw: string | null | undefined): string {
  const value = normalizeText(raw);
  if (!value) return '';
  return value.startsWith('0x') ? value.toLowerCase() : value;
}

function matchesAssetVariant(variant: SimEvmBalance, chain: string, contract: string): boolean {
  const variantChain = normalizeLower((variant as SimEvmBalance & { market_chain?: string }).market_chain ?? variant.chain);
  const variantContract = normalizeContractForMatch(
    (variant as SimEvmBalance & { contract_key?: string }).contract_key ?? variant.address,
  );
  return variantChain === normalizeLower(chain) && variantContract === normalizeContractForMatch(contract);
}

function buildHoldingVariant(variant: SimEvmBalance): WalletAssetHoldingVariant {
  const enrichedVariant = variant as SimEvmBalance & {
    market_chain?: string;
    contract_key?: string;
    chain_asset_id?: string;
  };
  const chain = normalizeLower(enrichedVariant.market_chain ?? enrichedVariant.chain);
  const contract = normalizeText(enrichedVariant.contract_key ?? enrichedVariant.address);
  const chainAssetId = normalizeChainAssetId(
    enrichedVariant.chain_asset_id ?? buildChainAssetId(chain, contract),
  ) ?? buildChainAssetId(chain, contract);
  const amountValue = toDisplayAmount(variant.amount, variant.decimals);

  return {
    chainAssetId,
    chain,
    networkKey: normalizeText(variant.network_key) ?? '',
    contract: contract ?? '',
    amountText: formatDisplayAmount(amountValue),
    amountValue,
    valueUsd: Number(variant.value_usd ?? 0),
    transferAsset: variant,
  };
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
    const holdingVariants = variants.map(buildHoldingVariant);
    const matchedVariant = holdingVariants.find((variant) => matchesAssetVariant(variant.transferAsset, chain, contract)) ?? null;
    const primary = matchedVariant?.transferAsset ?? variants[0];
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
      matchedChainAssetId: matchedVariant?.chainAssetId ?? null,
      variants: holdingVariants,
    };
  }

  const grouped = [...portfolio.holdings].reduce<Map<string, { totalValueUsd: number; variants: SimEvmBalance[] }>>(
    (acc, asset) => {
      const key = normalizeAssetId(asset.asset_id) ?? `${asset.network_key}:${normalizeLower(asset.address)}`;
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
    const holdingVariants = variants.map(buildHoldingVariant);
    const matchedVariant = holdingVariants.find((variant) => matchesAssetVariant(variant.transferAsset, chain, contract)) ?? null;
    const primary = matchedVariant?.transferAsset ?? variants[0];
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
      matchedChainAssetId: matchedVariant?.chainAssetId ?? null,
      variants: holdingVariants,
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

function formatTaxPercent(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  return `${numeric.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(numeric) ? 0 : 2,
    maximumFractionDigits: 2,
  })}%`;
}

export function WalletAssetDetailScreen({ auth, chain, contract, onBack, onOpenAgentChat }: WalletAssetDetailScreenProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { showError, showSuccess } = useToast();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeModalContent, setActiveModalContent] = useState<ActiveModalContent>('topUp');
  const [exitingModalContent, setExitingModalContent] = useState<ActiveModalContent | null>(null);
  const [modalDirection, setModalDirection] = useState<1 | -1>(1);
  const [modalTransitionKey, setModalTransitionKey] = useState(0);
  const [modalVisible, setModalVisible] = useState(false);
  const [modalOriginRect, setModalOriginRect] = useState<RectSnapshot | null>(null);
  const [tradePreset, setTradePreset] = useState<TradePreset | null>(null);
  const [tradeBackTarget, setTradeBackTarget] = useState<'topUp' | 'close'>('close');
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRafRef = useRef<number | null>(null);
  const modalSwitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const topUpButtonRef = useRef<HTMLButtonElement | null>(null);
  const transferButtonRef = useRef<HTMLButtonElement | null>(null);
  const tradeButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const securitySectionRef = useRef<HTMLElement | null>(null);

  const normalizedChain = normalizeLower(chain);
  const normalizedContract = contract.trim();
  const walletAddress = auth.wallet?.address ?? auth.wallet?.chainAccounts?.[0]?.address ?? '';
  const walletFingerprint = buildWalletAccountsFingerprint(auth.wallet?.chainAccounts, auth.wallet?.address);
  const ownedWalletAddresses = useMemo(
    () =>
      new Set(
        [auth.wallet?.address, ...(auth.wallet?.chainAccounts?.map((item) => item.address) ?? [])]
          .map((value) => normalizeComparableAddress(value))
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
  const supportedChains = appConfig?.supportedChains ?? [];
  const chainNameByNetworkKey = useMemo(
    () => new Map(supportedChains.map((item) => [item.networkKey, item.name] as const)),
    [supportedChains],
  );
  const { data: portfolioData } = useQuery({
    queryKey: ['wallet-portfolio', walletFingerprint],
    queryFn: () => getWalletPortfolio(),
    enabled: Boolean(walletFingerprint),
    staleTime: 15_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
  const selectedHolding = useMemo(
    () => resolveSelectedHolding(portfolioData, normalizedChain, normalizedContract),
    [normalizedChain, normalizedContract, portfolioData],
  );
  const [activeChainAssetId, setActiveChainAssetId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedHolding) {
      setActiveChainAssetId(null);
      return;
    }
    const nextActiveChainAssetId = selectedHolding.matchedChainAssetId ?? selectedHolding.variants[0]?.chainAssetId ?? null;
    setActiveChainAssetId((current) => {
      if (current && selectedHolding.variants.some((variant) => variant.chainAssetId === current)) {
        return current;
      }
      return nextActiveChainAssetId;
    });
  }, [selectedHolding]);

  const activeVariant = useMemo(
    () => selectedHolding?.variants.find((variant) => variant.chainAssetId === activeChainAssetId)
      ?? selectedHolding?.variants.find((variant) => variant.chainAssetId === selectedHolding.matchedChainAssetId)
      ?? selectedHolding?.variants[0]
      ?? null,
    [activeChainAssetId, selectedHolding],
  );

  const detailChain = normalizeLower(activeVariant?.chain ?? normalizedChain);
  const detailContractCandidate = normalizeText(activeVariant?.contract ?? normalizedContract);
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
  const {
    data: securityAudit,
    isLoading: isSecurityAuditLoading,
    isError: isSecurityAuditError,
  } = useQuery({
    queryKey: ['wallet-asset-security', detailChain, detailContract],
    queryFn: () => getTokenSecurityAudit(detailChain, detailContract),
    enabled: Boolean(detailChain && detailContract),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
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
      activeVariant?.transferAsset.network_key ?? null,
      activeVariant ? normalizeContractForMatch(activeVariant.transferAsset.address) : null,
      selectedHolding?.symbol ?? null,
    ],
    queryFn: () =>
      getTransferHistory({
        limit: 50,
        networkKey: activeVariant?.transferAsset.network_key,
        chainId: activeVariant?.transferAsset.chain_id ?? undefined,
        tokenAddress:
          normalizeContractForMatch(activeVariant?.transferAsset.address) === 'native'
            ? null
            : normalizeText(activeVariant?.transferAsset.address) || undefined,
        tokenSymbol: selectedHolding?.symbol || undefined,
        assetType:
          normalizeContractForMatch(activeVariant?.transferAsset.address) === 'native'
            ? 'native'
            : 'erc20',
      }),
    enabled: Boolean(walletAddress && selectedHolding && activeVariant),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const { data: perpSearchResults } = useQuery({
    queryKey: ['wallet-asset-perp-search', selectedHolding?.symbol ?? ''],
    queryFn: () => searchMarketTokens(selectedHolding?.symbol ?? '', 8),
    enabled: Boolean(selectedHolding?.symbol),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const matchedPerpMarket = useMemo(
    () =>
      (perpSearchResults ?? []).find((item) => (
        item.marketType === 'perp'
        && item.source.trim().toLowerCase() === 'hyperliquid'
        && item.symbol.trim().toUpperCase() === (selectedHolding?.symbol ?? detail?.symbol ?? '').trim().toUpperCase()
      )) ?? null,
    [detail?.symbol, perpSearchResults, selectedHolding?.symbol],
  );

  const transferSupportedChains = useMemo(
    () => supportedChains.filter((item) => item.protocol === 'evm' || item.protocol === 'svm' || item.protocol === 'tvm' || item.protocol === 'btc'),
    [supportedChains],
  );
  const tradeSupportedChains = useMemo(
    () => supportedChains.filter((item) => item.protocol === 'evm' || item.protocol === 'svm'),
    [supportedChains],
  );
  const displaySymbol = (selectedHolding?.symbol ?? detail?.symbol ?? '').trim().toUpperCase() || t('wallet.unknownAsset');
  const displayName = (selectedHolding?.name ?? detail?.name ?? '').trim() || t('wallet.token');
  const displayLogo = selectedHolding?.logo ?? resolveHoldingIcon(detail?.image);
  const lockedTransferAsset = useMemo(
    () => (
      activeVariant && selectedHolding
        ? buildTransferSelectableAsset(activeVariant.transferAsset as SimEvmBalance & { market_chain?: string; contract_key?: string }, {
            assetId: selectedHolding.assetId,
            symbol: selectedHolding.symbol,
            name: selectedHolding.name,
            logo: selectedHolding.logo,
          })
        : null
    ),
    [activeVariant, selectedHolding],
  );
  const amountText = selectedHolding?.amountText ?? '--';
  const valueUsd = Number(selectedHolding?.valueUsd ?? 0);
  const activeChainLabel = useMemo(() => {
    if (!activeVariant) return normalizedChain.toUpperCase();
    return chainNameByNetworkKey.get(activeVariant.networkKey)
      ?? normalizeText(activeVariant.transferAsset.chain)?.toUpperCase()
      ?? activeVariant.networkKey
      ?? normalizedChain.toUpperCase();
  }, [activeVariant, chainNameByNetworkKey, normalizedChain]);
  const assetScopeLabel = selectedHolding
    ? selectedHolding.variants.length > 1
      ? t('wallet.assetDetailAcrossChains', { count: selectedHolding.variants.length })
      : activeChainLabel
    : null;
  const currentPrice = Number.isFinite(Number(detail?.currentPriceUsd))
    ? Number(detail?.currentPriceUsd)
    : selectedHolding && selectedHolding.amountValue > 0
      ? valueUsd / selectedHolding.amountValue
      : null;
  const priceChangePct = Number.isFinite(Number(detail?.priceChange24h)) ? Number(detail?.priceChange24h) : null;
  const priceChangeClassName = toneClass(priceChangePct);
  const sparklinePath = useMemo(() => buildSparklinePath(klineData, 90, 28), [klineData]);
  const supportedTradeNetworkKey = activeVariant?.transferAsset.network_key ?? null;
  const supportedTradeChain = activeVariant?.transferAsset.chain_id ?? null;
  const tradeTokenConfig = supportedTradeNetworkKey ? getTradeTokenConfig(supportedTradeNetworkKey) : null;
  const tradeTokenAddress = normalizeText(activeVariant?.transferAsset.address);
  const canTradeToken = Boolean(
    supportedTradeChain
      && tradeTokenConfig
      && /^0x[a-fA-F0-9]{40}$/.test(tradeTokenAddress)
      && normalizeContractForMatch(tradeTokenAddress) !== 'native',
  );
  const canTransferAsset = Boolean(lockedTransferAsset);
  const hasPerpCard = Boolean(
    matchedPerpMarket,
  );
  const chainBreakdownItems = useMemo(
    () => (selectedHolding?.variants ?? []).map((variant) => {
      const chainLabel = chainNameByNetworkKey.get(variant.networkKey)
        ?? normalizeText(variant.transferAsset.chain)?.toUpperCase()
        ?? variant.networkKey
        ?? '--';
      const share = valueUsd > 0 ? variant.valueUsd / valueUsd : 0;
      return {
        ...variant,
        chainLabel,
        share,
        isActive: variant.chainAssetId === activeVariant?.chainAssetId,
      };
    }),
    [activeVariant?.chainAssetId, chainNameByNetworkKey, selectedHolding?.variants, valueUsd],
  );

  const historyRows = useMemo(() => {
    const rows = transferHistory?.transfers ?? [];

    return rows
      .slice(0, 3)
      .map((row) => {
        const direction = ownedWalletAddresses.has(normalizeComparableAddress(row.toAddress))
          ? t('wallet.assetDetailEventReceive')
          : ownedWalletAddresses.has(normalizeComparableAddress(row.fromAddress))
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

  const securitySummary = useMemo(() => {
    if (!detailContract) return t('wallet.assetDetailSecurityUnsupported');
    if (isSecurityAuditLoading) return t('wallet.assetDetailSecurityLoading');
    if (isSecurityAuditError || !securityAudit) return t('wallet.assetDetailSecurityUnavailable');
    if (!securityAudit.supported) return t('wallet.assetDetailSecurityUnsupported');
    if (securityAudit.checking) return t('wallet.assetDetailSecurityChecking');
    if (securityAudit.highRisk) {
      return t('wallet.assetDetailSecurityHighRisk', { count: securityAudit.riskCount });
    }
    if (securityAudit.riskCount > 0 || securityAudit.warnCount > 0) {
      return t('wallet.assetDetailSecurityWarnings', {
        riskCount: securityAudit.riskCount,
        warnCount: securityAudit.warnCount,
      });
    }
    return t('wallet.assetDetailSecurityPassed', { count: securityAudit.totalChecks });
  }, [detailContract, isSecurityAuditError, isSecurityAuditLoading, securityAudit, t]);

  const securityMetrics = useMemo(() => {
    if (!securityAudit || !securityAudit.supported) return [] as Array<{
      label: string;
      value: string;
      valueClassName?: string;
    }>;

    const metrics: Array<{ label: string; value: string; valueClassName?: string }> = [
      {
        label: t('wallet.assetDetailSecurityRiskCount'),
        value: String(securityAudit.riskCount),
        valueClassName: securityAudit.riskCount > 0 ? 'text-error' : 'text-success',
      },
      {
        label: t('wallet.assetDetailSecurityWarnCount'),
        value: String(securityAudit.warnCount),
        valueClassName: securityAudit.warnCount > 0 ? 'text-warning' : 'text-base-content',
      },
      {
        label: t('wallet.assetDetailSecurityCheckCount'),
        value: String(securityAudit.totalChecks),
      },
      {
        label: t('wallet.assetDetailSecurityBuyTax'),
        value: formatTaxPercent(securityAudit.buyTax),
        valueClassName: Number(securityAudit.buyTax ?? 0) > 0 ? 'text-warning' : 'text-base-content',
      },
      {
        label: t('wallet.assetDetailSecuritySellTax'),
        value: formatTaxPercent(securityAudit.sellTax),
        valueClassName: Number(securityAudit.sellTax ?? 0) > 0 ? 'text-warning' : 'text-base-content',
      },
    ];

    const extraFlags: Array<{ enabled: boolean; label: string }> = [
      { enabled: securityAudit.highRisk, label: t('wallet.assetDetailSecurityHighRiskFlag') },
      { enabled: securityAudit.freezeAuth, label: t('wallet.assetDetailSecurityFreezeAuth') },
      { enabled: securityAudit.mintAuth, label: t('wallet.assetDetailSecurityMintAuth') },
      { enabled: securityAudit.cannotSellAll, label: t('wallet.assetDetailSecurityCannotSellAll') },
      { enabled: securityAudit.isProxy, label: t('wallet.assetDetailSecurityProxy') },
      { enabled: securityAudit.token2022, label: t('wallet.assetDetailSecurityToken2022') },
      { enabled: Number(securityAudit.top10HolderRiskLevel ?? 0) > 0, label: t('wallet.assetDetailSecurityTopHolderRisk') },
      { enabled: securityAudit.lpLock, label: t('wallet.assetDetailSecurityLpLock') },
    ];

    for (const flag of extraFlags) {
      if (!flag.enabled) continue;
      metrics.push({
        label: flag.label,
        value: t('wallet.assetDetailSecurityFlagged'),
        valueClassName: 'text-warning',
      });
    }

    return metrics.slice(0, 6);
  }, [securityAudit, t]);

  function openTokenDetail(): void {
    const nextChain = normalizeText(activeVariant?.chain ?? normalizedChain);
    const nextContract = normalizeText(activeVariant?.contract ?? normalizedContract);
    void navigate({
      to: '/token/$chain/$contract',
      params: {
        chain: nextChain,
        contract: encodeTokenContractParam(nextContract),
      },
    });
  }

  function showModal(content: ActiveModalContent, originRect: RectSnapshot | null = null): void {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (openRafRef.current !== null) {
      cancelAnimationFrame(openRafRef.current);
    }
    if (modalSwitchTimerRef.current) {
      clearTimeout(modalSwitchTimerRef.current);
      modalSwitchTimerRef.current = null;
    }
    setActiveModalContent(content);
    setExitingModalContent(null);
    setIsModalOpen(true);
    setModalOriginRect(originRect);
    setModalVisible(false);
    openRafRef.current = requestAnimationFrame(() => {
      setModalVisible(true);
      openRafRef.current = null;
    });
  }

  function closeModal(): void {
    setModalVisible(false);
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = setTimeout(() => {
      setIsModalOpen(false);
      setExitingModalContent(null);
      closeTimerRef.current = null;
    }, 300);
  }

  function switchModalContent(nextContent: ActiveModalContent, direction: 1 | -1): void {
    if (!isModalOpen || nextContent === activeModalContent) {
      setActiveModalContent(nextContent);
      setExitingModalContent(null);
      setModalDirection(direction);
      return;
    }
    if (modalSwitchTimerRef.current) {
      clearTimeout(modalSwitchTimerRef.current);
    }
    setModalDirection(direction);
    setExitingModalContent(activeModalContent);
    setActiveModalContent(nextContent);
    setModalTransitionKey((value) => value + 1);
    modalSwitchTimerRef.current = setTimeout(() => {
      setExitingModalContent(null);
      modalSwitchTimerRef.current = null;
    }, MODAL_CONTENT_SWITCH_MS);
  }

  function openTopUpModal(): void {
    setTradePreset(null);
    showModal('topUp', snapshotRect(topUpButtonRef.current));
  }

  function openReceiveModal(): void {
    switchModalContent('receive', 1);
  }

  function backToTopUp(): void {
    switchModalContent('topUp', -1);
  }

  function buildDefaultTradePreset(mode: 'buy' | 'stableSwap'): TradePreset | null {
    const chain = tradeSupportedChains[0] ?? null;
    const networkKey = chain?.networkKey ?? 'ethereum-mainnet';
    const config = getTradeTokenConfig(networkKey);
    if (!config) return null;

    if (mode === 'stableSwap') {
      return {
        mode: 'stableSwap',
        networkKey,
        sellToken: cloneTradeToken(config.usdc),
        buyToken: cloneTradeToken(config.usdt),
      };
    }

    return {
      mode: 'buy',
      networkKey,
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
    switchModalContent('trade', 1);
  }

  function openTransferModal(): void {
    if (!lockedTransferAsset) return;
    setTradePreset(null);
    showModal('transfer', snapshotRect(transferButtonRef.current));
  }

  function openTradeModal(): void {
    if (!canTradeToken || !tradeTokenConfig || !supportedTradeNetworkKey || !activeVariant) return;
    setTradeBackTarget('close');
    setTradePreset({
      mode: 'buy',
      networkKey: supportedTradeNetworkKey,
      sellToken: cloneTradeToken(tradeTokenConfig.usdc),
      buyToken: {
        address: tradeTokenAddress,
        symbol: displaySymbol,
        decimals: activeVariant.transferAsset.decimals,
      },
      assetSymbolForEvent: displaySymbol,
    });
    showModal('trade', snapshotRect(tradeButtonRef.current));
  }

  function getStageClassName(kind: 'enter' | 'exit'): string {
    if (modalDirection === 1) {
      return kind === 'enter' ? 'modal-sheet-enter-forward' : 'modal-sheet-exit-forward';
    }
    return kind === 'enter' ? 'modal-sheet-enter-backward' : 'modal-sheet-exit-backward';
  }

  function renderModalPane(
    content: ActiveModalContent,
    options: {
      footerVisible: boolean;
      stageClassName?: string;
    },
  ) {
    if (content === 'topUp') {
      return (
        <TopUpContent
          active={activeModalContent === 'topUp'}
          onOpenReceive={openReceiveModal}
          onOpenTrade={openTradeFromTopUp}
          onClose={closeModal}
          footerVisible={options.footerVisible}
          stageClassName={options.stageClassName}
        />
      );
    }
    if (content === 'receive') {
      return (
        <ReceiveCryptoContent
          walletAddress={walletAddress}
          chainAccounts={auth.wallet?.chainAccounts}
          supportedChains={supportedChains}
          onBack={backToTopUp}
          onCopyAddress={async (address: string) => {
            if (!address) return;
            await navigator.clipboard.writeText(address);
          }}
          onClose={closeModal}
          onOpenAgentChat={onOpenAgentChat}
          footerVisible={options.footerVisible}
          stageClassName={options.stageClassName}
        />
      );
    }
    if (content === 'transfer') {
      return (
        <TransferContent
          active={activeModalContent === 'transfer'}
          entryPoint="asset-detail"
          availableAssets={lockedTransferAsset ? [lockedTransferAsset] : []}
          lockedAsset={lockedTransferAsset}
          supportedChains={transferSupportedChains}
          onBack={closeModal}
          onClose={closeModal}
          onSubmitted={() => {
            closeModal();
          }}
          footerVisible={options.footerVisible}
          stageClassName={options.stageClassName}
        />
      );
    }
    return (
      <TradeContent
        active={activeModalContent === 'trade'}
        preset={tradePreset}
        supportedChains={tradeSupportedChains}
        onBack={tradeBackTarget === 'topUp' ? backToTopUp : closeModal}
        onClose={closeModal}
        onSubmitted={() => {
          closeModal();
        }}
        footerVisible={options.footerVisible}
        stageClassName={options.stageClassName}
      />
    );
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
    ? `${activeChainLabel} · ${truncateMiddle(detailContract)}`
    : `${activeChainLabel} · ${t('trade.nativeToken')}`;

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      if (modalSwitchTimerRef.current) clearTimeout(modalSwitchTimerRef.current);
      if (openRafRef.current !== null) cancelAnimationFrame(openRafRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!isMoreMenuOpen) return undefined;

    function handlePointerDown(event: PointerEvent): void {
      if (!moreMenuRef.current?.contains(event.target as Node)) {
        setIsMoreMenuOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setIsMoreMenuOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isMoreMenuOpen]);

  function toggleMoreMenu(): void {
    setIsMoreMenuOpen((current) => !current);
  }

  function openSecuritySection(): void {
    setIsMoreMenuOpen(false);
    securitySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function copyContractAddress(): Promise<void> {
    if (!detailContract) return;
    setIsMoreMenuOpen(false);
    try {
      await navigator.clipboard.writeText(detailContract);
      showSuccess(t('wallet.assetDetailContractCopied'));
    } catch (error) {
      showError(`${t('common.error')}: ${(error as Error).message}`);
    }
  }

  function handleDeleteToken(): void {
    const hiddenChain = normalizeText(activeVariant?.chain ?? normalizedChain);
    const hiddenContract = normalizeText(activeVariant?.contract ?? normalizedContract);
    hideWalletAsset(walletAddress, hiddenChain, hiddenContract);
    setIsMoreMenuOpen(false);
    showSuccess(t('wallet.assetDetailTokenDeleted'));
    onBack();
  }

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

        <div ref={moreMenuRef} className="relative shrink-0">
          <button
            type="button"
            className="btn btn-sm btn-ghost border-0 px-2"
            onClick={toggleMoreMenu}
            aria-label={t('wallet.assetDetailMenu')}
            aria-expanded={isMoreMenuOpen}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
              <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
              <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
            </svg>
          </button>
          {isMoreMenuOpen ? (
            <div className="absolute right-0 top-full z-30 mt-2 w-48 rounded-2xl border border-base-300 bg-base-100 p-2 shadow-lg">
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm text-base-content hover:bg-base-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                onClick={openSecuritySection}
              >
                <span>{t('wallet.assetDetailMenuSecurity')}</span>
              </button>
              {detailContract ? (
                <button
                  type="button"
                  className="flex w-full flex-col items-start rounded-xl px-3 py-2 text-left hover:bg-base-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  onClick={() => {
                    void copyContractAddress();
                  }}
                >
                  <span className="text-sm text-base-content">{t('wallet.assetDetailMenuContract')}</span>
                  <span className="mt-1 text-sm text-base-content/60">{truncateMiddle(detailContract, 8, 6)}</span>
                </button>
              ) : null}
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm text-error hover:bg-error/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/30"
                onClick={handleDeleteToken}
              >
                <span>{t('wallet.assetDetailMenuDeleteChain')}</span>
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <section className="flex flex-col gap-2">
        <p className="m-0 text-4xl font-bold leading-none tracking-tight">{amountText}</p>
        <p className="m-0 text-2xl leading-tight text-base-content/60">
          {selectedHolding ? formatUsdAdaptive(valueUsd, i18n.language) : '--'}
        </p>
        {assetScopeLabel ? (
          <p className="m-0 text-sm text-base-content/50">{assetScopeLabel}</p>
        ) : null}
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
          disabled={!canTransferAsset}
        >
          {t('wallet.transfer')}
        </button>
        <button
          type="button"
          ref={tradeButtonRef}
          className="btn btn-primary text-base font-semibold"
          onClick={openTradeModal}
          disabled={!canTradeToken}
        >
          {t('wallet.trade')}
        </button>
      </section>

      {chainBreakdownItems.length > 0 ? (
        <article className="bg-base-200/40 p-3">
          <div className="flex flex-col gap-1">
            <p className="m-0 text-base font-medium">{t('wallet.assetDetailChainBreakdown')}</p>
            <p className="m-0 text-sm text-base-content/60">{t('wallet.assetDetailCurrentChain')}: {activeChainLabel}</p>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {chainBreakdownItems.map((variant) => (
              <button
                key={variant.chainAssetId}
                type="button"
                className={[
                  'flex w-full items-center justify-between rounded-2xl border px-3 py-3 text-left transition-colors',
                  variant.isActive
                    ? 'border-primary/40 bg-base-100 shadow-sm'
                    : 'border-base-300 bg-base-100/60 hover:bg-base-100',
                ].join(' ')}
                onClick={() => setActiveChainAssetId(variant.chainAssetId)}
              >
                <div className="min-w-0">
                  <p className="m-0 flex items-center gap-2 text-sm font-semibold">
                    <span className="truncate">{variant.chainLabel}</span>
                    {variant.isActive ? (
                      <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                        {t('wallet.assetDetailCurrentChainBadge')}
                      </span>
                    ) : null}
                  </p>
                  <p className="m-0 mt-1 text-sm text-base-content/60">
                    {variant.amountText} {displaySymbol}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="m-0 text-sm font-semibold tabular-nums">
                    {formatUsdAdaptive(variant.valueUsd, i18n.language)}
                  </p>
                  <p className="m-0 mt-1 text-xs text-base-content/50">
                    {t('wallet.assetDetailChainShare', { share: `${Math.round(variant.share * 100)}%` })}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </article>
      ) : null}

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

      <article className="bg-base-200/40 p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="m-0 text-base font-medium">{t('wallet.assetDetailHistory')}</p>
          <span className="text-base-content/80" aria-hidden="true">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </span>
        </div>
        {historyRows.length > 0 ? (
          <div className="mt-3 flex flex-col">
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
          <div className="mt-3 rounded-lg bg-base-100/60 p-4 text-sm text-base-content/60">
            {t('wallet.assetDetailHistoryEmpty')}
          </div>
        )}
      </article>

      <article ref={securitySectionRef} className="bg-base-200/40 p-3">
        <p className="m-0 text-base font-medium">{t('wallet.assetDetailSecurityTitle')}</p>
        <p className="m-0 mt-1 text-sm text-base-content/60">{securitySummary}</p>
        {securityMetrics.length > 0 ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {securityMetrics.map((metric) => (
              <div key={metric.label} className="rounded-lg bg-base-100/60 px-3 py-2">
                <p className="m-0 text-sm text-base-content/50">{metric.label}</p>
                <p className={`m-0 mt-1 text-sm font-semibold ${metric.valueClassName ?? 'text-base-content'}`}>
                  {metric.value}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </article>

      <article className="bg-base-200/40 p-3">
        <p className="m-0 text-base font-medium">{t('wallet.assetDetailTokenInfo')}</p>
        <p className="m-0 mt-1 text-sm text-base-content/60">{tokenInfoSummary}</p>
      </article>

      <button
        type="button"
        className="fixed bottom-0 left-1/2 z-30 w-full max-w-105 -translate-x-1/2 border-t border-base-300 bg-base-100 px-5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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
        <Modal visible={modalVisible} originRect={modalOriginRect} onClose={closeModal}>
          <div className="relative flex-1 overflow-hidden">
            {exitingModalContent ? (
              <div key={`exit-${exitingModalContent}-${modalTransitionKey}`} className="absolute inset-0 flex min-h-0 w-full">
                {renderModalPane(exitingModalContent, {
                  footerVisible: false,
                  stageClassName: getStageClassName('exit'),
                })}
              </div>
            ) : null}
            <div key={`active-${activeModalContent}-${modalTransitionKey}`} className="absolute inset-0 flex min-h-0 w-full">
              {renderModalPane(activeModalContent, {
                footerVisible: true,
                stageClassName: exitingModalContent ? getStageClassName('enter') : undefined,
              })}
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
