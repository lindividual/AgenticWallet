import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  getAppConfig,
  getCoinDetailsBatch,
  getMarketShelves,
  getWalletPortfolio,
  type SimEvmBalance,
  type TopMarketAsset,
  type TransferRecord,
  type WalletPortfolioResponse,
} from '../../api';
import { Modal } from '../modals/Modal';
import { ReceiveCryptoContent } from '../modals/ReceiveCryptoContent';
import { TopUpContent } from '../modals/TopUpContent';
import { TransferContent } from '../modals/TransferContent';
import { snapshotRect, type RectSnapshot } from '../modals/morphTransition';
import { useToast } from '../../contexts/ToastContext';
import type { AuthState } from '../../hooks/useWalletApp';
import { AssetListItem } from '../AssetListItem';
import { BalanceHeader } from '../BalanceHeader';
import { CachedIconImage } from '../CachedIconImage';
import { SkeletonAssetListItem } from '../Skeleton';
import { formatUsdAdaptive } from '../../utils/currency';
import { cacheStores, readCache, writeCache } from '../../utils/indexedDbCache';
import { SettingsDropdown } from '../SettingsDropdown';
import { buildChainAssetId } from '../../utils/assetIdentity';

type WalletScreenProps = {
  auth: AuthState;
  onLogout: () => void;
};

type ActiveModalContent = 'topUp' | 'receive' | 'transfer';
type TransferPresetAsset = {
  chainId: number;
  tokenAddress: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
};

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
  const value = (raw ?? '').trim().toLowerCase();
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

  const normalizedSymbol = symbol.trim().toUpperCase();
  if (normalizedSymbol === 'USDC') return '/usdc.svg';
  if (normalizedSymbol === 'USDT') return '/usdt.svg';
  if (normalizedSymbol === 'ETH') return '/eth.svg';
  if (normalizedSymbol === 'BNB') return '/bnb.svg';
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

