export type PageContext = {
  page: 'home' | 'trade' | 'wallet' | 'article' | 'token' | 'market';
  articleId?: string;
  tokenChain?: string;
  tokenContract?: string;
  tokenSymbol?: string;
  marketType?: string;
  marketItemId?: string;
};

export type AgentMood = 'neutral' | 'watching' | 'thinking' | 'ready' | 'warning';

export type AgentEntryState = 'idle' | 'observing' | 'thinking' | 'nudging' | 'engaged' | 'cooldown';

export type AgentNudgeType = 'comparison_intent' | 'article_deep_read' | 'trade_form_struggle';

export type AgentNudge = {
  id: string;
  type: AgentNudgeType;
  page: PageContext['page'];
  entityKey: string;
  title: string;
  message: string;
  actionLabel: string;
  presetPrompt: string;
  priority: 'medium' | 'high';
  createdAt: number;
};
