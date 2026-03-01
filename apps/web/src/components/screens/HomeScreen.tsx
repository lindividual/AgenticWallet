import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getAgentArticles, getAgentRecommendations, getAgentTodayDaily, getMarketShelves, getWalletPortfolio, type TopMarketAsset } from '../../api';
import type { AuthState } from '../../hooks/useWalletApp';
import { BalanceHeader } from '../BalanceHeader';
import { AssetListItem } from '../AssetListItem';

type HomeScreenProps = {
  auth: AuthState;
  onOpenArticle: (articleId: string) => void;
  onOpenToken: (chain: string, contract: string) => void;
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

export function HomeScreen({ auth, onOpenArticle, onOpenToken }: HomeScreenProps) {
  const { t, i18n } = useTranslation();
  const walletAddress = auth.wallet?.address ?? auth.wallet?.chainAccounts?.[0]?.address ?? '';

  const { data: portfolio } = useQuery({
    queryKey: ['home-wallet-portfolio', walletAddress],
    queryFn: () => getWalletPortfolio(),
    enabled: Boolean(walletAddress),
    staleTime: 15_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });

  const { data: recommendationsData } = useQuery({
    queryKey: ['home-agent-recommendations'],
    queryFn: getAgentRecommendations,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const { data: shelfData } = useQuery({
    queryKey: ['home-market-shelves'],
    queryFn: () =>
      getMarketShelves({
        limitPerShelf: 10,
      }),
    staleTime: 60_000,
    refetchInterval: 90_000,
    refetchOnWindowFocus: true,
  });

  const { data: dailyToday } = useQuery({
    queryKey: ['home-agent-daily-today'],
    queryFn: getAgentTodayDaily,
    staleTime: 45_000,
    refetchOnWindowFocus: true,
    refetchInterval: 15_000,
  });

  const { data: topicData } = useQuery({
    queryKey: ['home-agent-topic'],
    queryFn: () => getAgentArticles({ type: 'topic', limit: 3 }),
    staleTime: 45_000,
    refetchOnWindowFocus: true,
  });

  const recommendations = useMemo<RecommendationDisplayAsset[]>(() => {
    const recommended = (recommendationsData?.recommendations ?? []).slice(0, 5);
    const marketAssets = (shelfData ?? []).flatMap((shelf) => shelf.assets);
    const byChainContract = new Map<string, TopMarketAsset>();
    const bySymbol = new Map<string, TopMarketAsset>();

    for (const asset of marketAssets) {
      const key = `${asset.chain.toLowerCase()}:${(asset.contract ?? '').toLowerCase()}`;
      if (!byChainContract.has(key)) byChainContract.set(key, asset);
      const symbol = (asset.symbol ?? '').trim().toUpperCase();
      if (symbol && !bySymbol.has(symbol)) bySymbol.set(symbol, asset);
    }

    return recommended
      .map((item) => {
        const assetMeta = item.asset;
        const symbol = (assetMeta?.symbol ?? item.title ?? '').trim().toUpperCase();
        const chain = (assetMeta?.chain ?? '').trim().toLowerCase();
        const contract = (assetMeta?.contract ?? '').trim().toLowerCase();
        const exactKey = chain ? `${chain}:${contract}` : '';
        const matched = (exactKey ? byChainContract.get(exactKey) : undefined) ?? (symbol ? bySymbol.get(symbol) : undefined);

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
  const daily = dailyToday?.article ?? null;
  const lastReadyDaily = dailyToday?.lastReadyArticle ?? null;
  const topics = topicData?.articles ?? [];
  const totalBalance = portfolio?.totalUsd ?? 0;

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
        locale={i18n.language}
      />

      {totalBalance <= 0 && (
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

      <section className="bg-base-100">
        <div className="flex items-start justify-between gap-3">
          <h2 className="m-0 text-lg font-bold">{t('home.dailyNewsTitle')}</h2>
          <span className="text-xs uppercase tracking-wide text-base-content/50">Personal Crypto Daily</span>
        </div>
        <p className="m-0 mt-2 text-base font-semibold">
          {daily?.title ?? t('home.todayDailyTitle', { date: dailyToday?.date ?? new Date().toISOString().slice(0, 10) })}
        </p>
        <p className="m-0 mt-2 truncate text-base leading-snug text-base-content/75">
          {dailySummary}
        </p>
        <div className="mt-3 flex items-center gap-2">
          {daily && (
            <button
              type="button"
              className="btn btn-outline btn-sm h-8 min-h-0 px-3"
              onClick={() => onOpenArticle(daily.id)}
            >
              {t('home.readArticle')}
            </button>
          )}
          {!daily && lastReadyDaily && (
            <button
              type="button"
              className="btn btn-ghost btn-sm h-8 min-h-0 px-3"
              onClick={() => onOpenArticle(lastReadyDaily.id)}
            >
              {t('home.readYesterday')}
            </button>
          )}
        </div>
      </section>

      <section className="bg-base-100">
        <h2 className="m-0 text-lg font-bold">{t('home.assetRecommendationsTitle')}</h2>
        <div className="mt-3 flex flex-col gap-1">
          {recommendations.length === 0 && (
            <p className="m-0 text-base text-base-content/70">{t('home.emptyRecommendations')}</p>
          )}
          {recommendations.map((item) => {
            const content = (
              <AssetListItem
                className="bg-base-100 py-3"
                leftIcon={
                  item.image ? (
                    <img
                      src={item.image}
                      alt={item.symbol}
                      className="h-10 w-10 rounded-full bg-base-300 object-cover"
                      loading="lazy"
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
            if (!chain || !contract) {
              return <div key={item.id}>{content}</div>;
            }

            return (
              <button
                key={item.id}
                type="button"
                className="w-full cursor-pointer px-2 text-left transition-colors hover:bg-base-200/60"
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
          {topics.length === 0 && <p className="m-0 text-base text-base-content/70">{t('home.emptyTopics')}</p>}
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