function pickPreferredSymbolAsset(
  assets: TopMarketAsset[],
  preferredChain: string | null,
): TopMarketAsset | undefined {
  if (assets.length === 0) return undefined;
  const normalizedPreferred = (preferredChain ?? '').trim().toLowerCase();
  const chainPriority = new Map<string, number>([
    ['eth', 0],
    ['base', 1],
    ['bnb', 2],
  ]);
  const sorted = [...assets].sort((a, b) => {
    const aRank = chainPriority.get((a.chain ?? '').trim().toLowerCase()) ?? 9;
    const bRank = chainPriority.get((b.chain ?? '').trim().toLowerCase()) ?? 9;
    if (aRank !== bRank) return aRank - bRank;
    const aMcapRank = Number(a.market_cap_rank ?? Number.POSITIVE_INFINITY);
    const bMcapRank = Number(b.market_cap_rank ?? Number.POSITIVE_INFINITY);
    if (aMcapRank !== bMcapRank) return aMcapRank - bMcapRank;
    return Number(b.market_cap ?? 0) - Number(a.market_cap ?? 0);
  });
  if (!normalizedPreferred) return sorted[0];
  return sorted.find((asset) => (asset.chain ?? '').trim().toLowerCase() === normalizedPreferred) ?? sorted[0];
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
  const contractCandidate = (transferAsset.contract_key ?? transferAsset.address ?? '').trim().toLowerCase();
  const isValidContract = /^0x[a-f0-9]{40}$/.test(contractCandidate);
  if (!chain || !isValidContract) return null;
  if (contractCandidate === '0x0000000000000000000000000000000000000000') return null;
  return {
    cacheKey: `${chain}:${contractCandidate}`,
    chain,
    contract: contractCandidate,
  };
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

export function WalletScreen({ auth, onLogout }: WalletScreenProps) {
  const { t, i18n } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeModalContent, setActiveModalContent] = useState<ActiveModalContent>('topUp');
  const [modalVisible, setModalVisible] = useState(false);
  const [modalOriginRect, setModalOriginRect] = useState<RectSnapshot | null>(null);
  const [presetTransferAsset, setPresetTransferAsset] = useState<TransferPresetAsset | null>(null);
  const [cachedPortfolio, setCachedPortfolio] = useState<WalletPortfolioResponse | null>(null);
  const [detailPriceChangeByHoldingKey, setDetailPriceChangeByHoldingKey] = useState<Record<string, number | null>>({});
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRafRef = useRef<number | null>(null);
  const detailPriceChangeCacheRef = useRef<Map<string, { value: number | null; expiresAt: number }>>(new Map());
  const topUpButtonRef = useRef<HTMLButtonElement | null>(null);
  const transferButtonRef = useRef<HTMLButtonElement | null>(null);
  const walletAddress = auth.wallet?.address ?? auth.wallet?.chainAccounts?.[0]?.address ?? '';

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['wallet-portfolio', walletAddress],
    queryFn: () => getWalletPortfolio(),
    enabled: Boolean(walletAddress),
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
  const { data: shelfData } = useQuery({
    queryKey: ['wallet-market-shelves', 120],
    queryFn: () =>
      getMarketShelves({
        limitPerShelf: 120,
      }),
    staleTime: 60_000,
    refetchInterval: 90_000,
    refetchOnWindowFocus: true,
  });

  const portfolioData = data ?? cachedPortfolio;
  const totalBalance = portfolioData?.totalUsd ?? 0;
  const supportedChains = appConfig?.supportedChains ?? [];
  const chainNameById = useMemo(
    () => new Map(supportedChains.map((chain) => [chain.chainId, chain.name] as const)),
    [supportedChains],
  );

  useEffect(() => {
    setCachedPortfolio(null);
    setDetailPriceChangeByHoldingKey({});
  }, [walletAddress]);

  useEffect(() => {
    if (!walletAddress) return;
    const cacheKey = `wallet-portfolio:v1:${walletAddress.toLowerCase()}`;
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
  }, [data, walletAddress]);

  const marketChangeLookup = useMemo(() => {
    const byChainAssetId = new Map<string, TopMarketAsset>();
    const bySymbol = new Map<string, TopMarketAsset[]>();
    for (const asset of (shelfData ?? []).flatMap((shelf) => shelf.assets ?? [])) {
      const chainAssetId = normalizeChainAssetId(asset.chain_asset_id ?? buildChainAssetId(asset.chain, asset.contract));
      if (chainAssetId && !byChainAssetId.has(chainAssetId)) {
        byChainAssetId.set(chainAssetId, asset);
      }
      const symbol = (asset.symbol ?? '').trim().toUpperCase();
      if (!symbol) continue;
      const bucket = bySymbol.get(symbol);
      if (bucket) {
        bucket.push(asset);
      } else {
        bySymbol.set(symbol, [asset]);
      }
    }
    return { byChainAssetId, bySymbol };
  }, [shelfData]);

  const holdings = useMemo<WalletHoldingListItem[]>(() => {
    if (!portfolioData) {
      return [];
    }

    const merged = portfolioData.mergedHoldings ?? [];
    if (merged.length > 0) {
      return [...merged]
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
                  const fromConfig = chainNameById.get(Number(variant.chain_id));
                  if (fromConfig) return fromConfig;
                  if (variant.chain) return variant.chain.toUpperCase();
                  const fallbackChainId = Number(variant.chain_id);
                  return Number.isFinite(fallbackChainId) ? String(fallbackChainId) : '--';
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
          const matchedMarketAsset =
            (chainAssetId ? marketChangeLookup.byChainAssetId.get(chainAssetId) : undefined)
            ?? pickPreferredSymbolAsset(marketChangeLookup.bySymbol.get(symbol) ?? [], primary.market_chain ?? primary.chain ?? null);
          const totalAmount = variants.reduce(
            (sum, variant) => sum + toDisplayAmount(variant.amount, variant.decimals),
            0,
          );

          return [
            {
              key: item.asset_id || `${primary.chain_id}-${primary.address}`,
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
              valueUsd: Number(item.total_value_usd ?? primary.value_usd ?? 0),
              amountText: chainLabels.length > 1 ? formatDisplayAmount(totalAmount) : formatTokenAmount(primary.amount, primary.decimals),
              priceChangePct: matchedMarketAsset?.price_change_percentage_24h ?? null,
              transferAsset: primary,
            } satisfies WalletHoldingListItem,
          ];
        });
    }

    const grouped = [...portfolioData.holdings].reduce<Map<string, { totalValueUsd: number; variants: SimEvmBalance[] }>>(
      (acc, asset) => {
        const key = normalizeAssetId(asset.asset_id) ?? `${asset.chain_id}:${asset.address?.toLowerCase() ?? ''}`;
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
      .sort((a, b) => b.totalValueUsd - a.totalValueUsd)
      .slice(0, 10)
      .map((group) => {
        const variants = [...group.variants].sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
        const primary = variants[0];
        if (!primary) {
          return null;
        }
        const chainLabels = [
          ...new Set(
            variants
              .map((variant) => {
                const fromConfig = chainNameById.get(Number(variant.chain_id));
                if (fromConfig) return fromConfig;
                if (variant.chain) return variant.chain.toUpperCase();
                const fallbackChainId = Number(variant.chain_id);
                return Number.isFinite(fallbackChainId) ? String(fallbackChainId) : '--';
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
        const matchedMarketAsset =
          (chainAssetId ? marketChangeLookup.byChainAssetId.get(chainAssetId) : undefined)
          ?? pickPreferredSymbolAsset(marketChangeLookup.bySymbol.get(symbol) ?? [], primary.chain ?? null);
        const totalAmount = variants.reduce(
          (sum, variant) => sum + toDisplayAmount(variant.amount, variant.decimals),
          0,
        );
        return {
          key: normalizeAssetId(primary.asset_id) ?? `${primary.chain_id}-${primary.address}`,
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
          valueUsd: group.totalValueUsd,
          amountText: chainLabels.length > 1 ? formatDisplayAmount(totalAmount) : formatTokenAmount(primary.amount, primary.decimals),
          priceChangePct: matchedMarketAsset?.price_change_percentage_24h ?? null,
          transferAsset: primary,
        } satisfies WalletHoldingListItem;
      })
      .filter((item): item is WalletHoldingListItem => Boolean(item))
      .sort((a, b) => b.valueUsd - a.valueUsd);
  }, [chainNameById, marketChangeLookup.byChainAssetId, marketChangeLookup.bySymbol, portfolioData, t]);

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
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
      if (openRafRef.current !== null) {
        cancelAnimationFrame(openRafRef.current);
      }
    },
    [],
  );

  async function handleCopyAddress() {
    if (!walletAddress) {
      showError(t('wallet.addressUnavailable'));
      return;
    }

    try {
      await navigator.clipboard.writeText(walletAddress);
      showSuccess(t('wallet.addressCopied'));
    } catch (err) {
      showError(`${t('common.error')}: ${(err as Error).message}`);
    }
  }

  function showModal(originRect: RectSnapshot | null) {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (openRafRef.current !== null) {
      cancelAnimationFrame(openRafRef.current);
    }

    setIsModalOpen(true);
    setModalOriginRect(originRect);
    setModalVisible(false);
    openRafRef.current = requestAnimationFrame(() => {
      setModalVisible(true);
      openRafRef.current = null;
    });
  }

  function openTopUpModal() {
    setActiveModalContent('topUp');
    showModal(snapshotRect(topUpButtonRef.current));
  }

  function openTransferModal() {
    setPresetTransferAsset(null);
    setActiveModalContent('transfer');
    showModal(snapshotRect(transferButtonRef.current));
  }

  function openTransferModalFromAsset(asset: SimEvmBalance) {
    const tokenAddress = asset.address?.trim();
    const isValidTokenAddress = /^0x[a-fA-F0-9]{40}$/.test(tokenAddress ?? '');
    const isZeroAddress = (tokenAddress ?? '').toLowerCase() === '0x0000000000000000000000000000000000000000';
    const shouldPresetToken = isValidTokenAddress && !isZeroAddress;

    setPresetTransferAsset(
      shouldPresetToken
        ? {
            chainId: asset.chain_id,
            tokenAddress: tokenAddress!,
            tokenSymbol: asset.symbol,
            tokenDecimals: asset.decimals,
          }
        : null,
    );
    setActiveModalContent('transfer');
    showModal(null);
  }

  function openReceiveModal() {
    setActiveModalContent('receive');
  }

  function backToTopUp() {
    setActiveModalContent('topUp');
  }

  function closeActiveModal() {
    if (!isModalOpen) return;

    setModalVisible(false);
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = setTimeout(() => {
      setIsModalOpen(false);
      closeTimerRef.current = null;
    }, 300);
  }

  function handleTransferSubmitted(transfer: TransferRecord) {
    console.log('[wallet-ui] transfer_submitted', {
      id: transfer.id,
      status: transfer.status,
      txHash: transfer.txHash,
      chainId: transfer.chainId,
    });
    void refetch();
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

      <section className="grid grid-cols-3 gap-3 mt-6">
        <button
          ref={topUpButtonRef}
          type="button"
          className="btn btn-primary text-base font-semibold"
          onClick={openTopUpModal}
        >
          {t('wallet.topUp')}
        </button>
        <button
          ref={transferButtonRef}
          type="button"
          className="btn btn-primary text-base font-semibold"
          onClick={openTransferModal}
        >
          {t('wallet.transfer')}
        </button>
        <button type="button" className="btn btn-primary text-base font-semibold">
          {t('wallet.trade')}
        </button>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 text-xl font-bold">{t('wallet.holdings')}</h2>
          <button
            type="button"
            className="btn btn-outline btn-sm h-8 min-h-0 px-3"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? t('wallet.refreshing') : t('wallet.refresh')}
          </button>
        </div>

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
        {!shouldShowLoading && !shouldShowError && holdings.length === 0 && (
          <div className="bg-base-200 p-4 text-base">{t('wallet.noAssetsFound')}</div>
        )}
        {!shouldShowLoading && !shouldShowError && holdings.length > 0 && (
          <div className="flex flex-col gap-3">
            <article className="rounded-2xl border border-base-300 bg-base-100 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="m-0 text-base font-semibold">{t('wallet.stables')}</h3>
                <p className="m-0 text-base font-semibold tabular-nums">
                  {formatUsdAdaptive(stableAndCryptos.stablesUsd, i18n.language)}
                </p>
              </div>
            </article>

            <article className="rounded-2xl border border-base-300 bg-base-100 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="m-0 text-base font-semibold">{t('wallet.cryptos')}</h3>
                <p className="m-0 text-base font-semibold tabular-nums">
                  {formatUsdAdaptive(stableAndCryptos.cryptosUsd, i18n.language)}
                </p>
              </div>
              <div className="mt-2 flex flex-col">
                {stableAndCryptos.cryptoHoldings.length === 0 && (
                  <div className="py-2 text-sm text-base-content/60">{t('wallet.noAssetsFound')}</div>
                )}
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
                      onClick={() => openTransferModalFromAsset(asset.transferAsset)}
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
                      rightPrimary={formatUsdAdaptive(asset.valueUsd, i18n.language)}
                      rightSecondary={<span className={changeClassName}>{formatPct(resolvedPriceChangePct)}</span>}
                    />
                  );
                })}
              </div>
            </article>
          </div>
        )}
      </section>

      {isModalOpen && (
        <Modal visible={modalVisible} originRect={modalOriginRect} onClose={closeActiveModal}>
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
                onClose={closeActiveModal}
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
                onCopyAddress={() => {
                  void handleCopyAddress();
                }}
                onClose={closeActiveModal}
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
                onBack={closeActiveModal}
                onClose={closeActiveModal}
                onSubmitted={handleTransferSubmitted}
              />
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
