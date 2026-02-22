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
    <>
      {!auth ? (
        <section
          className="mx-auto flex min-h-screen max-h-screen w-full max-w-[400px] flex-col overflow-y-auto p-6 sm:p-8 sm:pb-10 max-[375px]:px-4 max-[375px]:pb-5 lg:px-14 lg:py-12"
          aria-busy={loading}
        >
          <header className="flex items-center gap-3" aria-label="umi wallet brand">
            <img
              src={BRAND_SYMBOL_ICON}
              alt="umi wallet"
              className="h-[25px] w-9 object-contain"
            />
            <span className="text-xl font-medium tracking-tight max-[375px]:text-lg">
              umi wallet
            </span>
          </header>

          <h1
            id="auth-title"
            className="my-12 w-[233px] text-3xl font-bold leading-tight tracking-tight max-[375px]:my-10 max-[375px]:w-[200px] max-[375px]:text-[29px] sm:my-10 sm:w-full sm:max-w-[360px] sm:text-4xl lg:max-w-[420px] lg:text-[44px] lg:leading-[1.08]"
          >
            Smart enough
            <br />
            to feel simple
          </h1>

          <div
            className="-mx-6 h-[280px] overflow-hidden rounded-2xl relative max-[375px]:-mx-4 max-[375px]:h-[min(99vw,240px)] sm:mx-0 sm:h-80 lg:h-[360px]"
            aria-hidden="true"
          >
            <div
              className="absolute left-1/5 top-1/2 h-[220px] w-[220px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,_#e0e0e0_0%,_transparent_70%)] opacity-50 blur-[70px] lg:h-[260px] lg:w-[260px]"
              aria-hidden
            />
            <div
              className="absolute right-[15%] top-[60%] h-[180px] w-[180px] translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,_#d8d8d8_0%,_transparent_70%)] opacity-50 blur-[70px] lg:h-[200px] lg:w-[200px]"
              aria-hidden
            />
          </div>

          <div className="mt-9 grid gap-3 pb-[76px] max-[375px]:mt-6 max-[375px]:pb-[22px]">
            <AuthButton
              variant="primary"
              className="min-h-14 rounded-none text-xl"
              onClick={authMode === 'register' ? handleRegister : handleLogin}
              disabled={loading}
            >
              {authMode === 'register' ? 'Get started' : 'Login with Passkey'}
            </AuthButton>
            {authMode === 'register' ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm font-medium underline disabled:opacity-50"
                onClick={() => setAuthMode('login')}
                disabled={loading}
              >
                I already have an account
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-sm font-medium underline disabled:opacity-50"
                onClick={() => setAuthMode('register')}
                disabled={loading}
              >
                Create a new account
              </button>
            )}
          </div>

          {(error || info) && (
            <section className="flex flex-col gap-3" aria-live="polite">
              {error && (
                <div role="alert" className="alert alert-error text-sm">
                  Error: {error}
                </div>
              )}
              {info && (
                <div role="alert" className="alert alert-info text-sm">
                  {info}
                </div>
              )}
            </section>
          )}
        </section>
      ) : (
        <section className="mx-auto flex min-h-screen max-h-screen w-full max-w-[400px] flex-col gap-4 overflow-y-auto p-6 sm:p-6">
          <header className="flex items-center justify-between gap-3">
            <h2 className="m-0 text-2xl font-semibold tracking-tight">Wallet overview</h2>
            <AuthButton variant="secondary" onClick={handleLogout} disabled={loading}>
              退出登录
            </AuthButton>
          </header>

          <section className="flex flex-col gap-2 rounded-2xl border border-base-300 bg-base-200 p-4">
            <p className="m-0">
              <strong>User:</strong> {auth.user.displayName} ({auth.user.handle})
            </p>
            <p className="m-0">
              <strong>Wallet:</strong> {auth.wallet?.address ?? '未创建'}
            </p>
            <p className="m-0">
              <strong>Provider:</strong> {auth.wallet?.provider ?? 'N/A'}
            </p>
            {auth.wallet?.chainAccounts && auth.wallet.chainAccounts.length > 0 && (
              <ul className="list-inside list-disc pl-6">
                {auth.wallet.chainAccounts.map((row) => (
                  <li key={row.chainId}>
                    {row.chainId}: {row.address}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="flex flex-col gap-3">
            <AuthButton
              variant="primary"
              onClick={verifyPaymentPasskey}
              disabled={loading}
            >
              支付密码验证（Passkey）
            </AuthButton>
            <AuthButton variant="secondary" onClick={mockRecommendation} disabled={loading}>
              生成 Agent 推荐（Mock）
            </AuthButton>
          </div>

          {chains.length > 0 && (
            <section className="flex flex-col gap-2 rounded-2xl border border-base-300 bg-base-200 p-4">
              <h3 className="m-0">Supported chains</h3>
              <ul className="list-inside list-disc pl-6">
                {chains.map((chain) => (
                  <li key={chain.chainId}>
                    {chain.name} ({chain.chainId}) - {chain.symbol}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(error || info) && (
            <section className="flex flex-col gap-3" aria-live="polite">
              {error && (
                <div role="alert" className="alert alert-error text-sm">
                  Error: {error}
                </div>
              )}
              {info && (
                <div role="alert" className="alert alert-info text-sm">
                  {info}
                </div>
              )}
            </section>
          )}
        </section>
      )}
    </>
  );
}
