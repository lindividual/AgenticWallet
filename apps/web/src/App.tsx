import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCanGoBack, useLocation, useMatch, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { BottomTabBar, type AppTab } from './components/BottomTabBar';
import { AuthScreen } from './components/screens/AuthScreen';
import { ArticleReaderScreen } from './components/screens/ArticleReaderScreen';
import { HomeScreen } from './components/screens/HomeScreen';
import { MarketDetailScreen } from './components/screens/MarketDetailScreen';
import { TokenDetailScreen } from './components/screens/TokenDetailScreen';
import { TradeScreen } from './components/screens/TradeScreen';
import { WalletScreen } from './components/screens/WalletScreen';
import { setAgentPreferredLocale, type TopMarketAsset } from './api';
import { useWalletApp } from './hooks/useWalletApp';
import { decodeTokenContractParam, encodeTokenContractParam } from './utils/tokenRoute';
import {
  normalizeTradeMarketDetailType,
  type TradeMarketDetailType,
} from './utils/tradeMarketDetail';

const ARTICLE_EXIT_MS = 220;
const TOKEN_EXIT_MS = 220;
const MARKET_EXIT_MS = 220;
const TOKEN_ROUTE_PREVIEW_QUERY_KEY = 'trade-token-route-preview';

export function App() {
  const { i18n } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const location = useLocation();
  const articleMatch = useMatch({ from: '/article/$articleId', shouldThrow: false });
  const tokenMatch = useMatch({ from: '/token/$chain/$contract', shouldThrow: false });
  const marketMatch = useMatch({ from: '/market/$marketType/$itemId', shouldThrow: false });
  const routeArticleId = articleMatch?.params.articleId ?? null;
  const isArticleRoute = Boolean(routeArticleId);
  const routeToken = tokenMatch?.params
    ? {
        chain: tokenMatch.params.chain.trim(),
        contract: decodeTokenContractParam(tokenMatch.params.contract),
      }
    : null;
  const isTokenRoute = Boolean(routeToken);
  const routeMarket = marketMatch?.params
    ? {
        marketType: normalizeTradeMarketDetailType(marketMatch.params.marketType),
        itemId: marketMatch.params.itemId.trim(),
      }
    : null;
  const isMarketRoute = Boolean(routeMarket?.marketType && routeMarket.itemId);

  const [activeArticleId, setActiveArticleId] = useState<string | null>(routeArticleId);
  const [isArticleExiting, setIsArticleExiting] = useState(false);
  const articleExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeTokenRoute, setActiveTokenRoute] = useState(routeToken);
  const [isTokenExiting, setIsTokenExiting] = useState(false);
  const tokenExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeMarketRoute, setActiveMarketRoute] = useState<{
    marketType: TradeMarketDetailType;
    itemId: string;
  } | null>(
    routeMarket?.marketType && routeMarket.itemId
      ? { marketType: routeMarket.marketType, itemId: routeMarket.itemId }
      : null,
  );
  const [isMarketExiting, setIsMarketExiting] = useState(false);
  const marketExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {
    auth,
    authMode,
    loading,
    setAuthMode,
    handleLogin,
    handleLogout,
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
      if (marketExitTimerRef.current) {
        clearTimeout(marketExitTimerRef.current);
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
    setIsTokenExiting(false);
  }, [routeToken?.chain, routeToken?.contract]);

  useEffect(() => {
    if (routeMarket?.marketType && routeMarket.itemId) {
      setActiveMarketRoute({
        marketType: routeMarket.marketType,
        itemId: routeMarket.itemId,
      });
      setIsMarketExiting(false);
      return;
    }
    setActiveMarketRoute(null);
    setIsMarketExiting(false);
  }, [routeMarket?.itemId, routeMarket?.marketType]);

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

  function handleOpenToken(token: TopMarketAsset, _shelfId: string) {
    handleOpenTokenByRoute(token.chain, token.contract, token);
  }

  function handleOpenTokenByRoute(chain: string, contract: string, tokenPreview?: TopMarketAsset) {
    const normalizedChain = chain.trim();
    const normalizedContract = contract.trim();
    if (tokenPreview) {
      queryClient.setQueryData(
        [TOKEN_ROUTE_PREVIEW_QUERY_KEY, normalizedChain.toLowerCase(), normalizedContract.toLowerCase()],
        tokenPreview,
      );
    }
    const routeContractParam = encodeTokenContractParam(normalizedContract);
    if (tokenExitTimerRef.current) {
      clearTimeout(tokenExitTimerRef.current);
      tokenExitTimerRef.current = null;
    }
    setIsTokenExiting(false);
    setActiveTokenRoute({ chain: normalizedChain, contract: normalizedContract });
    void navigate({
      to: '/token/$chain/$contract',
      params: { chain: normalizedChain, contract: routeContractParam },
    });
  }

  function handleOpenMarketDetail(marketType: TradeMarketDetailType, itemId: string) {
    const normalizedItemId = itemId.trim();
    if (!normalizedItemId) return;
    if (marketExitTimerRef.current) {
      clearTimeout(marketExitTimerRef.current);
      marketExitTimerRef.current = null;
    }
    setIsMarketExiting(false);
    setActiveMarketRoute({ marketType, itemId: normalizedItemId });
    void navigate({
      to: '/market/$marketType/$itemId',
      params: {
        marketType,
        itemId: normalizedItemId,
      },
    });
  }

  function handleCloseToken() {
    if (!activeTokenRoute || isTokenExiting) return;
    setIsTokenExiting(true);
    if (tokenExitTimerRef.current) {
      clearTimeout(tokenExitTimerRef.current);
    }
    tokenExitTimerRef.current = setTimeout(() => {
      if (canGoBack) {
        window.history.back();
      } else {
        void navigate({ to: '/trade' });
      }
      tokenExitTimerRef.current = null;
    }, TOKEN_EXIT_MS);
  }

  function handleCloseMarket() {
    if (!activeMarketRoute || isMarketExiting) return;
    setIsMarketExiting(true);
    if (marketExitTimerRef.current) {
      clearTimeout(marketExitTimerRef.current);
    }
    marketExitTimerRef.current = setTimeout(() => {
      if (canGoBack) {
        window.history.back();
      } else {
        void navigate({ to: '/trade' });
      }
      marketExitTimerRef.current = null;
    }, MARKET_EXIT_MS);
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
          onLogout={handleLogout}
        />
      );
    }
    if (activeTab === 'trade') {
      return (
        <TradeScreen
          onOpenToken={handleOpenToken}
          onOpenMarketDetail={handleOpenMarketDetail}
          onLogout={handleLogout}
        />
      );
    }
    return <WalletScreen auth={authenticatedState} onLogout={handleLogout} />;
  }

  return (
    <>
      <div className="min-h-screen overflow-x-hidden">
        {activeArticleId ? (
          <div className={isArticleExiting ? 'app-page-slide-out' : 'app-page-slide-in'}>
            <ArticleReaderScreen articleId={activeArticleId} onBack={handleCloseArticle} onOpenToken={handleOpenTokenByRoute} />
          </div>
        ) : isTokenRoute && activeTokenRoute ? (
          <div className={isTokenExiting ? 'app-page-slide-out' : 'app-page-slide-in'}>
            <TokenDetailScreen
              chain={activeTokenRoute.chain}
              contract={activeTokenRoute.contract}
              onBack={handleCloseToken}
            />
          </div>
        ) : isMarketRoute && activeMarketRoute ? (
          <div className={isMarketExiting ? 'app-page-slide-out' : 'app-page-slide-in'}>
            <MarketDetailScreen
              marketType={activeMarketRoute.marketType}
              itemId={activeMarketRoute.itemId}
              onBack={handleCloseMarket}
            />
          </div>
        ) : (
          renderBaseScreen()
        )}
      </div>
      {!activeArticleId && !isTokenRoute && !isMarketRoute && (
        <BottomTabBar activeTab={activeTab} onTabChange={handleTabChange} />
      )}
    </>
  );
}
