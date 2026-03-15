import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCanGoBack, useLocation, useMatch, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { AgentAssistant } from './components/AgentAssistant';
import type { PageContext } from './agent/types';
import { BottomTabBar, type AppTab } from './components/BottomTabBar';
import { AuthScreen } from './components/screens/AuthScreen';
import { AgentOpsScreen } from './components/screens/AgentOpsScreen';
import { ArticleReaderScreen } from './components/screens/ArticleReaderScreen';
import { HomeScreen } from './components/screens/HomeScreen';
import { MarketDetailScreen } from './components/screens/MarketDetailScreen';
import { TokenDetailScreen } from './components/screens/TokenDetailScreen';
import { TradeScreen } from './components/screens/TradeScreen';
import { WalletAssetDetailScreen } from './components/screens/WalletAssetDetailScreen';
import { WalletScreen } from './components/screens/WalletScreen';
import { setAgentPreferredLocale, type TopMarketAsset } from './api';
import { useAgentIntervention } from './hooks/useAgentIntervention';
import { useWalletApp } from './hooks/useWalletApp';
import { decodeTokenContractParam, encodeTokenContractParam } from './utils/tokenRoute';
import {
  normalizeTradeMarketDetailType,
  type TradeMarketDetailType,
} from './utils/tradeMarketDetail';

const ARTICLE_EXIT_MS = 220;
const TOKEN_EXIT_MS = 220;
const MARKET_EXIT_MS = 220;
const WALLET_ASSET_EXIT_MS = 220;
const TOKEN_ROUTE_PREVIEW_QUERY_KEY = 'trade-token-route-preview';

