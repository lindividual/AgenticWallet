import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronDown, Send } from 'lucide-react';
import { agentChat, getCoinDetail, getMarketWatchlist, type AgentChatMessage, type TopMarketAsset } from '../api';
import type { AgentNudge, PageContext } from '../agent/types';
import { normalizeContractForChain } from '../utils/chainIdentity';

type AgentAssistantProps = {
  entryNudge?: AgentNudge | null;
  onClose?: () => void;
  pageContext: PageContext;
  openRequestKey?: number;
};

type ChatMessage = AgentChatMessage & { id: string };

const HELP_PROMPT_KEYS: Record<string, string> = {
  home: 'agent.helpPromptHome',
  trade: 'agent.helpPromptTrade',
  wallet: 'agent.helpPromptWallet',
  token: 'agent.helpPromptToken',
  article: 'agent.helpPromptArticle',
  market: 'agent.helpPromptMarket',
};

function generateSessionId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatTokenContextNumber(value: number | null | undefined, digits = 4): string | null {
  if (!Number.isFinite(Number(value))) return null;
  return Number(value).toFixed(digits);
}

function normalizeIntentText(value: string): string {
  return value.trim().toLowerCase().replace(/[.!?。！？]/g, '');
}

function isShortAffirmation(value: string): boolean {
  const normalized = normalizeIntentText(value);
  return new Set([
    'y',
    'yes',
    'yeah',
    'yep',
    'sure',
    'ok',
    'okay',
    'sure thing',
    'yes please',
    'go ahead',
    'do it',
    'please do',
    '好',
    '好的',
    '可以',
    '行',
    '嗯',
    '是的',
    '好啊',
    '没问题',
    '可以的',
    'تمام',
    'نعم',
    'أكيد',
    'حسنًا',
  ]).has(normalized);
}

function buildTokenAnalysisPrompt(locale: string | null): string {
  const normalized = (locale ?? '').trim().toLowerCase();
  if (normalized.startsWith('zh')) {
    return '请基于当前页面里的这只代币，直接给我一个简短分析，包含走势观察、主要风险，以及我下一步最值得做的动作。';
  }
  if (normalized.startsWith('ar')) {
    return 'حلل هذا الرمز مباشرةً بالاعتماد على معلومات الصفحة الحالية، مع ملاحظة الاتجاه والمخاطر الرئيسية وما هي الخطوة التالية الأنسب.';
  }
  return 'Please analyze this token directly using the current page context, including trend, main risks, and the most useful next step.';
}

