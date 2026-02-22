import { useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import {
  clearToken,
  getJson,
  getToken,
  postJson,
  setToken,
  type AuthVerifyResponse,
  type ChainsResponse,
  type LoginOptionsResponse,
  type MeResponse,
  type PayVerifyConfirmResponse,
  type PayVerifyOptionsResponse,
  type RegisterOptionsResponse,
} from './api';
import { AuthButton } from './components/AuthButton';

const BRAND_SYMBOL_ICON = 'https://www.figma.com/api/mcp/asset/e60f3d2d-348f-4198-8cec-7a60006f7440';

type AuthState = {
  user: MeResponse['user'];
  wallet: MeResponse['wallet'];
};

type AuthMode = 'register' | 'login';

export function App() {
  const [displayName, setDisplayName] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('register');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [chains, setChains] = useState<ChainsResponse['chains']>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    void loadChains();
    if (getToken()) {
      void refreshMe();
    }
  }, []);

  async function loadChains() {
    try {
      const data = await getJson<ChainsResponse>('/v1/chains');
      setChains(data.chains);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function refreshMe() {
    try {
      const me = await getJson<MeResponse>('/v1/me', true);
      setAuth({ user: me.user, wallet: me.wallet });
    } catch {
      clearToken();
      setAuth(null);
    }
  }

  async function handleRegister() {
    setLoading(true);
    setError(null);
    setInfo(null);

    try {
      const optionsData = await postJson<RegisterOptionsResponse>('/v1/auth/register/options', {
        displayName,
      });

      const registration = await startRegistration({
        optionsJSON: optionsData.options as any,
      });

      const verify = await postJson<AuthVerifyResponse>('/v1/auth/register/verify', {
        userId: optionsData.userId,
        challengeId: optionsData.challengeId,
        response: registration,
      });

      setToken(verify.accessToken);
      setAuth({ user: verify.user, wallet: verify.wallet });
      setInfo('注册成功，钱包已初始化。');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin() {
    setLoading(true);
    setError(null);
    setInfo(null);

    try {
      const optionsData = await postJson<LoginOptionsResponse>('/v1/auth/login/options', {});
      const authentication = await startAuthentication({
        optionsJSON: optionsData.options as any,
      });

      const verify = await postJson<AuthVerifyResponse>('/v1/auth/login/verify', {
        challengeId: optionsData.challengeId,
        response: authentication,
      });

      setToken(verify.accessToken);
      setAuth({ user: verify.user, wallet: verify.wallet });
      setInfo('登录成功。');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    clearToken();
    setAuth(null);
    setInfo('已退出登录。');
  }

  async function mockRecommendation() {
    setLoading(true);
    setError(null);
    setInfo(null);

    try {
      await postJson('/v1/agent/recommendations/mock', {}, true);
      setInfo('已生成一条推荐（mock）。');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function verifyPaymentPasskey() {
    setLoading(true);
    setError(null);
    setInfo(null);

    try {
      const optionsData = await postJson<PayVerifyOptionsResponse>('/v1/pay/verify/options', {}, true);
      const authentication = await startAuthentication({
        optionsJSON: optionsData.options as any,
      });

      const verify = await postJson<PayVerifyConfirmResponse>(
        '/v1/pay/verify/confirm',
        {
          challengeId: optionsData.challengeId,
          response: authentication,
        },
        true,
      );

      if (verify.verified) {
        setInfo('支付密码验证通过（UV required）。');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app-shell">
      {!auth ? (
        <section className="auth-screen" aria-busy={loading}>
          <header className="brand-row" aria-label="umi wallet brand">
            <img src={BRAND_SYMBOL_ICON} alt="umi wallet" className="brand-logo" />
            <span className="brand-text">umi wallet</span>
          </header>

          <h1 className="auth-title" id="auth-title">
            Smart enough
            <br />
            to feel simple
          </h1>

          <div className="hero-visual" aria-hidden="true">
            <div className="hero-glow hero-glow--1" />
            <div className="hero-glow hero-glow--2" />
          </div>

          <div className="auth-actions">
            <AuthButton
              variant="primary"
              className="auth-cta"
              onClick={authMode === 'register' ? handleRegister : handleLogin}
              disabled={loading}
            >
              {authMode === 'register' ? 'Get started' : 'Login with Passkey'}
            </AuthButton>
            {authMode === 'register' ? (
              <button
                type="button"
                className="auth-mode-link"
                onClick={() => setAuthMode('login')}
                disabled={loading}
              >
                I already have an account
              </button>
            ) : (
              <button
                type="button"
                className="auth-mode-link"
                onClick={() => setAuthMode('register')}
                disabled={loading}
              >
                Create a new account
              </button>
            )}
          </div>

          {(error || info) && (
            <section className="feedback" aria-live="polite">
              {error && <p className="error">Error: {error}</p>}
              {info && <p className="info">{info}</p>}
            </section>
          )}
        </section>
      ) : (
        <section className="wallet-screen">
          <header className="wallet-head">
            <h2>Wallet overview</h2>
            <AuthButton variant="secondary" onClick={handleLogout} disabled={loading}>
              退出登录
            </AuthButton>
          </header>

          <section className="wallet-panel">
            <p>
              <strong>User:</strong> {auth.user.displayName} ({auth.user.handle})
            </p>
            <p>
              <strong>Wallet:</strong> {auth.wallet?.address ?? '未创建'}
            </p>
            <p>
              <strong>Provider:</strong> {auth.wallet?.provider ?? 'N/A'}
            </p>
            {auth.wallet?.chainAccounts && auth.wallet.chainAccounts.length > 0 && (
              <ul className="chain-list">
                {auth.wallet.chainAccounts.map((row) => (
                  <li key={row.chainId}>
                    {row.chainId}: {row.address}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="wallet-actions">
            <AuthButton variant="primary" onClick={verifyPaymentPasskey} disabled={loading}>
              支付密码验证（Passkey）
            </AuthButton>
            <AuthButton variant="secondary" onClick={mockRecommendation} disabled={loading}>
              生成 Agent 推荐（Mock）
            </AuthButton>
          </div>

          {chains.length > 0 && (
            <section className="wallet-panel">
              <h3>Supported chains</h3>
              <ul className="chain-list">
                {chains.map((chain) => (
                  <li key={chain.chainId}>
                    {chain.name} ({chain.chainId}) - {chain.symbol}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(error || info) && (
            <section className="feedback" aria-live="polite">
              {error && <p className="error">Error: {error}</p>}
              {info && <p className="info">{info}</p>}
            </section>
          )}
        </section>
      )}
    </main>
  );
}
