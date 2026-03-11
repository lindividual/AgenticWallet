import { useTranslation } from 'react-i18next';
import { ChartCandlestick, House, Wallet, type LucideIcon } from 'lucide-react';
import type { AgentEntryState, AgentMood } from '../agent/types';
import { AgentEntryButton } from './AgentEntryButton';

export type AppTab = 'home' | 'trade' | 'wallet';

type BottomTabBarProps = {
  activeTab: AppTab;
  agentBubbleMessage?: string | null;
  agentEntryState: AgentEntryState;
  agentMood: AgentMood;
  onAgentBubbleDismiss?: () => void;
  onTabChange: (tab: AppTab) => void;
  onAgentOpen: () => void;
  showTabs?: boolean;
};

const TABS: AppTab[] = ['home', 'trade', 'wallet'];
const TAB_ICON: Record<AppTab, LucideIcon> = {
  home: House,
  trade: ChartCandlestick,
  wallet: Wallet,
};

export function BottomTabBar({
  activeTab,
  agentBubbleMessage,
  agentEntryState,
  agentMood,
  onAgentBubbleDismiss,
  onTabChange,
  onAgentOpen,
  showTabs = true,
}: BottomTabBarProps) {
  const { t } = useTranslation();

  return (
    <nav className="pointer-events-none fixed inset-x-0 bottom-0 z-30" aria-label={t('tabs.navigation')}>
      <div
        className="pointer-events-auto mx-auto w-full max-w-105 px-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.8rem)' }}
      >
        <div className={`liquid-tab-bar ${showTabs ? '' : 'liquid-tab-bar--solo'}`}>
          {showTabs ? (
            <div
              className="liquid-tab-shell"
              style={{
                backdropFilter: 'blur(8px) saturate(195%)',
                WebkitBackdropFilter: 'blur(8px) saturate(195%)',
              }}
            >
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
                      aria-label={t(`tabs.${tab}`)}
                      aria-current={isActive ? 'page' : undefined}
                    >
                      <span className="liquid-tab-button__inner">
                        <Icon className="liquid-tab-button__icon" size={22} strokeWidth={2.05} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          <AgentEntryButton
            bubbleMessage={agentBubbleMessage}
            dockOnly={!showTabs}
            mood={agentMood}
            onDismissBubble={onAgentBubbleDismiss}
            onOpen={onAgentOpen}
            state={agentEntryState}
            title={t('agent.chatTitle')}
          />
        </div>
      </div>
    </nav>
  );
}