export function AgentAssistant({ entryNudge = null, onClose, pageContext, openRequestKey = 0 }: AgentAssistantProps) {
  const { i18n, t } = useTranslation();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'closed' | 'panel' | 'chat'>('closed');
  const [activeNudge, setActiveNudge] = useState<AgentNudge | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId] = useState(generateSessionId);
  const handledOpenRequestKeyRef = useRef(0);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentPageKey = pageContext.page;
  const normalizedTokenChain = (pageContext.tokenChain ?? '').trim().toLowerCase();
  const normalizedTokenContract = normalizedTokenChain
    ? normalizeContractForChain(normalizedTokenChain, pageContext.tokenContract ?? '')
    : '';
  const routePreview = queryClient.getQueryData<TopMarketAsset>([
    'trade-token-route-preview',
    normalizedTokenChain,
    normalizedTokenContract,
  ]) ?? null;

  const { data: tokenDetail } = useQuery({
    queryKey: ['agent-token-context-detail', normalizedTokenChain, normalizedTokenContract],
    queryFn: () => getCoinDetail(normalizedTokenChain, normalizedTokenContract),
    enabled: currentPageKey === 'token' && Boolean(normalizedTokenChain && normalizedTokenContract),
    staleTime: 20_000,
  });

  const { data: watchlistData } = useQuery({
    queryKey: ['agent-token-context-watchlist'],
    queryFn: () => getMarketWatchlist({ limit: 200 }),
    enabled: currentPageKey === 'token' && Boolean(normalizedTokenChain && normalizedTokenContract),
    staleTime: 15_000,
  });

  const panelSupportText = useCallback(
    (nudge: AgentNudge): string => {
      const locale = (i18n.resolvedLanguage ?? i18n.language ?? '').trim().toLowerCase();
      const pack = locale.startsWith('zh') ? 'zh' : locale.startsWith('ar') ? 'ar' : 'en';
      const text = {
        zh: {
          comparison_intent: '我可以从波动、流动性和风险角度，快速对比你刚刚查看的几个标的。',
          article_deep_read: '我可以先把文章压缩成最值得关注的重点，再告诉你下一步看哪里。',
          trade_form_struggle: '我可以先帮你检查交易参数、滑点和潜在错误，再决定是否继续。',
        },
        en: {
          comparison_intent: 'I can compare the assets you just viewed across volatility, liquidity, and risk.',
          article_deep_read: 'I can condense the article into the most actionable takeaways before you continue.',
          trade_form_struggle: 'I can review the trade inputs, slippage, and possible mistakes before you continue.',
        },
        ar: {
          comparison_intent: 'يمكنني مقارنة الأصول التي شاهدتها للتو من ناحية التقلب والسيولة والمخاطر.',
          article_deep_read: 'يمكنني تلخيص المقال إلى أهم النقاط العملية قبل أن تواصل القراءة.',
          trade_form_struggle: 'يمكنني مراجعة مدخلات الصفقة والانزلاق السعري والأخطاء المحتملة قبل أن تتابع.',
        },
      } as const;
      return text[pack][nudge.type];
    },
    [i18n.language, i18n.resolvedLanguage],
  );

  useEffect(() => {
    setPhase('closed');
    setActiveNudge(null);
    setMessages([]);
    setInput('');
    setLoading(false);
  }, [currentPageKey]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (phase === 'chat') {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [phase]);

  const openGenericChat = useCallback(() => {
    setPhase('chat');
    setActiveNudge(null);
    const helpPrompt = t(HELP_PROMPT_KEYS[currentPageKey] ?? HELP_PROMPT_KEYS.home);
    setMessages([
      {
        id: `greeting_${Date.now()}`,
        role: 'assistant',
        content: helpPrompt,
      },
    ]);
  }, [currentPageKey, t]);

  const buildPageContextPayload = useCallback((): Record<string, string> => {
    const pageCtx: Record<string, string> = {};
    const tokenSymbol = pageContext.tokenSymbol ?? tokenDetail?.symbol ?? routePreview?.symbol ?? '';
    const tokenName = tokenDetail?.name ?? routePreview?.name ?? '';
    const tokenPriceUsd = tokenDetail?.currentPriceUsd ?? routePreview?.current_price ?? null;
    const tokenPriceChange24h = tokenDetail?.priceChange24h ?? routePreview?.price_change_percentage_24h ?? null;
    const isInWatchlist =
      currentPageKey === 'token'
      && Boolean(
        normalizedTokenChain
        && normalizedTokenContract
        && (watchlistData?.assets ?? []).some((asset) => (
          asset.watch_type === 'crypto'
          && asset.chain.trim().toLowerCase() === normalizedTokenChain
          && normalizeContractForChain(asset.chain, asset.contract) === normalizedTokenContract
        )),
      );

    if (tokenSymbol) pageCtx.symbol = tokenSymbol;
    if (pageContext.tokenChain) pageCtx.chain = pageContext.tokenChain;
    if (pageContext.tokenContract) pageCtx.contract = pageContext.tokenContract;
    if (tokenName) pageCtx.tokenName = tokenName;
    if (tokenPriceUsd != null) pageCtx.currentPriceUsd = formatTokenContextNumber(tokenPriceUsd, 6) ?? '';
    if (tokenPriceChange24h != null) pageCtx.priceChange24h = formatTokenContextNumber(tokenPriceChange24h, 2) ?? '';
    if (isInWatchlist) pageCtx.inWatchlist = 'true';
    if (pageContext.articleId) pageCtx.articleId = pageContext.articleId;
    if (pageContext.marketType) pageCtx.marketType = pageContext.marketType;
    if (pageContext.marketItemId) pageCtx.marketItemId = pageContext.marketItemId;
    return pageCtx;
  }, [
    currentPageKey,
    normalizedTokenChain,
    normalizedTokenContract,
    pageContext,
    routePreview?.current_price,
    routePreview?.name,
    routePreview?.price_change_percentage_24h,
    routePreview?.symbol,
    tokenDetail?.currentPriceUsd,
    tokenDetail?.name,
    tokenDetail?.priceChange24h,
    tokenDetail?.symbol,
    watchlistData?.assets,
  ]);

  const requestReply = useCallback(
    async (apiMessages: AgentChatMessage[]) => {
      const result = await agentChat({
        sessionId,
        page: currentPageKey,
        pageContext: buildPageContextPayload(),
        messages: apiMessages,
      });
      return result.reply;
    },
    [buildPageContextPayload, currentPageKey, sessionId],
  );

  const openTaskChat = useCallback(
    async (prompt: string, intro: string) => {
      if (loading) return;

      setPhase('chat');
      const seededMessages: ChatMessage[] = [
        {
          id: `intro_${Date.now()}`,
          role: 'assistant',
          content: intro,
        },
        {
          id: `user_${Date.now() + 1}`,
          role: 'user',
          content: prompt,
        },
      ];
      setMessages(seededMessages);
      setInput('');
      setLoading(true);

      try {
        const reply = await requestReply(
          seededMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        );
        setMessages((prev) => [
          ...prev,
          {
            id: `assistant_${Date.now()}`,
            role: 'assistant',
            content: reply,
          },
        ]);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: `error_${Date.now()}`,
            role: 'assistant',
            content: t('agent.chatError'),
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [loading, requestReply, t],
  );

  useEffect(() => {
    if (openRequestKey <= handledOpenRequestKeyRef.current) return;
    handledOpenRequestKeyRef.current = openRequestKey;
    setMessages([]);
    setInput('');
    setLoading(false);
    if (entryNudge) {
      setActiveNudge(entryNudge);
      setPhase('panel');
      return;
    }
    openGenericChat();
  }, [entryNudge, openGenericChat, openRequestKey]);

  const handleCloseChat = useCallback(() => {
    setPhase('closed');
    setActiveNudge(null);
    setInput('');
    onClose?.();
  }, [onClose]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: text,
    };
    const shouldExpandTokenAnalysis =
      currentPageKey === 'token'
      && messages.length === 1
      && messages[0]?.role === 'assistant'
      && isShortAffirmation(text);
    const normalizedUserMsg = shouldExpandTokenAnalysis
      ? {
          ...userMsg,
          content: buildTokenAnalysisPrompt(i18n.resolvedLanguage ?? i18n.language ?? null),
        }
      : userMsg;
    const updatedMessages = [...messages, normalizedUserMsg];
    setMessages(updatedMessages);
    setInput('');
    setLoading(true);

    try {
      const apiMessages = updatedMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const reply = await requestReply(apiMessages);

      setMessages((prev) => [
        ...prev,
        {
          id: `assistant_${Date.now()}`,
          role: 'assistant',
          content: reply,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `error_${Date.now()}`,
          role: 'assistant',
          content: t('agent.chatError'),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, requestReply, t]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  if (phase === 'closed') return null;

  if (phase === 'panel' && activeNudge) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col agent-chat-enter">
        <div className="flex-1 bg-black/20" onClick={handleCloseChat} />
        <div className="mx-auto flex w-full max-w-105 flex-col bg-base-100 shadow-2xl" style={{ maxHeight: '70vh' }}>
          <div className="flex items-center justify-between border-b border-base-300 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary">
                <Bot size={14} className="text-primary-content" />
              </div>
              <span className="text-sm font-semibold">{t('agent.chatTitle')}</span>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-circle h-8 w-8 min-h-0 rounded-full"
              onClick={handleCloseChat}
              aria-label={t('agent.chatClose')}
            >
              <ChevronDown size={18} />
            </button>
          </div>

          <div className="flex flex-col gap-4 px-4 py-4">
            <div className="rounded-3xl border border-base-300 bg-base-200/70 p-4">
              <p className="m-0 text-lg font-semibold">{activeNudge.title}</p>
              <p className="m-0 mt-2 text-sm leading-relaxed text-base-content/75">{activeNudge.message}</p>
            </div>
            <div className="rounded-2xl border border-base-300 bg-base-100 p-4">
              <p className="m-0 text-sm font-medium text-base-content/70">{t('agent.chatTitle')}</p>
              <p className="m-0 mt-2 text-sm leading-relaxed text-base-content/80">{panelSupportText(activeNudge)}</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-primary flex-1"
                onClick={() => void openTaskChat(activeNudge.presetPrompt, activeNudge.message)}
              >
                {activeNudge.actionLabel}
              </button>
              <button
                type="button"
                className="btn btn-outline flex-1"
                onClick={openGenericChat}
              >
                {t('agent.chatAction')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col agent-chat-enter">
      <div className="flex-1 bg-black/20" onClick={handleCloseChat} />
      <div className="mx-auto flex w-full max-w-105 flex-col bg-base-100 shadow-2xl"
           style={{ maxHeight: '70vh' }}>
        <div className="flex items-center justify-between border-b border-base-300 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary">
              <Bot size={14} className="text-primary-content" />
            </div>
            <span className="text-sm font-semibold">{t('agent.chatTitle')}</span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-circle h-8 w-8 min-h-0 rounded-full"
            onClick={handleCloseChat}
            aria-label={t('agent.chatClose')}
          >
            <ChevronDown size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3" style={{ minHeight: '200px' }}>
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`mb-3 flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'assistant' && (
                <div className="mr-2 mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary">
                  <Bot size={12} className="text-primary-content" />
                </div>
              )}
              <div
                className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-content'
                    : 'bg-base-200 text-base-content'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="mb-3 flex justify-start">
              <div className="mr-2 mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary">
                <Bot size={12} className="text-primary-content" />
              </div>
              <div className="rounded-2xl bg-base-200 px-3 py-2 text-sm text-base-content/60">
                <span className="agent-thinking-dots">{t('agent.chatThinking')}</span>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="border-t border-base-300 px-4 py-3">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('agent.chatPlaceholder')}
              className="input input-bordered h-10 min-h-0 flex-1 rounded-full text-sm"
              disabled={loading}
            />
            <button
              type="button"
              className="btn btn-primary btn-circle h-10 w-10 min-h-0 rounded-full"
              onClick={() => void handleSend()}
              disabled={!input.trim() || loading}
              aria-label={t('agent.chatSend')}
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
