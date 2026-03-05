import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Newspaper } from 'lucide-react';
import {
  getAgentArticles,
  getAgentRecommendations,
  getAgentTodayDaily,
  getMarketShelves,
  getMarketWatchlist,
  getWalletPortfolio,
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
import { cacheStores, readCache, writeCache } from '../../utils/indexedDbCache';

type HomeScreenProps = {
  auth: AuthState;
  onOpenArticle: (articleId: string) => void;
  onOpenToken: (chain: string, contract: string) => void;
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

type RecommendationDisplayAsset = {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  priceChangePct: number | null;
  chain: string | null;
  contract: string | null;
};

type WatchlistCategory = 'crypto' | 'perps' | 'stock' | 'prediction';

function isOpenableCryptoWatch(asset: WatchlistAsset): boolean {
  if (asset.watch_type !== 'crypto') return false;
  if (asset.chain.startsWith('watch:')) return false;
  if (!asset.chain || !asset.contract) return false;
  if (asset.contract.toLowerCase() === 'native') return false;
  return /^0x[a-fA-F0-9]{40}$/.test(asset.contract);
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

const WALLET_PORTFOLIO_CACHE_TTL_MS = 10 * 60 * 1000;

export function HomeScreen({ auth, onOpenArticle, onOpenToken, onLogout }: HomeScreenProps) {
  const { t, i18n } = useTranslation();
  const walletAddress = auth.wallet?.address ?? auth.wallet?.chainAccounts?.[0]?.address ?? '';
  const [cachedPortfolio, setCachedPortfolio] = useState<WalletPortfolioResponse | null>(null);
  const [watchlistCategory, setWatchlistCategory] = useState<WatchlistCategory>('crypto');

  const { data: portfolio, isFetching: isPortfolioFetching, isPending: isPortfolioPending } = useQuery({
    queryKey: ['wallet-portfolio', walletAddress],
    queryFn: () => getWalletPortfolio(),
    enabled: Boolean(walletAddress),
    staleTime: 15_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    setCachedPortfolio(null);
  }, [walletAddress]);

  useEffect(() => {
    if (!walletAddress) return;
    const cacheKey = `wallet-portfolio:v1:${walletAddress.toLowerCase()}`;
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
  }, [portfolio, walletAddress]);

  const { data: recommendationsData, isLoading: isRecommendationsLoading } = useQuery({
    queryKey: ['home-agent-recommendations'],
    queryFn: getAgentRecommendations,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const { data: watchlistData, isLoading: isWatchlistLoading } = useQuery({
    queryKey: ['home-watchlist', 200],
    queryFn: () => getMarketWatchlist({ limit: 200 }),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

  const { data: shelfData, isLoading: isShelfLoading } = useQuery({
    queryKey: ['market-shelves', 10],
    queryFn: () =>
      getMarketShelves({
        limitPerShelf: 10,
      }),
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

  const recommendations = useMemo<RecommendationDisplayAsset[]>(() => {
    const recommended = (recommendationsData?.recommendations ?? []).slice(0, 5);
    const marketAssets = (shelfData ?? []).flatMap((shelf) => shelf.assets);
    const byChainAssetId = new Map<string, TopMarketAsset>();
    const bySymbol = new Map<string, TopMarketAsset[]>();

    for (const asset of marketAssets) {
      const chainAssetId = asset.chain_asset_id || buildChainAssetId(asset.chain, asset.contract);
      if (!byChainAssetId.has(chainAssetId)) byChainAssetId.set(chainAssetId, asset);

      const symbol = (asset.symbol ?? '').trim().toUpperCase();
      if (!symbol) continue;
      const bucket = bySymbol.get(symbol);
      if (bucket) {
        bucket.push(asset);
      } else {
        bySymbol.set(symbol, [asset]);
      }
    }

    return recommended
      .map((item) => {
        const assetMeta = item.asset;
        const symbol = (assetMeta?.symbol ?? item.title ?? '').trim().toUpperCase();
        const chain = (assetMeta?.chain ?? '').trim().toLowerCase();
        const contract = (assetMeta?.contract ?? '').trim().toLowerCase();
        const exactKey = chain ? buildChainAssetId(chain, contract) : '';
        const matched =
          (exactKey ? byChainAssetId.get(exactKey) : undefined)
          ?? (symbol ? pickPreferredSymbolAsset(bySymbol.get(symbol) ?? [], chain || null) : undefined);

        const displaySymbol = (matched?.symbol ?? symbol ?? '').toUpperCase();
        const displayName = matched?.name ?? assetMeta?.name ?? item.title ?? displaySymbol;
        return {
          id: item.id,
          symbol: displaySymbol,
          name: displayName,
          image: matched?.image ?? assetMeta?.image ?? null,
          priceChangePct: matched?.price_change_percentage_24h ?? assetMeta?.price_change_percentage_24h ?? null,
          chain: matched?.chain ?? assetMeta?.chain ?? null,
          contract: matched?.contract ?? assetMeta?.contract ?? null,
        };
      })
      .filter((item) => Boolean(item.symbol || item.name));
  }, [recommendationsData, shelfData]);
  const filteredWatchlist = useMemo(() => {
    return (watchlistData?.assets ?? []).filter((asset) => asset.watch_type === watchlistCategory);
  }, [watchlistCategory, watchlistData?.assets]);
  const daily = dailyToday?.article ?? null;
  const lastReadyDaily = dailyToday?.lastReadyArticle ?? null;
  const topics = topicData?.articles ?? [];
  const resolvedPortfolio = portfolio ?? cachedPortfolio;
  const totalBalance = resolvedPortfolio?.totalUsd ?? 0;
  const isBalanceLoading = Boolean(walletAddress) && !resolvedPortfolio && (isPortfolioPending || isPortfolioFetching);
  const shouldShowZeroBalanceCard = Boolean(resolvedPortfolio) && totalBalance <= 0;
  const shouldShowRecommendationSkeleton = recommendations.length === 0 && (isRecommendationsLoading || isShelfLoading);
  const shouldShowWatchlistSkeleton = filteredWatchlist.length === 0 && isWatchlistLoading;
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

      <section className="bg-base-100 mt-2">
        <h2 className="m-0 text-lg font-bold">{t('home.watchlistTitle')}</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {(['crypto', 'perps', 'stock', 'prediction'] as WatchlistCategory[]).map((category) => (
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
          {!shouldShowWatchlistSkeleton && filteredWatchlist.length === 0 && (
            <p className="m-0 text-base text-base-content/70">{t('home.watchlistEmpty')}</p>
          )}
          {filteredWatchlist.map((asset) => {
            const content = (
              <AssetListItem
                className="bg-base-100 py-3"
                leftIcon={
                  asset.image ? (
                    <CachedIconImage
                      src={asset.image}
                      alt={asset.symbol}
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
                      {getRecommendationInitial(asset.symbol || asset.name)}
                    </div>
                  )
                }
                leftPrimary={(asset.symbol ?? '').toUpperCase()}
                leftSecondary={asset.name}
                rightSecondary={formatPct(asset.change_24h)}
              />
            );

            if (isOpenableCryptoWatch(asset)) {
              return (
                <button
                  key={asset.id}
                  type="button"
                  className="w-full cursor-pointer text-start transition-colors hover:bg-base-200/60"
                  onClick={() => onOpenToken(asset.chain, asset.contract)}
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

      <section className="bg-base-100 mt-2">
        <h2 className="m-0 text-lg font-bold">{t('home.assetRecommendationsTitle')}</h2>
        <div className="mt-3 flex flex-col gap-1">
          {shouldShowRecommendationSkeleton && (
            <>
              {Array.from({ length: 4 }).map((_, index) => (
                <SkeletonAssetListItem key={`home-reco-skeleton-${index}`} className="bg-base-100 py-3" />
              ))}
            </>
          )}
          {!shouldShowRecommendationSkeleton && recommendations.length === 0 && (
            <p className="m-0 text-base text-base-content/70">{t('home.emptyRecommendations')}</p>
          )}
          {recommendations.map((item) => {
            const content = (
              <AssetListItem
                className="bg-base-100 py-3"
                leftIcon={
                  item.image ? (
                    <CachedIconImage
                      src={item.image}
                      alt={item.symbol}
                      className="h-10 w-10 rounded-full bg-base-300 object-cover"
                      loading="lazy"
                      fallback={(
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-base-300 text-base font-semibold text-base-content/70">
                          {getRecommendationInitial(item.symbol || item.name)}
                        </div>
                      )}
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-base-300 text-base font-semibold text-base-content/70">
                      {getRecommendationInitial(item.symbol || item.name)}
                    </div>
                  )
                }
                leftPrimary={(item.symbol ?? '').toUpperCase()}
                leftSecondary={item.name}
                rightSecondary={formatPct(item.priceChangePct)}
              />
            );

            const chain = item.chain;
            const contract = item.contract;
            if (!chain || contract == null) {
              return <div key={item.id}>{content}</div>;
            }

            return (
              <button
                key={item.id}
                type="button"
                className="w-full cursor-pointer text-start transition-colors hover:bg-base-200/60"
                onClick={() => onOpenToken(chain, contract)}
              >
                {content}
              </button>
            );
          })}
        </div>
      </section>

      <section className="bg-base-100">
        <h2 className="m-0 text-lg font-bold">{t('home.topicRecommendationsTitle')}</h2>
        <div className="mt-3 flex flex-col gap-3">
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
            <article key={topic.id} className="border border-base-300 bg-base-200 p-3">
              <p className="m-0 text-base font-semibold">{topic.title}</p>
              <p className="m-0 mt-1 text-sm text-base-content/70">{topic.summary}</p>
              <button
                type="button"
                className="btn btn-outline btn-sm mt-3 h-8 min-h-0 px-3"
                onClick={() => onOpenArticle(topic.id)}
              >
                {t('home.readArticle')}
              </button>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
