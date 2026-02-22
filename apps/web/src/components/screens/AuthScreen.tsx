import { useTranslation } from 'react-i18next';
import { AuthButton } from '../AuthButton';
import { Logo } from '../Logo';
import { SettingsDropdown } from '../SettingsDropdown';
import type { AuthMode } from '../../hooks/useWalletApp';

type AuthScreenProps = {
  authMode: AuthMode;
  loading: boolean;
  onLogin: () => void;
  onRegister: () => void;
  onAuthModeChange: (mode: AuthMode) => void;
};

export function AuthScreen({
  authMode,
  loading,
  onLogin,
  onRegister,
  onAuthModeChange,
}: AuthScreenProps) {
  const { t } = useTranslation();

  return (
    <section
      className="mx-auto flex min-h-screen max-h-screen w-full max-w-[400px] flex-col overflow-y-auto p-6 sm:p-8 sm:pb-10 max-[375px]:px-4 max-[375px]:pb-5 lg:px-14 lg:py-12"
      aria-busy={loading}
    >
      <header className="flex items-center justify-between gap-3" aria-label={t('common.brand')}>
        <div className="flex items-center gap-5 text-base-content">
          <Logo className="h-[25px] w-9 shrink-0" ariaLabel={t('common.brand')} />
          <span className="text-xl font-medium tracking-tight max-[375px]:text-lg">{t('common.brand')}</span>
        </div>
        <SettingsDropdown />
      </header>

      <h1
        id="auth-title"
        className="my-12 w-[233px] text-3xl font-bold leading-tight tracking-tight max-[375px]:my-10 max-[375px]:w-[200px] max-[375px]:text-[29px] sm:my-10 sm:w-full sm:max-w-[360px] sm:text-4xl lg:max-w-[420px] lg:text-[44px] lg:leading-[1.08] whitespace-pre-line"
      >
        {t('auth.title')}
      </h1>

      <div className="mt-auto grid gap-3 pb-8 max-[375px]:pb-6">
        <AuthButton
          variant="primary"
          onClick={authMode === 'register' ? onRegister : onLogin}
          disabled={loading}
        >
          {authMode === 'register' ? t('auth.getStarted') : t('auth.loginWithPasskey')}
        </AuthButton>

        {authMode === 'register' ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onAuthModeChange('login')}
            disabled={loading}
          >
            {t('auth.alreadyHaveAccount')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onAuthModeChange('register')}
            disabled={loading}
          >
            {t('auth.createNewAccount')}
          </button>
        )}
      </div>
    </section>
  );
}
