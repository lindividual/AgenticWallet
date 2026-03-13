import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Newspaper } from 'lucide-react';
import {
  getAgentArticles,
  getAgentTodayDaily,
  getCoinDetailsBatch,
  getMarketWatchlist,
  getWalletPortfolio,
  type CoinDetail,
  type TopMarketAsset,
  type WalletPortfolioResponse,
  type WatchlistAsset,
} from '../../api';
import type { AuthState } from '../../hooks/useWalletApp';
import { BalanceHeader } from '../BalanceHeader';
import { AssetListItem } from '../AssetListItem';
import { SettingsDropdown } from '../SettingsDropdown';
import { CachedIconImage } from '../CachedIconImage';
import { SkeletonAssetListItem, SkeletonBlock } from '../Skeleton';
import { buildChainAssetId } from '../../utils/assetIdentity';
import { buildWalletAccountsFingerprint, normalizeContractForChain } from '../../utils/chainIdentity';
import { cacheStores, readCache, writeCache } from '../../utils/indexedDbCache';

type HomeScreenProps = {
  auth: AuthState;
  onOpenArticle: (articleId: string) => void;
  onOpenToken: (chain: string, contract: string, tokenPreview?: TopMarketAsset) => void;
  onLogout: () => void;
};

function getRecommendationInitial(label: string): string {
  const normalized = label.trim();
  return normalized ? normalized[0].toUpperCase() : '?';
}

