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
      <div className="pointer-events-auto mx-auto w-full max-w-105 border-t border-base-300 bg-base-100 px-4 py-3">
        <div className="grid grid-cols-3 gap-2">
          {TABS.map((tab) => {
            const Icon = TAB_ICON[tab];
            const isActive = activeTab === tab;

            return (
              <button
                key={tab}
                type="button"
                onClick={() => onTabChange(tab)}
                className={`btn btn-ghost h-12 min-h-0 border border-transparent bg-transparent px-1 hover:bg-transparent active:bg-transparent ${
                  isActive ? 'text-black' : 'text-gray-400'
                }`}
                aria-current={isActive ? 'page' : undefined}
              >
                <span className="flex flex-col items-center gap-0.5 leading-none">
                  <Icon size={22} strokeWidth={2.1} />
                  <span className="text-[11px] font-medium">{t(`tabs.${tab}`)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
