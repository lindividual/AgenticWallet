import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getAgentArticleDetail, getAgentArticles, getAgentRecommendations, getWalletPortfolio } from '../../api';
import type { AuthState } from '../../hooks/useWalletApp';
import { BalanceHeader } from '../BalanceHeader';

type HomeScreenProps = {
  auth: AuthState;
};

export function HomeScreen({ auth }: HomeScreenProps) {
  const { t, i18n } = useTranslation();
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
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

  const { data: dailyData } = useQuery({
    queryKey: ['home-agent-daily'],
    queryFn: () => getAgentArticles({ type: 'daily', limit: 1 }),
    staleTime: 45_000,
    refetchOnWindowFocus: true,
  });

  const { data: topicData } = useQuery({
    queryKey: ['home-agent-topic'],
    queryFn: () => getAgentArticles({ type: 'topic', limit: 3 }),
    staleTime: 45_000,
    refetchOnWindowFocus: true,
  });
  const {
    data: articleDetail,
    isLoading: isDetailLoading,
    isError: isDetailError,
    error: detailError,
  } = useQuery({
    queryKey: ['home-agent-article-detail', selectedArticleId],
    queryFn: () => getAgentArticleDetail(selectedArticleId as string),
    enabled: Boolean(selectedArticleId),
    staleTime: 45_000,
    refetchOnWindowFocus: true,
  });

  const recommendations = useMemo(
    () => (recommendationsData?.recommendations ?? []).slice(0, 3),
    [recommendationsData],
  );
  const daily = dailyData?.articles?.[0];
  const topics = topicData?.articles ?? [];
  const totalBalance = portfolio?.totalUsd ?? 0;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? t('home.greetingMorning') : hour < 18 ? t('home.greetingAfternoon') : t('home.greetingEvening');

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-6 pb-28">
      <BalanceHeader
        title={t('home.title')}
        balanceLabel={t('wallet.balance')}
        totalBalance={totalBalance}
        locale={i18n.language}
      />

      {selectedArticleId ? (
        <section className="border border-base-400 bg-base-100 p-4">
          <button type="button" className="btn btn-outline btn-sm h-8 min-h-0 px-3" onClick={() => setSelectedArticleId(null)}>
            {t('home.backToFeed')}
          </button>

          {isDetailLoading && <p className="m-0 mt-4 text-base text-base-content/70">{t('home.loadingArticle')}</p>}

          {isDetailError && (
            <p className="m-0 mt-4 text-base text-error">
              {t('home.loadArticleFailed', { message: (detailError as Error).message })}
            </p>
          )}

          {!isDetailLoading && !isDetailError && articleDetail && (
            <article className="mt-4">
              <p className="m-0 text-xs uppercase tracking-wide text-base-content/50">
                {articleDetail.article.type === 'daily' ? t('home.dailyNewsTitle') : t('home.topicRecommendationsTitle')}
              </p>
              <h2 className="m-0 mt-2 text-2xl font-bold">{articleDetail.article.title}</h2>
              <p className="m-0 mt-2 text-sm text-base-content/60">{new Date(articleDetail.article.created_at).toLocaleString(i18n.language)}</p>
              <div className="mt-4 border-t border-base-300 pt-4">
                <pre className="m-0 whitespace-pre-wrap break-words text-sm leading-7 font-sans">
                  {articleDetail.markdown}
                </pre>
              </div>
            </article>
          )}
        </section>
      ) : (
        <>
          <section className="border border-base-400 bg-base-100 p-4">
            <p className="m-0 text-sm uppercase tracking-wide text-base-content/50">{t('home.agentEntryLabel')}</p>
            <h2 className="m-0 mt-2 text-xl font-bold">{greeting}</h2>
            <p className="m-0 mt-2 text-base text-base-content/70">{t('home.agentEntryHint')}</p>
            <button type="button" className="btn btn-primary mt-4 w-full text-base font-semibold">
              {t('home.agentEntryAction')}
            </button>
          </section>

          <section className="border border-base-400 bg-base-100 p-4">
            <div className="flex items-start justify-between gap-3">
              <h2 className="m-0 text-lg font-bold">{t('home.dailyNewsTitle')}</h2>
              <span className="text-xs uppercase tracking-wide text-base-content/50">Personal Crypto Daily</span>
            </div>
            <p className="m-0 mt-2 text-base font-semibold">{daily?.title ?? t('home.emptyDailyTitle')}</p>
            <p className="m-0 mt-2 text-base leading-snug text-base-content/75">
              {daily?.summary ?? t('home.emptyDailySummary')}
            </p>
            {daily && (
              <button
                type="button"
                className="btn btn-outline btn-sm mt-3 h-8 min-h-0 px-3"
                onClick={() => setSelectedArticleId(daily.id)}
              >
                {t('home.readArticle')}
              </button>
            )}
          </section>

          <section className="border border-base-400 bg-base-100 p-4">
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

          <section className="border border-base-400 bg-base-100 p-4">
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
                    onClick={() => setSelectedArticleId(topic.id)}
                  >
                    {t('home.readArticle')}
                  </button>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </section>
  );
}
