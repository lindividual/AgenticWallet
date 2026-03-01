import { useTranslation } from 'react-i18next';
import { useTheme, type ThemeMode } from '../contexts/ThemeContext';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '中文' },
  { code: 'ar', label: 'العربية' },
] as const;

type SettingsDropdownProps = {
  onLogout?: () => void | Promise<void>;
};

export function SettingsDropdown({ onLogout }: SettingsDropdownProps) {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();

  return (
    <div className="dropdown dropdown-end">
      <label tabIndex={0} className="btn btn-ghost btn-sm btn-circle" aria-label={t('settings.theme')}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="size-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      </label>
      <ul
        tabIndex={0}
        className="dropdown-content menu z-50 mt-2 w-56 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
      >
        <li className="menu-title px-3 py-2 text-xs font-semibold uppercase opacity-70">
          {t('settings.language')}
        </li>
        {LANGUAGES.map(({ code, label }) => (
          <li key={code}>
            <button
              type="button"
              className={i18n.language.startsWith(code) ? 'active' : ''}
              onClick={() => i18n.changeLanguage(code)}
            >
              {label}
              {i18n.language.startsWith(code) && (
                <span className="badge badge-sm badge-primary ms-auto">✓</span>
              )}
            </button>
          </li>
        ))}
        <li className="divider my-1" />
        <li className="menu-title px-3 py-2 text-xs font-semibold uppercase opacity-70">
          {t('settings.theme')}
        </li>
        {(['light', 'dark', 'system'] as const).map((mode) => (
          <li key={mode}>
            <button
              type="button"
              className={theme === mode ? 'active' : ''}
              onClick={() => setTheme(mode as ThemeMode)}
            >
              {t(`settings.theme${mode.charAt(0).toUpperCase() + mode.slice(1)}`)}
              {theme === mode && (
                <span className="badge badge-sm badge-primary ms-auto">✓</span>
              )}
            </button>
          </li>
        ))}
        {onLogout ? (
          <>
            <li className="divider my-1" />
            <li>
              <button type="button" className="text-error" onClick={onLogout}>
                {t('common.logout')}
              </button>
            </li>
          </>
        ) : null}
      </ul>
    </div>
  );
}
