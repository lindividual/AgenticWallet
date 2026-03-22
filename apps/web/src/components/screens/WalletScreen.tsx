import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Liveline } from 'liveline';
import type { LivelinePoint } from 'liveline';
import {
  getAppConfig,
  getCoinDetailsBatch,
  getWalletPortfolio,
  getWalletPortfolioSnapshots,
  type PortfolioSnapshotPeriod,
  type SimEvmBalance,
  type TransferRecord,
  type WalletPortfolioResponse,
} from '../../api';
import { Modal } from '../modals/Modal';
import { ReceiveCryptoContent } from '../modals/ReceiveCryptoContent';
import { TradeContent, type TradePreset } from '../modals/TradeContent';
import { TopUpContent } from '../modals/TopUpContent';
import { TransferContent } from '../modals/TransferContent';
import { snapshotRect, type RectSnapshot } from '../modals/morphTransition';
import { useToast } from '../../contexts/ToastContext';
import { useTheme } from '../../contexts/ThemeContext';
import type { AuthState } from '../../hooks/useWalletApp';
import type { AgentChatOpenRequest } from '../../agent/types';
import { AssetListItem } from '../AssetListItem';
import { BalanceHeader } from '../BalanceHeader';
import { CachedIconImage } from '../CachedIconImage';
import { SkeletonAssetListItem } from '../Skeleton';
import { formatUsdAdaptive } from '../../utils/currency';
import { cacheStores, readCache, writeCache } from '../../utils/indexedDbCache';
import { SettingsDropdown } from '../SettingsDropdown';
import { buildChainAssetId } from '../../utils/assetIdentity';
import { buildWalletAccountsFingerprint, normalizeContractForChain } from '../../utils/chainIdentity';
import { formatChartTimeLabel } from '../../utils/kline';
import { buildTransferableAssets } from '../../utils/transferAssets';
import { cloneTradeToken, getTradeTokenConfig } from '../../utils/tradeTokens';
import { getHiddenWalletAssetKeys } from '../../utils/walletHiddenAssets';

type WalletScreenProps = {
  auth: AuthState;
  onLogout: () => void;
  onOpenAssetDetail: (chain: string, contract: string) => void;
  onOpenAgentChat: (request?: AgentChatOpenRequest) => void;
};

type ActiveModalContent = 'topUp' | 'receive' | 'transfer' | 'trade';

const MODAL_CONTENT_SWITCH_MS = 280;