export function App() {
  const { i18n } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const location = useLocation();
  const articleMatch = useMatch({ from: '/article/$articleId', shouldThrow: false });
  const tokenMatch = useMatch({ from: '/token/$chain/$contract', shouldThrow: false });
  const walletAssetMatch = useMatch({ from: '/wallet/asset/$chain/$contract', shouldThrow: false });
  const marketMatch = useMatch({ from: '/market/$marketType/$itemId', shouldThrow: false });
  const agentOpsMatch = useMatch({ from: '/ops/agent', shouldThrow: false });
  const routeArticleId = articleMatch?.params.articleId ?? null;
  const isArticleRoute = Boolean(routeArticleId);
  const routeToken = tokenMatch?.params
    ? {
        chain: tokenMatch.params.chain.trim(),
        contract: decodeTokenContractParam(tokenMatch.params.contract),
      }
    : null;
  const isTokenRoute = Boolean(routeToken);
  const routeWalletAsset = walletAssetMatch?.params
    ? {
        chain: walletAssetMatch.params.chain.trim(),
        contract: decodeTokenContractParam(walletAssetMatch.params.contract),
      }
    : null;
  const isWalletAssetRoute = Boolean(routeWalletAsset);
  const routeMarket = marketMatch?.params
    ? {
        marketType: normalizeTradeMarketDetailType(marketMatch.params.marketType),
        itemId: marketMatch.params.itemId.trim(),
      }
    : null;
  const isMarketRoute = Boolean(routeMarket?.marketType && routeMarket.itemId);
  const isAgentOpsRoute = Boolean(agentOpsMatch);

  const [activeArticleId, setActiveArticleId] = useState<string | null>(routeArticleId);
  const [isArticleExiting, setIsArticleExiting] = useState(false);
  const articleExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeTokenRoute, setActiveTokenRoute] = useState(routeToken);
  const [isTokenExiting, setIsTokenExiting] = useState(false);
  const tokenExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeWalletAssetRoute, setActiveWalletAssetRoute] = useState(routeWalletAsset);
  const [isWalletAssetExiting, setIsWalletAssetExiting] = useState(false);
  const walletAssetExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeMarketRoute, setActiveMarketRoute] = useState<{
    marketType: TradeMarketDetailType;
    itemId: string;
  } | null>(
    routeMarket?.marketType && routeMarket.itemId
      ? { marketType: routeMarket.marketType, itemId: routeMarket.itemId }
      : null,
  );
  const [isMarketExiting, setIsMarketExiting] = useState(false);
  const [agentOpenRequestKey, setAgentOpenRequestKey] = useState(0);
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
      if (walletAssetExitTimerRef.current) {
        clearTimeout(walletAssetExitTimerRef.current);
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
    if (routeWalletAsset) {
      setActiveWalletAssetRoute(routeWalletAsset);
      setIsWalletAssetExiting(false);
      return;
    }
    setActiveWalletAssetRoute(null);
    setIsWalletAssetExiting(false);
  }, [routeWalletAsset?.chain, routeWalletAsset?.contract]);

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

  const pathname = location.pathname;
  const activeTab: AppTab = pathname.startsWith('/trade') ? 'trade' : pathname.startsWith('/wallet') ? 'wallet' : 'home';
  const agentPageContext: PageContext = activeArticleId
    ? { page: 'article', articleId: activeArticleId }
    : isTokenRoute && activeTokenRoute
      ? { page: 'token', tokenChain: activeTokenRoute.chain, tokenContract: activeTokenRoute.contract }
      : isMarketRoute && activeMarketRoute
        ? { page: 'market', marketType: activeMarketRoute.marketType, marketItemId: activeMarketRoute.itemId }
        : isWalletAssetRoute
          ? { page: 'wallet' }
          : { page: activeTab };
  const showBottomTabs = !activeArticleId && !isTokenRoute && !isWalletAssetRoute && !isMarketRoute && !isAgentOpsRoute;
  const intervention = useAgentIntervention(agentPageContext, i18n.resolvedLanguage ?? i18n.language ?? null);

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
      if (canGoBack) {
        window.history.back();
      } else {
        void navigate({ to: '/' });
      }
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

  function handleOpenWalletAsset(chain: string, contract: string) {
    const normalizedChain = chain.trim();
    const normalizedContract = contract.trim();
    if (walletAssetExitTimerRef.current) {
      clearTimeout(walletAssetExitTimerRef.current);
      walletAssetExitTimerRef.current = null;
    }
    setIsWalletAssetExiting(false);
    setActiveWalletAssetRoute({ chain: normalizedChain, contract: normalizedContract });
    void navigate({
      to: '/wallet/asset/$chain/$contract',
      params: {
        chain: normalizedChain,
        contract: encodeTokenContractParam(normalizedContract),
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

  function handleCloseWalletAsset() {
    if (!activeWalletAssetRoute || isWalletAssetExiting) return;
    setIsWalletAssetExiting(true);
    if (walletAssetExitTimerRef.current) {
      clearTimeout(walletAssetExitTimerRef.current);
    }
    walletAssetExitTimerRef.current = setTimeout(() => {
      if (canGoBack) {
        window.history.back();
      } else {
        void navigate({ to: '/wallet' });
      }
      walletAssetExitTimerRef.current = null;
    }, WALLET_ASSET_EXIT_MS);
  }

  function handleCloseAgentOps() {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: '/' });
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
    return <WalletScreen auth={authenticatedState} onLogout={handleLogout} onOpenAssetDetail={handleOpenWalletAsset} />;
  }

  function handleAgentOpen() {
    intervention.handleEntryOpen();
    setAgentOpenRequestKey((value) => value + 1);
  }

  return (
    <>
      <div
        className="min-h-screen overflow-x-hidden"
        style={showBottomTabs ? { paddingBottom: 'env(safe-area-inset-bottom, 0px)' } : undefined}
      >
        {activeArticleId ? (
          <div className={isArticleExiting ? 'app-page-slide-out' : 'app-page-slide-in'}>
            <ArticleReaderScreen
              articleId={activeArticleId}
              onBack={handleCloseArticle}
              onOpenToken={handleOpenTokenByRoute}
              onOpenMarketDetail={handleOpenMarketDetail}
            />
          </div>
        ) : isTokenRoute && activeTokenRoute ? (
          <div className={isTokenExiting ? 'app-page-slide-out' : 'app-page-slide-in'}>
            <TokenDetailScreen
              chain={activeTokenRoute.chain}
              contract={activeTokenRoute.contract}
              onBack={handleCloseToken}
            />
          </div>
        ) : isWalletAssetRoute && activeWalletAssetRoute ? (
          <div className={isWalletAssetExiting ? 'app-page-slide-out' : 'app-page-slide-in'}>
            <WalletAssetDetailScreen
              auth={authenticatedState}
              chain={activeWalletAssetRoute.chain}
              contract={activeWalletAssetRoute.contract}
              onBack={handleCloseWalletAsset}
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
        ) : isAgentOpsRoute ? (
          <div className="app-page-slide-in">
            <AgentOpsScreen
              auth={authenticatedState}
              onBack={handleCloseAgentOps}
              onOpenArticle={handleOpenArticle}
            />
          </div>
        ) : (
          renderBaseScreen()
        )}
      </div>
      <BottomTabBar
        activeTab={activeTab}
        agentBubbleMessage={intervention.bubbleMessage}
        agentEntryState={intervention.entryState}
        agentMood={intervention.mood}
        onAgentBubbleDismiss={intervention.dismissActiveNudge}
        onTabChange={handleTabChange}
        onAgentOpen={handleAgentOpen}
        showTabs={showBottomTabs}
      />
      <AgentAssistant
        entryNudge={intervention.activeNudge}
        onClose={intervention.handleAssistantClosed}
        pageContext={agentPageContext}
        openRequestKey={agentOpenRequestKey}
      />
    </>
  );
}
