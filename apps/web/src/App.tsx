import { AuthScreen } from './components/screens/AuthScreen';
import { WalletScreen } from './components/screens/WalletScreen';
import { useWalletApp } from './hooks/useWalletApp';

export function App() {
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

  return (
    <WalletScreen
      auth={auth}
    />
  );
}
