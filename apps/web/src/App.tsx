import { useEffect, useRef, useState } from 'react';
import { useLocation, useMatch, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { BottomTabBar, type AppTab } from './components/BottomTabBar';
import { AuthScreen } from './components/screens/AuthScreen';
import { ArticleReaderScreen } from './components/screens/ArticleReaderScreen';
import { HomeScreen } from './components/screens/HomeScreen';
import { TradeScreen } from './components/screens/TradeScreen';
import { WalletScreen } from './components/screens/WalletScreen';
import { setAgentPreferredLocale } from './api';
import { useWalletApp } from './hooks/useWalletApp';

const ARTICLE_EXIT_MS = 220;

export function App() {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const articleMatch = useMatch({ from: '/article/$articleId', shouldThrow: false });
  const routeArticleId = articleMatch?.params.articleId ?? null;
  const isArticleRoute = Boolean(routeArticleId);

  const [activeArticleId, setActiveArticleId] = useState<string | null>(routeArticleId);
  const [isArticleExiting, setIsArticleExiting] = useState(false);
  const articleExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {
    auth,
    authMode,
    loading,
    setAuthMode,
    handleLogin,
    handleRegister,
  } = useWalletApp();

  useEffect(
    () => () => {
      if (articleExitTimerRef.current) {
        clearTimeout(articleExitTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!auth) return;
    const locale = (i18n.resolvedLanguage ?? i18n.language ?? '').trim();
    if (!locale) return;
    setAgentPreferredLocale(locale).catch(() => undefined);
  }, [auth, i18n.language, i18n.resolvedLanguage]);

  useEffect(() => {
    if (routeArticleId) {
      setActiveArticleId(routeArticleId);
      setIsArticleExiting(false);
      return;
    }

    setActiveArticleId(null);
  }, [routeArticleId]);

  if (!auth) {
    return (
      <AuthScreen
        authMode={authMode}
        loading={loading}
        onLogin={handleLogin}
        onRegister={handleRegister}
        onAuthModeChange={setAuthMode}
      />
    );
  }

  const authenticatedState = auth;
  const pathname = location.pathname;
  const activeTab: AppTab = pathname.startsWith('/trade') ? 'trade' : pathname.startsWith('/wallet') ? 'wallet' : 'home';

  function handleOpenArticle(articleId: string) {
    if (isArticleRoute && routeArticleId === articleId) return;
    if (articleExitTimerRef.current) {
      clearTimeout(articleExitTimerRef.current);
      articleExitTimerRef.current = null;
    }
    setIsArticleExiting(false);
    setActiveArticleId(articleId);
    void navigate({
      to: '/article/$articleId',
      params: { articleId },
    });
  }

  function handleCloseArticle() {
    if (!activeArticleId) return;
    setIsArticleExiting(true);
    if (articleExitTimerRef.current) {
      clearTimeout(articleExitTimerRef.current);
    }
    articleExitTimerRef.current = setTimeout(() => {
      void navigate({ to: '/' });
      setIsArticleExiting(false);
      setActiveArticleId(null);
      articleExitTimerRef.current = null;
    }, ARTICLE_EXIT_MS);
  }

  function handleTabChange(tab: AppTab) {
    if (tab === 'home') {
      void navigate({ to: '/' });
      return;
    }
    if (tab === 'trade') {
      void navigate({ to: '/trade' });
      return;
    }
    void navigate({ to: '/wallet' });
  }

  function renderBaseScreen() {
    if (activeTab === 'home') {
      return <HomeScreen auth={authenticatedState} onOpenArticle={handleOpenArticle} />;
    }
    if (activeTab === 'trade') return <TradeScreen />;
    return <WalletScreen auth={authenticatedState} />;
  }

  return (
    <>
      <div className="min-h-screen overflow-x-hidden">
        {activeArticleId ? (
          <div className={isArticleExiting ? 'app-page-slide-out' : 'app-page-slide-in'}>
            <ArticleReaderScreen articleId={activeArticleId} onBack={handleCloseArticle} />
          </div>
        ) : (
          renderBaseScreen()
        )}
      </div>
      {!activeArticleId && <BottomTabBar activeTab={activeTab} onTabChange={handleTabChange} />}
    </>
  );
}