function formatPct(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(2)}%`;
}

type WatchlistDisplayAsset = WatchlistAsset & {
  displaySymbol: string;
  displayName: string;
  displayImage: string | null;
  displayChange24h: number | null;
  tokenPreview: TopMarketAsset | null;
};

type WatchlistCategory = 'crypto' | 'perps' | 'prediction';

function isOpenableCryptoWatch(asset: WatchlistAsset): boolean {
  if (asset.watch_type !== 'crypto') return false;
  if (asset.chain.startsWith('watch:')) return false;
  if (!asset.chain || asset.contract == null) return false;
  const contract = normalizeContractForChain(asset.chain, asset.contract);
  if (!contract || contract === 'native') return true;
  return asset.chain.trim().toLowerCase() === 'sol' ? contract !== 'native' : /^0x[a-f0-9]{40}$/.test(contract);
}

function normalizeLookupChain(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value.startsWith('watch:')) return null;
  return value;
}

function pickPreferredSymbolDetail(
  assets: CoinDetail[],
  preferredChain: string | null,
): CoinDetail | undefined {
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
    return aRank - bRank;
  });
  if (!normalizedPreferred) return sorted[0];
  return sorted.find((asset) => (asset.chain ?? '').trim().toLowerCase() === normalizedPreferred) ?? sorted[0];
}

function buildTopMarketAssetPreview(input: {
  chain: string;
  contract: string;
  symbol: string;
  name: string;
  image: string | null;
  currentPrice: number | null;
  priceChange24h: number | null;
  assetId?: string | null;
}): TopMarketAsset {
  const chain = input.chain.trim().toLowerCase();
  const contract = normalizeContractForChain(chain, input.contract);
  const chainAssetId = buildChainAssetId(chain, contract);
  return {
    id: chainAssetId,
    asset_id: (input.assetId ?? '').trim() || chainAssetId,
    chain_asset_id: chainAssetId,
    chain,
    contract,
    symbol: input.symbol,
    name: input.name,
    image: input.image,
    current_price: input.currentPrice,
    market_cap_rank: null,
    market_cap: null,
    price_change_percentage_24h: input.priceChange24h,
    turnover_24h: null,
    risk_level: null,
  };
}

const WALLET_PORTFOLIO_CACHE_TTL_MS = 10 * 60 * 1000;

export function HomeScreen({ auth, onOpenArticle, onOpenToken, onLogout }: HomeScreenProps) {
  const { t, i18n } = useTranslation();
  const walletAddress = auth.wallet?.address ?? auth.wallet?.chainAccounts?.[0]?.address ?? '';
  const walletFingerprint = buildWalletAccountsFingerprint(auth.wallet?.chainAccounts, auth.wallet?.address);
  const [cachedPortfolio, setCachedPortfolio] = useState<WalletPortfolioResponse | null>(null);
  const [watchlistCategory, setWatchlistCategory] = useState<WatchlistCategory>('crypto');

  const { data: portfolio, isFetching: isPortfolioFetching, isPending: isPortfolioPending } = useQuery({
    queryKey: ['wallet-portfolio', walletFingerprint],
    queryFn: () => getWalletPortfolio(),
    enabled: Boolean(walletFingerprint),
    staleTime: 15_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    setCachedPortfolio(null);
  }, [walletFingerprint]);

  useEffect(() => {
    if (!walletFingerprint) return;
    const cacheKey = `wallet-portfolio:v2:${walletFingerprint}`;
    if (portfolio) {
      void writeCache<WalletPortfolioResponse>(
        cacheStores.query,
        cacheKey,
        portfolio,
        WALLET_PORTFOLIO_CACHE_TTL_MS,
      );
      return;
    }
    void readCache<WalletPortfolioResponse>(cacheStores.query, cacheKey).then((value) => {
      if (!value) return;
      setCachedPortfolio(value);
    });
  }, [portfolio, walletFingerprint]);

  const { data: watchlistData, isLoading: isWatchlistLoading } = useQuery({
    queryKey: ['home-watchlist', 200],
    queryFn: () => getMarketWatchlist({ limit: 200 }),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

  const detailLookups = useMemo(() => {
    const output: Array<{ chain: string; contract: string }> = [];
    const seen = new Set<string>();
    const append = (chainRaw: string | null | undefined, contractRaw: string | null | undefined) => {
      const chain = normalizeLookupChain(chainRaw);
      if (!chain) return;
      const contract = normalizeContractForChain(chain, contractRaw);
      const key = buildChainAssetId(chain, contract);
      if (seen.has(key)) return;
      seen.add(key);
      output.push({ chain, contract });
    };

    for (const asset of watchlistData?.assets ?? []) {
      if (asset.watch_type !== 'crypto') continue;
      append(asset.chain, asset.contract);
    }

    return output.slice(0, 100);
  }, [watchlistData?.assets]);

  const { data: tokenDetailBatch } = useQuery({
    queryKey: ['home-token-details', detailLookups.map((item) => buildChainAssetId(item.chain, item.contract)).join(',')],
    queryFn: () => getCoinDetailsBatch(detailLookups),
    enabled: detailLookups.length > 0,
    staleTime: 60_000,
    refetchInterval: 90_000,
    refetchOnWindowFocus: true,
  });

  const { data: dailyToday, isLoading: isDailyLoading } = useQuery({
    queryKey: ['home-agent-daily-today'],
    queryFn: getAgentTodayDaily,
    staleTime: 45_000,
    refetchOnWindowFocus: (query) => {
      const data = query.state.data;
      return !(data?.status === 'ready' && data?.article);
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status === 'ready' && data?.article ? false : 15_000;
    },
  });

  const { data: topicData, isLoading: isTopicLoading } = useQuery({
    queryKey: ['home-agent-topic'],
    queryFn: () => getAgentArticles({ type: 'topic', limit: 3 }),
    staleTime: 45_000,
    refetchOnWindowFocus: true,
  });

  const tokenDetailLookup = useMemo(() => {
    const byChainAssetId = new Map<string, CoinDetail>();
    const bySymbol = new Map<string, CoinDetail[]>();
    for (const item of tokenDetailBatch ?? []) {
      const detail = item.detail;
      if (!detail) continue;
      const chainAssetId = (detail.chain_asset_id || buildChainAssetId(detail.chain, detail.contract)).trim().toLowerCase();
      if (chainAssetId && !byChainAssetId.has(chainAssetId)) byChainAssetId.set(chainAssetId, detail);
      const symbol = (detail.symbol ?? '').trim().toUpperCase();
      if (!symbol) continue;
      const bucket = bySymbol.get(symbol);
      if (bucket) {
        bucket.push(detail);
      } else {
        bySymbol.set(symbol, [detail]);
      }
    }
    return { byChainAssetId, bySymbol };
  }, [tokenDetailBatch]);

  const watchlistItems = useMemo<WatchlistDisplayAsset[]>(() => {
    const { byChainAssetId, bySymbol } = tokenDetailLookup;
    return (watchlistData?.assets ?? [])
      .filter((asset) => asset.watch_type === watchlistCategory)
      .map((asset) => {
        const rawSymbol = (asset.symbol ?? '').trim().toUpperCase();
        const chain = normalizeLookupChain(asset.chain);
        const contract = (asset.contract ?? '').trim().toLowerCase();
        const exactKey = chain ? buildChainAssetId(chain, contract) : '';
        const matched =
          (exactKey ? byChainAssetId.get(exactKey) : undefined)
          ?? (rawSymbol ? pickPreferredSymbolDetail(bySymbol.get(rawSymbol) ?? [], chain) : undefined);

        const displaySymbol = (rawSymbol || matched?.symbol || '').trim().toUpperCase();
        const rawName = (asset.name ?? '').trim();
        const displayName = rawName && rawName.toUpperCase() !== displaySymbol
          ? rawName
          : ((matched?.name ?? rawName) || displaySymbol);
        const tokenPreview =
          chain && contract != null
            ? buildTopMarketAssetPreview({
                chain,
                contract,
                symbol: displaySymbol || (asset.symbol ?? '').trim().toUpperCase(),
                name: displayName || asset.name,
                image: asset.image ?? matched?.image ?? null,
                currentPrice: matched?.currentPriceUsd ?? null,
                priceChange24h: asset.change_24h ?? matched?.priceChange24h ?? null,
                assetId: matched?.asset_id ?? null,
              })
            : null;

        return {
          ...asset,
          displaySymbol,
          displayName,
          displayImage: asset.image ?? matched?.image ?? null,
          displayChange24h: asset.change_24h ?? matched?.priceChange24h ?? null,
          tokenPreview,
        };
      });
  }, [tokenDetailLookup, watchlistCategory, watchlistData?.assets]);
  const daily = dailyToday?.article ?? null;
  const lastReadyDaily = dailyToday?.lastReadyArticle ?? null;
  const topics = topicData?.articles ?? [];
  const resolvedPortfolio = portfolio ?? cachedPortfolio;
  const totalBalance = resolvedPortfolio?.totalUsd ?? 0;
  const isBalanceLoading = Boolean(walletAddress) && !resolvedPortfolio && (isPortfolioPending || isPortfolioFetching);
  const shouldShowZeroBalanceCard = Boolean(resolvedPortfolio) && totalBalance <= 0;
  const hasWatchlistAssets = (watchlistData?.assets?.length ?? 0) > 0;
  const shouldShowWatchlistSkeleton = watchlistItems.length === 0 && isWatchlistLoading;
  const shouldRenderWatchlistSection = isWatchlistLoading || hasWatchlistAssets;
  const dailyArticleToOpen = daily ?? lastReadyDaily;

  const dailySummary = daily
    ? daily.summary
    : dailyToday?.status === 'failed'
      ? t('home.todayDailyFailed')
      : dailyToday?.status === 'stale'
        ? t('home.todayDailyStale')
        : t('home.todayDailyGenerating');

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-5 pb-28">
      <BalanceHeader
        title={t('home.title')}
        balanceLabel={t('wallet.balance')}
        totalBalance={totalBalance}
        isBalanceLoading={isBalanceLoading}
        locale={i18n.language}
        rightAction={(
          <div className="flex items-center gap-2">
            {isPortfolioFetching && (
              <span className="inline-flex items-center gap-1 text-xs text-base-content/60" aria-live="polite">
                <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                {t('wallet.refreshing')}
              </span>
            )}
            <SettingsDropdown onLogout={onLogout} />
          </div>
        )}
      />

      {shouldShowZeroBalanceCard && (
        <section className="rounded-2xl border border-base-300 bg-base-100 px-4 py-5 text-center">
          <img
            src="/UMI-Light.svg"
            alt={t('home.zeroBalanceTitle')}
            className="mx-auto h-24 w-24 object-contain"
            loading="lazy"
          />
          <h2 className="m-0 mt-3 text-lg font-bold">{t('home.zeroBalanceTitle')}</h2>
          <p className="m-0 mt-2 text-sm text-base-content/70">{t('home.zeroBalanceSubtitle')}</p>
        </section>
      )}


      <section className="mt-5 bg-base-200 p-4">
        {dailyArticleToOpen ? (
          <button
            type="button"
            className="w-full cursor-pointer border-0 bg-transparent p-0 text-left"
            onClick={() => onOpenArticle(dailyArticleToOpen.id)}
          >
            <div className="flex items-center gap-3">
              <div className="shrink-0 text-base-content p-2" aria-hidden="true">
                <Newspaper size={24} strokeWidth={2} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="m-0 text-base font-semibold">
                  {daily?.title ?? t('home.todayDailyTitle', { date: dailyToday?.date ?? new Date().toISOString().slice(0, 10) })}
                </p>
                <p className="m-0 mt-1 overflow-hidden text-sm leading-snug text-base-content/75 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                  {isDailyLoading && !daily && !lastReadyDaily ? (
                    <span className="flex flex-col gap-2">
                      <SkeletonBlock className="h-4 w-56" />
                      <SkeletonBlock className="h-4 w-40" />
                    </span>
                  ) : (
                    dailySummary
                  )}
                </p>
              </div>
            </div>
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <div className="shrink-0 text-base-content/60" aria-hidden="true">
              <Newspaper size={32} strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="m-0 text-lg font-semibold">
                {daily?.title ?? t('home.todayDailyTitle', { date: dailyToday?.date ?? new Date().toISOString().slice(0, 10) })}
              </p>
              <p className="m-0 mt-1 overflow-hidden text-sm leading-snug text-base-content/75 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                {isDailyLoading && !daily && !lastReadyDaily ? (
                  <span className="flex flex-col gap-2">
                    <SkeletonBlock className="h-4 w-56" />
                    <SkeletonBlock className="h-4 w-40" />
                  </span>
                ) : (
                  dailySummary
                )}
              </p>
            </div>
          </div>
        )}
      </section>

      {shouldRenderWatchlistSection && (
        <section className="bg-base-100 mt-2">
          <h2 className="m-0 text-lg font-bold">{t('home.watchlistTitle')}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {(['crypto', 'perps', 'prediction'] as WatchlistCategory[]).map((category) => (
              <button
                key={category}
                type="button"
                className={`btn btn-xs border-0 px-3 ${watchlistCategory === category ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setWatchlistCategory(category)}
              >
                {t(`home.watchlistCategory.${category}`)}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-col gap-1">
            {shouldShowWatchlistSkeleton && (
              <>
                {Array.from({ length: 3 }).map((_, index) => (
                  <SkeletonAssetListItem key={`home-watch-skeleton-${index}`} className="bg-base-100 py-3" />
                ))}
              </>
            )}
            {!shouldShowWatchlistSkeleton && watchlistItems.length === 0 && (
              <p className="m-0 text-base text-base-content/70">{t('home.watchlistEmpty')}</p>
            )}
            {watchlistItems.map((asset) => {
              const content = (
                <AssetListItem
                  className="bg-base-100 py-3"
                  leftIcon={
                    asset.displayImage ? (
                      <CachedIconImage
                        src={asset.displayImage}
                        alt={asset.displaySymbol}
                        className="h-10 w-10 rounded-full bg-base-300 object-cover"
                        loading="lazy"
                        fallback={(
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-base-300 text-base font-semibold text-base-content/70">
                            {getRecommendationInitial(asset.symbol || asset.name)}
                          </div>
                        )}
                      />
                    ) : (
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-base-300 text-base font-semibold text-base-content/70">
                        {getRecommendationInitial(asset.displaySymbol || asset.displayName)}
                      </div>
                    )
                  }
                  leftPrimary={asset.displaySymbol}
                  leftSecondary={asset.displayName}
                  rightSecondary={formatPct(asset.displayChange24h)}
                />
              );

              if (isOpenableCryptoWatch(asset)) {
                return (
                  <button
                    key={asset.id}
                    type="button"
                    className="w-full cursor-pointer text-start transition-colors hover:bg-base-200/60"
                    onClick={() =>
                      onOpenToken(
                        asset.tokenPreview?.chain ?? asset.chain,
                        asset.tokenPreview?.contract ?? asset.contract,
                        asset.tokenPreview ?? undefined,
                      )}
                  >
                    {content}
                  </button>
                );
              }

              if (asset.external_url) {
                return (
                  <a
                    key={asset.id}
                    href={asset.external_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-inherit no-underline"
                  >
                    {content}
                  </a>
                );
              }

              return <div key={asset.id}>{content}</div>;
            })}
          </div>
        </section>
      )}

      <section className="bg-base-100">
        <div className="flex flex-col gap-3">
          {isTopicLoading && topics.length === 0 && (
            <>
              <article className="border border-base-300 bg-base-200 p-3">
                <SkeletonBlock className="h-5 w-48" />
                <SkeletonBlock className="mt-3 h-3 w-full" />
                <SkeletonBlock className="mt-2 h-3 w-10/12" />
                <SkeletonBlock className="mt-3 h-8 w-24 rounded-lg" />
              </article>
              <article className="border border-base-300 bg-base-200 p-3">
                <SkeletonBlock className="h-5 w-44" />
                <SkeletonBlock className="mt-3 h-3 w-full" />
                <SkeletonBlock className="mt-2 h-3 w-9/12" />
                <SkeletonBlock className="mt-3 h-8 w-24 rounded-lg" />
              </article>
            </>
          )}
          {!isTopicLoading && topics.length === 0 && <p className="m-0 text-base text-base-content/70">{t('home.emptyTopics')}</p>}
          {topics.map((topic) => (
            <button
              key={topic.id}
              type="button"
              className="w-full cursor-pointer border border-base-300 bg-base-200 p-3 text-start transition-colors hover:bg-base-300/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              onClick={() => onOpenArticle(topic.id)}
            >
              <p className="m-0 text-base font-semibold">{topic.title}</p>
              <p className="m-0 mt-1 text-sm text-base-content/70">{topic.summary}</p>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}
