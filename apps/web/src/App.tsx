import { useState } from 'react';
import { BottomTabBar, type AppTab } from './components/BottomTabBar';
import { AuthScreen } from './components/screens/AuthScreen';
import { HomeScreen } from './components/screens/HomeScreen';
import { TradeScreen } from './components/screens/TradeScreen';
import { WalletScreen } from './components/screens/WalletScreen';
import { useWalletApp } from './hooks/useWalletApp';

export function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('home');
  const {
    auth,
    authMode,
    loading,
    setAuthMode,
    handleLogin,
    handleRegister,
  } = useWalletApp();

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

  function renderAuthenticatedScreen() {
    if (activeTab === 'home') return <HomeScreen />;
    if (activeTab === 'trade') return <TradeScreen />;
    return <WalletScreen auth={authenticatedState} />;
  }

  return (
    <>
      {renderAuthenticatedScreen()}
      <BottomTabBar activeTab={activeTab} onTabChange={setActiveTab} />
    </>
  );
}
