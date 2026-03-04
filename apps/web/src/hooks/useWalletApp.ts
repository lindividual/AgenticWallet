import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import {
  clearToken,
  getJson,
  getToken,
  logout,
  postJson,
  setToken,
  type AuthVerifyResponse,
  type ChainsResponse,
  type LoginOptionsResponse,
  type MeResponse,
  type PayVerifyConfirmResponse,
  type PayVerifyOptionsResponse,
  type RegisterOptionsResponse,
} from '../api';
import { useToast } from '../contexts/ToastContext';

export type AuthState = {
  user: MeResponse['user'];
  wallet: MeResponse['wallet'];
};

export type AuthMode = 'register' | 'login';

export function useWalletApp() {
  const { t } = useTranslation();
  const [authMode, setAuthMode] = useState<AuthMode>('register');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [chains, setChains] = useState<ChainsResponse['chains']>([]);
  const [loading, setLoading] = useState(false);
  const { showError, showSuccess } = useToast();

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
      showError(`${t('common.error')}: ${(err as Error).message}`);
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

    try {
      const optionsData = await postJson<RegisterOptionsResponse>('/v1/auth/register/options', {});

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
      showSuccess(t('auth.registerSuccess'));
    } catch (err) {
      showError(`${t('common.error')}: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin() {
    setLoading(true);

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
      showSuccess(t('auth.loginSuccess'));
    } catch (err) {
      showError(`${t('common.error')}: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    setLoading(true);
    try {
      await logout();
      clearToken();
      setAuth(null);
      showSuccess(t('auth.logoutSuccess'));
    } catch (err) {
      showError(`${t('common.error')}: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  async function verifyPaymentPasskey() {
    setLoading(true);

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
        showSuccess(t('wallet.verifyPaymentSuccess'));
      }
    } catch (err) {
      showError(`${t('common.error')}: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  return {
    auth,
    authMode,
    chains,
    loading,
    setAuthMode,
    handleLogin,
    handleLogout,
    handleRegister,
    verifyPaymentPasskey,
  };
}
