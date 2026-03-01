import { useEffect, useRef, useState } from 'react';
import { useLocation, useMatch, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { BottomTabBar, type AppTab } from './components/BottomTabBar';
import { AuthScreen } from './components/screens/AuthScreen';
import { ArticleReaderScreen } from './components/screens/ArticleReaderScreen';
import { HomeScreen } from './components/screens/HomeScreen';
import { TokenDetailScreen } from './components/screens/TokenDetailScreen';
import { TradeScreen } from './components/screens/TradeScreen';
import { WalletScreen } from './components/screens/WalletScreen';
import { setAgentPreferredLocale, type TopMarketAsset } from './api';
import { useWalletApp } from './hooks/useWalletApp';

const ARTICLE_EXIT_MS = 220;
const TOKEN_EXIT_MS = 220;

export function App() {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const articleMatch = useMatch({ from: '/article/$articleId', shouldThrow: false });
  const tokenMatch = useMatch({ from: '/token/$chain/$contract', shouldThrow: false });
  const routeArticleId = articleMatch?.params.articleId ?? null;
  const isArticleRoute = Boolean(routeArticleId);
  const routeToken = tokenMatch?.params
    ? { chain: tokenMatch.params.chain, contract: tokenMatch.params.contract }
    : null;
  const isTokenRoute = Boolean(routeToken);

  const [activeArticleId, setActiveArticleId] = useState<string | null>(routeArticleId);
  const [isArticleExiting, setIsArticleExiting] = useState(false);
  const articleExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeTokenRoute, setActiveTokenRoute] = useState(routeToken);
  const [isTokenExiting, setIsTokenExiting] = useState(false);
  const tokenExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      if (tokenExitTimerRef.current) {
        clearTimeout(tokenExitTimerRef.current);
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

  useEffect(() => {
    if (routeToken) {
      setActiveTokenRoute(routeToken);
      setIsTokenExiting(false);
      return;
    }
    setActiveTokenRoute(null);
  }, [routeToken?.chain, routeToken?.contract]);

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

  function handleOpenToken(token: TopMarketAsset) {
    handleOpenTokenByRoute(token.chain, token.contract);
  }

  function handleOpenTokenByRoute(chain: string, contract: string) {
    if (tokenExitTimerRef.current) {
      clearTimeout(tokenExitTimerRef.current);
      tokenExitTimerRef.current = null;
    }
    setIsTokenExiting(false);
    setActiveTokenRoute({ chain, contract });
    void navigate({
      to: '/token/$chain/$contract',
      params: { chain, contract },
    });
  }

  function handleCloseToken() {
    if (!activeTokenRoute || isTokenExiting) return;
    setIsTokenExiting(true);
    if (tokenExitTimerRef.current) {
      clearTimeout(tokenExitTimerRef.current);
    }
    tokenExitTimerRef.current = setTimeout(() => {
      void navigate({ to: '/trade' });
      setIsTokenExiting(false);
      setActiveTokenRoute(null);
      tokenExitTimerRef.current = null;
    }, TOKEN_EXIT_MS);
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
      return (
        <HomeScreen
          auth={authenticatedState}
          onOpenArticle={handleOpenArticle}
          onOpenToken={handleOpenTokenByRoute}
        />
      );
    }
    if (activeTab === 'trade') return <TradeScreen onOpenToken={handleOpenToken} />;
    return <WalletScreen auth={authenticatedState} />;
  }

  return (
    <>
      <div className="min-h-screen overflow-x-hidden">
        {activeArticleId ? (
          <div className={isArticleExiting ? 'app-page-slide-out' : 'app-page-slide-in'}>
            <ArticleReaderScreen articleId={activeArticleId} onBack={handleCloseArticle} />
          </div>
        ) : activeTokenRoute ? (
          <div className={isTokenExiting ? 'app-page-slide-out' : 'app-page-slide-in'}>
            <TokenDetailScreen
              chain={activeTokenRoute.chain}
              contract={activeTokenRoute.contract}
              onBack={handleCloseToken}
            />
          </div>
        ) : (
          renderBaseScreen()
        )}
      </div>
      {!activeArticleId && !isTokenRoute && <BottomTabBar activeTab={activeTab} onTabChange={handleTabChange} />}
    </>
  );
}
