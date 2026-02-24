import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getAgentArticles, getAgentRecommendations, getAgentTodayDaily, getWalletPortfolio } from '../../api';
import type { AuthState } from '../../hooks/useWalletApp';
import { BalanceHeader } from '../BalanceHeader';

type HomeScreenProps = {
  auth: AuthState;
  onOpenArticle: (articleId: string) => void;
};

export function HomeScreen({ auth, onOpenArticle }: HomeScreenProps) {
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

  const recommendations = useMemo(
    () => (recommendationsData?.recommendations ?? []).slice(0, 3),
    [recommendationsData],
  );
  const daily = dailyToday?.article ?? null;
  const lastReadyDaily = dailyToday?.lastReadyArticle ?? null;
  const topics = topicData?.articles ?? [];
  const totalBalance = portfolio?.totalUsd ?? 0;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? t('home.greetingMorning') : hour < 18 ? t('home.greetingAfternoon') : t('home.greetingEvening');

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

      <section className="bg-base-100">
        <p className="m-0 text-sm uppercase tracking-wide text-base-content/50">{t('home.agentEntryLabel')}</p>
        <h2 className="m-0 mt-2 text-xl font-bold">{greeting}</h2>
        <p className="m-0 mt-2 text-base text-base-content/70">{t('home.agentEntryHint')}</p>
        <button type="button" className="btn btn-primary mt-4 w-full text-base font-semibold">
          {t('home.agentEntryAction')}
        </button>
      </section>

      <section className="bg-base-100">
        <div className="flex items-start justify-between gap-3">
          <h2 className="m-0 text-lg font-bold">{t('home.dailyNewsTitle')}</h2>
          <span className="text-xs uppercase tracking-wide text-base-content/50">Personal Crypto Daily</span>
        </div>
        <p className="m-0 mt-2 text-base font-semibold">
          {daily?.title ?? t('home.todayDailyTitle', { date: dailyToday?.date ?? new Date().toISOString().slice(0, 10) })}
        </p>
        <p className="m-0 mt-2 text-base leading-snug text-base-content/75">
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
        <div className="mt-3 flex flex-col gap-3">
          {recommendations.length === 0 && (
            <p className="m-0 text-base text-base-content/70">{t('home.emptyRecommendations')}</p>
          )}
          {recommendations.map((item) => (
            <article key={item.id} className="border border-base-300 bg-base-200 p-3">
              <p className="m-0 text-base font-semibold">{item.title}</p>
              <p className="m-0 mt-1 text-sm text-base-content/70">{item.content}</p>
            </article>
          ))}
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
