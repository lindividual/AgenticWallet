import { useTranslation } from 'react-i18next';
import { ChartCandlestick, House, Wallet, type LucideIcon } from 'lucide-react';

export type AppTab = 'home' | 'trade' | 'wallet';

type BottomTabBarProps = {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
};

const TABS: AppTab[] = ['home', 'trade', 'wallet'];
const TAB_ICON: Record<AppTab, LucideIcon> = {
  home: House,
  trade: ChartCandlestick,
  wallet: Wallet,
};

export function BottomTabBar({ activeTab, onTabChange }: BottomTabBarProps) {
  const { t } = useTranslation();

  return (
    <nav className="pointer-events-none fixed inset-x-0 bottom-0 z-30" aria-label={t('tabs.navigation')}>
      <div
        className="pointer-events-auto mx-auto w-full max-w-105 px-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.8rem)' }}
      >
        <div className="liquid-tab-shell">
          <div className="liquid-tab-grid">
            {TABS.map((tab) => {
              const Icon = TAB_ICON[tab];
              const isActive = activeTab === tab;

              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => onTabChange(tab)}
                  className={`liquid-tab-button ${isActive ? 'liquid-tab-button--active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className="liquid-tab-button__inner">
                    <Icon className="liquid-tab-button__icon" size={22} strokeWidth={2.05} />
                    <span className="liquid-tab-button__label">{t(`tabs.${tab}`)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}