function formatTokenAmount(rawAmount: string | undefined, decimals: number | undefined): string {
  const amount = Number(rawAmount ?? 0);
  if (!Number.isFinite(amount)) return '0';

  const divisor = 10 ** (decimals ?? 0);
  const normalized = divisor > 0 ? amount / divisor : amount;
  return normalized.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function getAssetInitial(symbol: string | null | undefined, name: string | null | undefined): string {
  const label = (symbol ?? name ?? '').trim();
  if (!label) return '?';
  return label[0].toUpperCase();
}

type WalletHoldingListItem = {
  key: string;
  assetId: string | null;
  chainAssetId: string | null;
  symbol: string;
  name: string;
  logo: string | null;
  chainSummary: string;
  valueUsd: number;
  amountText: string;
  priceChangePct: number | null;
  transferAsset: SimEvmBalance;
};

const WALLET_PORTFOLIO_CACHE_TTL_MS = 10 * 60 * 1000;

function normalizeAssetId(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase();
  return value || null;
}

function normalizeChainAssetId(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  return value || null;
}

function normalizeIconUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
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
  const normalizedAssetId = (assetId ?? '').trim().toLowerCase();
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

function formatPct(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(2)}%`;
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

const BALANCE_CHART_PERIOD_OPTIONS: Array<{
  value: PortfolioSnapshotPeriod;
  labelKey: string;
}> = [
  { value: '24h', labelKey: 'wallet.balanceChartPeriod24h' },
  { value: '7d', labelKey: 'wallet.balanceChartPeriod7d' },
  { value: '30d', labelKey: 'wallet.balanceChartPeriod30d' },
];

const BALANCE_CHART_BUCKET_SECONDS: Record<PortfolioSnapshotPeriod, number> = {
  '24h': 3600,
  '7d': 86_400,
  '30d': 86_400,
};

function snapshotsToLivelinePoints(
  points: Array<{ ts: string; total_usd: number }> | undefined,
): LivelinePoint[] {
  if (!points || points.length === 0) return [];
  return points.map((p) => {
    let time = Date.parse(p.ts);
    if (!Number.isFinite(time)) time = 0;
    if (time >= 1e11) time = Math.round(time / 1000);
    return { time, value: p.total_usd };
  });
}

function resolveThemeColor(variable: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const probe = document.createElement('span');
  probe.style.color = `var(${variable})`;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color.trim();
  probe.remove();
  return resolved || fallback;
}

const STABLE_ASSET_IDS = new Set(['coingecko:usd-coin', 'coingecko:tether']);
const STABLE_SYMBOLS = new Set(['USDC', 'USDT']);
const PRICE_CHANGE_CACHE_TTL_MS = 5 * 60 * 1000;
const PRICE_CHANGE_FAILED_CACHE_TTL_MS = 60 * 1000;

function resolvePriceChangeLookupParams(
  asset: WalletHoldingListItem,
): { cacheKey: string; chain: string; contract: string } | null {
  const transferAsset = asset.transferAsset as SimEvmBalance & { market_chain?: string; contract_key?: string };
  const chain = (transferAsset.market_chain ?? transferAsset.chain ?? '').trim().toLowerCase();
  const contractCandidate = normalizeContractForChain(chain, transferAsset.contract_key ?? transferAsset.address);
  const isValidContract = chain === 'sol' || chain === 'tron'
    ? contractCandidate !== 'native'
    : /^0x[a-f0-9]{40}$/.test(contractCandidate);
  if (!chain || !isValidContract) return null;
  if (contractCandidate === '0x0000000000000000000000000000000000000000') return null;
  return {
    cacheKey: `${chain}:${contractCandidate}`,
    chain,
    contract: contractCandidate,
  };
}

function isHoldingVariantHidden(variant: SimEvmBalance, hiddenAssetKeys: Set<string>): boolean {
  if (hiddenAssetKeys.size === 0) return false;
  const hiddenKey = buildChainAssetId(
    (variant as SimEvmBalance & { market_chain?: string }).market_chain ?? variant.chain,
    (variant as SimEvmBalance & { contract_key?: string }).contract_key ?? variant.address,
  ).trim();
  return hiddenAssetKeys.has(hiddenKey);
}

function TokenAvatar({
  icon,
  symbol,
  name,
  fallbackLabel,
}: {
  icon: string | null;
  symbol: string;
  name: string;
  fallbackLabel: string;
}) {
  const [loadFailed, setLoadFailed] = useState(false);
  if (!icon || loadFailed) {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-base-300 text-base font-semibold text-base-content/70">
        {fallbackLabel}
      </div>
    );
  }
  return (
    <CachedIconImage
      src={icon}
      alt={symbol || name}
      className="h-10 w-10 rounded-full bg-base-300 object-cover"
      loading="lazy"
      onError={() => setLoadFailed(true)}
    />
  );
}

export function WalletScreen({ auth, onLogout, onOpenAssetDetail, onOpenAgentChat }: WalletScreenProps) {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { showError, showSuccess } = useToast();
  const queryClient = useQueryClient();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeModalContent, setActiveModalContent] = useState<ActiveModalContent>('topUp');
  const [exitingModalContent, setExitingModalContent] = useState<ActiveModalContent | null>(null);
  const [modalDirection, setModalDirection] = useState<1 | -1>(1);
  const [modalTransitionKey, setModalTransitionKey] = useState(0);
  const [modalVisible, setModalVisible] = useState(false);
  const [modalOriginRect, setModalOriginRect] = useState<RectSnapshot | null>(null);
  const [tradePreset, setTradePreset] = useState<TradePreset | null>(null);
  const [isStablesExpanded, setIsStablesExpanded] = useState(false);
  const [cachedPortfolio, setCachedPortfolio] = useState<WalletPortfolioResponse | null>(null);
  const [detailPriceChangeByHoldingKey, setDetailPriceChangeByHoldingKey] = useState<Record<string, number | null>>({});
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRafRef = useRef<number | null>(null);
  const modalSwitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailPriceChangeCacheRef = useRef<Map<string, { value: number | null; expiresAt: number }>>(new Map());
  const topUpButtonRef = useRef<HTMLButtonElement | null>(null);
  const transferButtonRef = useRef<HTMLButtonElement | null>(null);
  const tradeButtonRef = useRef<HTMLButtonElement | null>(null);
  const walletAddress = auth.wallet?.address ?? auth.wallet?.chainAccounts?.[0]?.address ?? '';
  const walletFingerprint = buildWalletAccountsFingerprint(auth.wallet?.chainAccounts, auth.wallet?.address);
  const [hiddenAssetKeys, setHiddenAssetKeys] = useState<Set<string>>(() => getHiddenWalletAssetKeys(walletAddress));

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['wallet-portfolio', walletFingerprint],
    queryFn: () => getWalletPortfolio(),
    enabled: Boolean(walletFingerprint),
    staleTime: 15_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
  const { data: appConfig } = useQuery({
    queryKey: ['app-config'],
    queryFn: getAppConfig,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const [balanceChartPeriod, setBalanceChartPeriod] = useState<PortfolioSnapshotPeriod>('24h');
  const [pendingChartPeriod, setPendingChartPeriod] = useState<PortfolioSnapshotPeriod | null>(null);

  const { data: snapshotData, isLoading: isSnapshotLoading } = useQuery({
    queryKey: ['wallet-portfolio-snapshots', walletFingerprint, balanceChartPeriod],
    queryFn: () => getWalletPortfolioSnapshots(balanceChartPeriod),
    enabled: Boolean(walletFingerprint),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const portfolioData = data ?? cachedPortfolio;
  const perpsAccount = portfolioData?.perpsAccount ?? null;
  const predictionAccount = portfolioData?.predictionAccount ?? null;
  const totalBalance = portfolioData?.totalUsd ?? 0;
  const perpsAccountValue = perpsAccount?.available && Number.isFinite(Number(perpsAccount.balanceUsd))
    ? formatUsdAdaptive(Number(perpsAccount.balanceUsd ?? 0), i18n.language)
    : t('wallet.accountUnavailableValue');
  const predictionAccountValue = predictionAccount?.available && Number.isFinite(Number(predictionAccount.balanceUsd))
    ? formatUsdAdaptive(Number(predictionAccount.balanceUsd ?? 0), i18n.language)
    : t('wallet.accountUnavailableValue');
  const supportedChains = appConfig?.supportedChains ?? [];
  const transferSupportedChains = useMemo(
    () => supportedChains.filter((chain) => chain.protocol === 'evm' || chain.protocol === 'svm' || chain.protocol === 'tvm' || chain.protocol === 'btc'),
    [supportedChains],
  );
  const tradeSupportedChains = useMemo(
    () => supportedChains.filter((chain) => chain.protocol === 'evm' || chain.protocol === 'svm'),
    [supportedChains],
  );
  const chainNameByNetworkKey = useMemo(
    () => new Map(supportedChains.map((chain) => [chain.networkKey, chain.name] as const)),
    [supportedChains],
  );
  const transferAvailableAssets = useMemo(
    () => buildTransferableAssets(portfolioData, { hiddenAssetKeys }),
    [hiddenAssetKeys, portfolioData],
  );

  useEffect(() => {
    setCachedPortfolio(null);
    setDetailPriceChangeByHoldingKey({});
    setIsStablesExpanded(false);
  }, [walletFingerprint]);

  useEffect(() => {
    setHiddenAssetKeys(getHiddenWalletAssetKeys(walletAddress));
  }, [walletAddress]);

  useEffect(() => {
    if (!walletFingerprint) return;
    const cacheKey = `wallet-portfolio:v2:${walletFingerprint}`;
    if (data) {
      void writeCache<WalletPortfolioResponse>(
        cacheStores.query,
        cacheKey,
        data,
        WALLET_PORTFOLIO_CACHE_TTL_MS,
      );
      return;
    }
    void readCache<WalletPortfolioResponse>(cacheStores.query, cacheKey).then((value) => {
      if (!value) return;
      setCachedPortfolio(value);
    });
  }, [data, walletFingerprint]);

  const holdings = useMemo<WalletHoldingListItem[]>(() => {
    if (!portfolioData) {
      return [];
    }

    const merged = portfolioData.mergedHoldings ?? [];
    if (merged.length > 0) {
      return [...merged]
        .filter((item) => !(item.variants ?? []).some((variant) => isHoldingVariantHidden(variant, hiddenAssetKeys)))
        .sort((a, b) => Number(b.total_value_usd ?? 0) - Number(a.total_value_usd ?? 0))
        .slice(0, 10)
        .flatMap((item) => {
          const variants = [...(item.variants ?? [])].sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
          const primary = variants[0];
          if (!primary) return [];

          const chainLabels = [
            ...new Set(
              variants
                .map((variant) => {
                  const fromConfig = chainNameByNetworkKey.get(variant.network_key);
                  if (fromConfig) return fromConfig;
                  if (variant.chain) return variant.chain.toUpperCase();
                  return variant.network_key || '--';
                })
                .filter(Boolean),
            ),
          ];
          const chainSummary =
            chainLabels.length > 1
              ? t('wallet.multiChainCount', { count: chainLabels.length })
              : t('wallet.singleChainLabel', { chain: chainLabels[0] ?? '--' });
          const symbol = (item.symbol ?? primary.symbol ?? '').trim().toUpperCase() || t('wallet.unknownAsset');
          const name = (item.name ?? primary.name ?? t('wallet.token')).trim();
          const chainAssetId = normalizeChainAssetId(
            primary.chain_asset_id ?? buildChainAssetId(primary.market_chain ?? primary.chain, primary.contract_key ?? primary.address),
          );
          const totalAmount = variants.reduce(
            (sum, variant) => sum + toDisplayAmount(variant.amount, variant.decimals),
            0,
          );

          return [
            {
              key: item.asset_id || `${primary.network_key}-${primary.address}`,
              assetId: normalizeAssetId(item.asset_id) ?? normalizeAssetId(primary.asset_id),
              chainAssetId,
              symbol,
              name,
              logo: resolveHoldingIcon(
                item.logo,
                primary.logo,
                primary.logo_uri,
                primary.url,
                resolveAssetIdFallbackIcon(normalizeAssetId(item.asset_id) ?? normalizeAssetId(primary.asset_id), symbol),
              ),
              chainSummary,
              valueUsd: Number(item.total_value_usd ?? primary.value_usd ?? 0),
              amountText: chainLabels.length > 1 ? formatDisplayAmount(totalAmount) : formatTokenAmount(primary.amount, primary.decimals),
              priceChangePct: null as number | null,
              transferAsset: primary,
            } satisfies WalletHoldingListItem,
          ];
        });
    }

    const grouped = [...portfolioData.holdings].reduce<Map<string, { totalValueUsd: number; variants: SimEvmBalance[] }>>(
      (acc, asset) => {
        const key = normalizeAssetId(asset.asset_id) ?? `${asset.network_key}:${asset.address?.toLowerCase() ?? ''}`;
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

    return Array.from(grouped.values())
      .filter((group) => !group.variants.some((variant) => isHoldingVariantHidden(variant, hiddenAssetKeys)))
      .sort((a, b) => b.totalValueUsd - a.totalValueUsd)
      .slice(0, 10)
      .flatMap((group) => {
        const variants = [...group.variants].sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
        const primary = variants[0];
        if (!primary) {
          return [];
        }
        const chainLabels = [
          ...new Set(
            variants
              .map((variant) => {
                const fromConfig = chainNameByNetworkKey.get(variant.network_key);
                if (fromConfig) return fromConfig;
                if (variant.chain) return variant.chain.toUpperCase();
                return variant.network_key || '--';
              })
              .filter(Boolean),
          ),
        ];
        const chainSummary =
          chainLabels.length > 1
            ? t('wallet.multiChainCount', { count: chainLabels.length })
            : t('wallet.singleChainLabel', { chain: chainLabels[0] ?? '--' });
        const symbol = (primary.symbol ?? primary.name ?? '').trim().toUpperCase() || t('wallet.unknownAsset');
        const name = (primary.name ?? t('wallet.token')).trim();
        const chainAssetId = normalizeChainAssetId(
          primary.chain_asset_id ?? buildChainAssetId(primary.chain, primary.address),
        );
        const totalAmount = variants.reduce(
          (sum, variant) => sum + toDisplayAmount(variant.amount, variant.decimals),
          0,
        );
        return {
          key: normalizeAssetId(primary.asset_id) ?? `${primary.network_key}-${primary.address}`,
          assetId: normalizeAssetId(primary.asset_id),
          chainAssetId,
          symbol,
          name,
          logo: resolveHoldingIcon(
            primary.logo,
            primary.logo_uri,
            primary.url,
            resolveAssetIdFallbackIcon(normalizeAssetId(primary.asset_id), symbol),
          ),
          chainSummary,
          valueUsd: group.totalValueUsd,
          amountText: chainLabels.length > 1 ? formatDisplayAmount(totalAmount) : formatTokenAmount(primary.amount, primary.decimals),
          priceChangePct: null as number | null,
          transferAsset: primary,
        } satisfies WalletHoldingListItem;
      })
      .sort((a, b) => b.valueUsd - a.valueUsd);
  }, [chainNameByNetworkKey, hiddenAssetKeys, portfolioData, t]);

  const stableAndCryptos = useMemo(() => {
    const stableHoldings = holdings.filter((asset) => {
      if (asset.assetId && STABLE_ASSET_IDS.has(asset.assetId)) return true;
      return STABLE_SYMBOLS.has(asset.symbol.trim().toUpperCase());
    });
    const cryptoHoldings = holdings.filter((asset) => !stableHoldings.includes(asset));
    const stablesUsd = stableHoldings.reduce((sum, item) => sum + Number(item.valueUsd ?? 0), 0);
    const cryptosUsd = cryptoHoldings.reduce((sum, item) => sum + Number(item.valueUsd ?? 0), 0);
    return { stableHoldings, cryptoHoldings, stablesUsd, cryptosUsd };
  }, [holdings]);

  const chartLine = useMemo<LivelinePoint[]>(
    () => snapshotsToLivelinePoints(snapshotData?.points),
    [snapshotData?.points],
  );

  const latestChartValue = chartLine.length > 0
    ? chartLine[chartLine.length - 1].value
    : totalBalance;

  const chartColor = useMemo(
    () => resolveThemeColor('--color-base-content', resolvedTheme === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)'),
    [resolvedTheme],
  );

  const chartWindow = useMemo(() => {
    if (chartLine.length < 2) return 86_400;
    const timeRange = chartLine[chartLine.length - 1].time - chartLine[0].time;
    return Math.max(timeRange, 3600);
  }, [chartLine]);

  const chartBucketSeconds = BALANCE_CHART_BUCKET_SECONDS[balanceChartPeriod];

  const isChartLoading = isSnapshotLoading && chartLine.length === 0;

  async function switchBalanceChartPeriod(nextPeriod: PortfolioSnapshotPeriod): Promise<void> {
    if (nextPeriod === balanceChartPeriod || pendingChartPeriod) return;
    setPendingChartPeriod(nextPeriod);
    try {
      await queryClient.fetchQuery({
        queryKey: ['wallet-portfolio-snapshots', nextPeriod],
        queryFn: () => getWalletPortfolioSnapshots(nextPeriod),
        staleTime: 60_000,
      });
      setBalanceChartPeriod(nextPeriod);
    } finally {
      setPendingChartPeriod(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    const cache = detailPriceChangeCacheRef.current;
    const pendingByCacheKey = new Map<string, { cacheKey: string; chain: string; contract: string; holdingKeys: string[] }>();
    const resolvedUpdates: Record<string, number | null> = {};

    for (const asset of stableAndCryptos.cryptoHoldings) {
      if (asset.priceChangePct !== null && asset.priceChangePct !== undefined) continue;
      const lookupParams = resolvePriceChangeLookupParams(asset);
      if (!lookupParams) continue;

      const cached = cache.get(lookupParams.cacheKey);
      if (cached && cached.expiresAt > now) {
        resolvedUpdates[asset.key] = cached.value;
        continue;
      }

      const existing = pendingByCacheKey.get(lookupParams.cacheKey);
      if (existing) {
        existing.holdingKeys.push(asset.key);
      } else {
        pendingByCacheKey.set(lookupParams.cacheKey, {
          cacheKey: lookupParams.cacheKey,
          chain: lookupParams.chain,
          contract: lookupParams.contract,
          holdingKeys: [asset.key],
        });
      }
    }

    if (Object.keys(resolvedUpdates).length > 0) {
      setDetailPriceChangeByHoldingKey((prev) => ({ ...prev, ...resolvedUpdates }));
    }
    if (pendingByCacheKey.size === 0) return;

    const pendingItems = [...pendingByCacheKey.values()];
    void getCoinDetailsBatch(
      pendingItems.map((item) => ({
        chain: item.chain,
        contract: item.contract,
      })),
    )
      .then((details) => {
        if (cancelled) return;
        const nowTs = Date.now();
        const valueByKey = new Map<string, number | null>();
        for (const item of details) {
          const value = Number.isFinite(Number(item.detail?.priceChange24h)) ? Number(item.detail?.priceChange24h) : null;
          valueByKey.set(item.key, value);
        }

        const updates: Record<string, number | null> = {};
        for (const pending of pendingItems) {
          const value = valueByKey.has(pending.cacheKey) ? valueByKey.get(pending.cacheKey) ?? null : null;
          cache.set(pending.cacheKey, { value, expiresAt: nowTs + PRICE_CHANGE_CACHE_TTL_MS });
          for (const holdingKey of pending.holdingKeys) {
            updates[holdingKey] = value;
          }
        }

        setDetailPriceChangeByHoldingKey((prev) => ({ ...prev, ...updates }));
      })
      .catch(() => {
        if (cancelled) return;
        const nowTs = Date.now();
        const updates: Record<string, number | null> = {};
        for (const pending of pendingItems) {
          cache.set(pending.cacheKey, { value: null, expiresAt: nowTs + PRICE_CHANGE_FAILED_CACHE_TTL_MS });
          for (const holdingKey of pending.holdingKeys) {
            updates[holdingKey] = null;
          }
        }
        setDetailPriceChangeByHoldingKey((prev) => ({ ...prev, ...updates }));
      });

    return () => {
      cancelled = true;
    };
  }, [stableAndCryptos.cryptoHoldings]);

  const shouldShowLoading = isLoading && !portfolioData;
  const shouldShowError = isError && !portfolioData;

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      if (modalSwitchTimerRef.current) clearTimeout(modalSwitchTimerRef.current);
      if (openRafRef.current !== null) cancelAnimationFrame(openRafRef.current);
    },
    [],
  );

  function showModal(originRect: RectSnapshot | null) {
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
    setExitingModalContent(null);
    setIsModalOpen(true);
    setModalOriginRect(originRect);
    setModalVisible(false);
    openRafRef.current = requestAnimationFrame(() => {
      setModalVisible(true);
      openRafRef.current = null;
    });
  }

  function switchModalContent(nextContent: ActiveModalContent, direction: 1 | -1) {
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

  function openTopUpModal() {
    setTradePreset(null);
    setActiveModalContent('topUp');
    showModal(snapshotRect(topUpButtonRef.current));
  }

  function buildTradePreset(mode: 'buy' | 'stableSwap'): TradePreset | null {
    const chain = tradeSupportedChains[0] ?? null;
    const networkKey = chain?.networkKey ?? 'ethereum-mainnet';
    const tokenConfig = getTradeTokenConfig(networkKey);
    if (!tokenConfig) {
      showError(t('wallet.tradeChainNotSupported'));
      return null;
    }

    if (mode === 'stableSwap') {
      return {
        mode: 'stableSwap',
        networkKey,
        sellToken: cloneTradeToken(tokenConfig.usdc),
        buyToken: cloneTradeToken(tokenConfig.usdt),
      };
    }

    return {
      mode: 'buy',
      networkKey,
      sellToken: cloneTradeToken(tokenConfig.usdc),
      buyToken: cloneTradeToken(tokenConfig.defaultBuy),
      assetSymbolForEvent: tokenConfig.defaultBuy.symbol,
    };
  }

  function openTradeModal(mode: 'buy' | 'stableSwap') {
    const preset = buildTradePreset(mode);
    if (!preset) return;
    setTradePreset(preset);
    setActiveModalContent('trade');
    showModal(snapshotRect(tradeButtonRef.current));
  }

  function openTradeFromTopUp(mode: 'buy' | 'stableSwap') {
    const preset = buildTradePreset(mode);
    if (!preset) return;
    setTradePreset(preset);
    switchModalContent('trade', 1);
  }

  function openTransferModal() {
    setTradePreset(null);
    setActiveModalContent('transfer');
    showModal(snapshotRect(transferButtonRef.current));
  }

  function openReceiveModal() {
    switchModalContent('receive', 1);
  }

  function backToTopUp() {
    switchModalContent('topUp', -1);
  }

  function closeActiveModal() {
    if (!isModalOpen) return;
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
          onClose={closeActiveModal}
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
          onClose={closeActiveModal}
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
          entryPoint="wallet"
          availableAssets={transferAvailableAssets}
          supportedChains={transferSupportedChains}
          onBack={closeActiveModal}
          onClose={closeActiveModal}
          onSubmitted={handleTransferSubmitted}
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
        onBack={backToTopUp}
        onClose={closeActiveModal}
        onSubmitted={handleTradeSubmitted}
        footerVisible={options.footerVisible}
        stageClassName={options.stageClassName}
      />
    );
  }

  function handleTransferSubmitted(transfer: TransferRecord) {
    console.log('[wallet-ui] transfer_submitted', {
      id: transfer.id,
      status: transfer.status,
      txHash: transfer.txHash,
      networkKey: transfer.networkKey,
    });
    void refetch();
  }

  function handleTradeSubmitted(result: { txHash: string; status: 'confirmed' | 'failed' | 'pending' }) {
    console.log('[wallet-ui] trade_submitted', {
      txHash: result.txHash,
      status: result.status,
    });
    void refetch();
  }

  function openHoldingDetail(asset: WalletHoldingListItem) {
    const routeAsset = asset.transferAsset as SimEvmBalance & {
      market_chain?: string;
      contract_key?: string;
    };
    onOpenAssetDetail(
      routeAsset.market_chain ?? routeAsset.chain,
      routeAsset.contract_key ?? routeAsset.address ?? '',
    );
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-5 pb-28">
      <BalanceHeader
        title={t('wallet.title')}
        balanceLabel={t('wallet.balance')}
        totalBalance={totalBalance}
        locale={i18n.language}
        rightAction={(
          <div className="flex items-center gap-2">
            {isFetching && (
              <span className="inline-flex items-center gap-1 text-xs text-base-content/60" aria-live="polite">
                <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                {t('wallet.refreshing')}
              </span>
            )}
            <SettingsDropdown onLogout={onLogout} />
          </div>
        )}
      />

      <section className="p-0">
        <div className="flex flex-wrap gap-2">
          {BALANCE_CHART_PERIOD_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`btn btn-xs border-0 px-3 ${balanceChartPeriod === option.value ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => void switchBalanceChartPeriod(option.value)}
              disabled={pendingChartPeriod != null}
            >
              {pendingChartPeriod === option.value ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                t(option.labelKey)
              )}
            </button>
          ))}
        </div>
        {isChartLoading ? (
          <div className="mt-3">
            <div className="h-48 overflow-hidden rounded-lg bg-base-200/30 px-2 py-2">
              <svg viewBox="0 0 640 150" className="h-full w-full" role="img" aria-label={t('wallet.balanceChartLoading')}>
                <defs>
                  <linearGradient id="loading-balance-line" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="currentColor" stopOpacity="0.3" />
                    <stop offset="50%" stopColor="currentColor" stopOpacity="0.9" />
                    <stop offset="100%" stopColor="currentColor" stopOpacity="0.3" />
                  </linearGradient>
                </defs>
                <line
                  x1="24"
                  y1="75"
                  x2="616"
                  y2="75"
                  stroke="url(#loading-balance-line)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  className="text-base-content/70"
                />
              </svg>
            </div>
          </div>
        ) : chartLine.length === 0 ? (
          <p className="m-0 mt-3 text-sm text-base-content/60">{t('wallet.balanceChartEmpty')}</p>
        ) : (
          <div className="mt-2 h-48 overflow-hidden p-0">
            <Liveline
              data={chartLine}
              value={latestChartValue}
              theme={resolvedTheme}
              color={chartColor}
              badge={false}
              window={chartWindow}
              formatValue={(value) => formatUsdAdaptive(value, i18n.language)}
              formatTime={(time) => formatChartTimeLabel(time, i18n.language, chartBucketSeconds)}
              grid={false}
              scrub
              fill
              padding={{ top: 6, right: 6, bottom: 6, left: 6 }}
            />
          </div>
        )}
      </section>

      <section className="mt-6 grid grid-cols-3 gap-3">
        <button
          ref={topUpButtonRef}
          type="button"
          className="btn btn-outline h-auto min-h-12 px-3 py-3 text-center text-base leading-tight font-semibold whitespace-normal"
          onClick={openTopUpModal}
        >
          {t('wallet.topUp')}
        </button>
        <button
          ref={transferButtonRef}
          type="button"
          className="btn btn-outline h-auto min-h-12 px-3 py-3 text-center text-base leading-tight font-semibold whitespace-normal"
          onClick={openTransferModal}
        >
          {t('wallet.transfer')}
        </button>
        <button
          type="button"
          ref={tradeButtonRef}
          className="btn btn-primary h-auto min-h-12 px-3 py-3 text-center text-base leading-tight font-semibold whitespace-normal"
          onClick={() => openTradeModal('buy')}
        >
          {t('wallet.trade')}
        </button>
      </section>

      <section className="flex flex-col gap-4">
        {shouldShowLoading && (
          <div className="flex flex-col gap-1" aria-label={t('wallet.loadingAssets')}>
            {Array.from({ length: 6 }).map((_, index) => (
              <SkeletonAssetListItem key={`wallet-skeleton-${index}`} className="bg-base-100 py-4" />
            ))}
          </div>
        )}
        {shouldShowError && (
          <div className="border border-error bg-error/10 p-4 text-xl text-error">
            {t('wallet.failedToLoadAssets', { message: (error as Error).message })}
          </div>
        )}
        {!shouldShowLoading && !shouldShowError && (
          <div className="flex flex-col">
            <article className="border-b border-base-300 py-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <h3 className="m-0 text-sm text-base-content">{t('wallet.stables')}</h3>
                  <p className="m-0 text-[1.75rem] font-bold leading-tight tabular-nums">
                    {formatUsdAdaptive(stableAndCryptos.stablesUsd, i18n.language)}
                  </p>
                </div>
                {stableAndCryptos.stableHoldings.length > 0 ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm min-h-0 px-2 text-sm"
                    aria-expanded={isStablesExpanded}
                    onClick={() => setIsStablesExpanded((value) => !value)}
                  >
                    {isStablesExpanded ? t('common.less') : t('common.more')}
                  </button>
                ) : null}
              </div>
              {isStablesExpanded && stableAndCryptos.stableHoldings.length > 0 ? (
                <div className="mt-3 flex flex-col">
                  {stableAndCryptos.stableHoldings.map((asset) => (
                    <AssetListItem
                      key={asset.key}
                      className="py-3"
                      onClick={() => openHoldingDetail(asset)}
                      leftIcon={(
                        <TokenAvatar
                          icon={asset.logo}
                          symbol={asset.symbol}
                          name={asset.name || t('wallet.token')}
                          fallbackLabel={getAssetInitial(asset.symbol, asset.name)}
                        />
                      )}
                      leftPrimary={asset.name || t('wallet.token')}
                      leftSecondary={`${asset.amountText} ${asset.symbol}`}
                      leftTertiary={asset.chainSummary}
                      rightPrimary={formatUsdAdaptive(asset.valueUsd, i18n.language)}
                    />
                  ))}
                </div>
              ) : null}
            </article>

            <article className="border-b border-base-300 py-5">
              <div className="flex flex-col gap-1">
                <h3 className="m-0 text-sm text-base-content">{t('wallet.cryptos')}</h3>
                <p className="m-0 text-[1.75rem] font-bold leading-tight tabular-nums">
                  {formatUsdAdaptive(stableAndCryptos.cryptosUsd, i18n.language)}
                </p>
              </div>
              <div className="mt-3 flex flex-col">
                {stableAndCryptos.cryptoHoldings.map((asset) => {
                  const resolvedPriceChangePct = asset.priceChangePct ?? detailPriceChangeByHoldingKey[asset.key] ?? null;
                  const changeClassName =
                    Number(resolvedPriceChangePct ?? 0) > 0
                      ? 'text-success'
                      : Number(resolvedPriceChangePct ?? 0) < 0
                        ? 'text-error'
                        : 'text-base-content/60';
                  return (
                    <AssetListItem
                      key={asset.key}
                      className="py-3"
                      onClick={() => openHoldingDetail(asset)}
                      leftIcon={
                        <TokenAvatar
                          icon={asset.logo}
                          symbol={asset.symbol}
                          name={asset.name || t('wallet.token')}
                          fallbackLabel={getAssetInitial(asset.symbol, asset.name)}
                        />
                      }
                      leftPrimary={asset.name || t('wallet.token')}
                      leftSecondary={`${asset.amountText} ${asset.symbol}`}
                      leftTertiary={asset.chainSummary}
                      rightPrimary={formatUsdAdaptive(asset.valueUsd, i18n.language)}
                      rightSecondary={<span className={changeClassName}>{formatPct(resolvedPriceChangePct)}</span>}
                    />
                  );
                })}
              </div>
            </article>

            <article className="border-b border-base-300 py-5">
              <div className="flex flex-col gap-1">
                <h3 className="m-0 text-sm text-base-content">{t('wallet.perpsAccount')}</h3>
                <p className="m-0 text-[1.75rem] font-bold leading-tight tabular-nums">
                  {perpsAccountValue}
                </p>
              </div>
            </article>

            <article className="border-b border-base-300 py-5">
              <div className="flex flex-col gap-1">
                <h3 className="m-0 text-sm text-base-content">{t('wallet.predictionAccount')}</h3>
                <p className="m-0 text-[1.75rem] font-bold leading-tight tabular-nums">
                  {predictionAccountValue}
                </p>
              </div>
            </article>
          </div>
        )}
      </section>

      {isModalOpen && (
        <Modal visible={modalVisible} originRect={modalOriginRect} onClose={closeActiveModal}>
          <div className="relative flex-1 overflow-hidden">
            {exitingModalContent ? (
              <div key={`exit-${exitingModalContent}-${modalTransitionKey}`} className="absolute inset-0 flex min-h-0">
                {renderModalPane(exitingModalContent, {
                  footerVisible: false,
                  stageClassName: getStageClassName('exit'),
                })}
              </div>
            ) : null}
            <div key={`active-${activeModalContent}-${modalTransitionKey}`} className="absolute inset-0 flex min-h-0">
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
