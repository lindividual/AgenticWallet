import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronDown, Send, X } from 'lucide-react';
import { agentChat, ingestAgentEvent, type AgentChatMessage } from '../api';
import { useIdleDetector } from '../hooks/useIdleDetector';

export type PageContext = {
  page: 'home' | 'trade' | 'wallet' | 'article' | 'token' | 'market';
  articleId?: string;
  tokenChain?: string;
  tokenContract?: string;
  tokenSymbol?: string;
  marketType?: string;
  marketItemId?: string;
};

type AgentAssistantProps = {
  pageContext: PageContext;
};

type ChatMessage = AgentChatMessage & { id: string };

const IDLE_TIMEOUT_MS = 3000;
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

export function AgentAssistant({ pageContext }: AgentAssistantProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'hidden' | 'bubble' | 'chat'>('hidden');
  const [dismissedPages, setDismissedPages] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId] = useState(generateSessionId);
  const [bubbleExiting, setBubbleExiting] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dwellReportedRef = useRef<string | null>(null);

  const currentPageKey = pageContext.page;
  const isDismissed = dismissedPages.has(currentPageKey);
  const shouldDetect = phase === 'hidden' && !isDismissed;
  const isIdle = useIdleDetector(IDLE_TIMEOUT_MS, shouldDetect);

  useEffect(() => {
    if (isIdle && phase === 'hidden' && !isDismissed) {
      setPhase('bubble');

      if (dwellReportedRef.current !== currentPageKey) {
        dwellReportedRef.current = currentPageKey;
        const payload: Record<string, unknown> = { page: currentPageKey };
        if (pageContext.tokenSymbol) payload.symbol = pageContext.tokenSymbol;
        if (pageContext.tokenChain) payload.chain = pageContext.tokenChain;
        if (pageContext.tokenContract) payload.contract = pageContext.tokenContract;
        if (pageContext.articleId) payload.articleId = pageContext.articleId;
        if (pageContext.marketType) payload.marketType = pageContext.marketType;
        if (pageContext.marketItemId) payload.marketItemId = pageContext.marketItemId;
        ingestAgentEvent('page_dwell', payload).catch(() => undefined);
      }
    }
  }, [isIdle, phase, isDismissed, currentPageKey, pageContext]);

  useEffect(() => {
    if (phase === 'bubble' || phase === 'hidden') {
      setMessages([]);
      setInput('');
      setLoading(false);
    }
  }, [currentPageKey, phase]);

  useEffect(() => {
    setPhase('hidden');
    setBubbleExiting(false);
  }, [currentPageKey]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (phase === 'chat') {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [phase]);

  const handleDismiss = useCallback(() => {
    setBubbleExiting(true);
    setTimeout(() => {
      setPhase('hidden');
      setBubbleExiting(false);
      setDismissedPages((prev) => new Set(prev).add(currentPageKey));
    }, 200);
  }, [currentPageKey]);

  const handleOpenChat = useCallback(() => {
    setPhase('chat');
    setBubbleExiting(false);
    const helpPrompt = t(HELP_PROMPT_KEYS[currentPageKey] ?? HELP_PROMPT_KEYS.home);
    setMessages([
      {
        id: `greeting_${Date.now()}`,
        role: 'assistant',
        content: helpPrompt,
      },
    ]);
  }, [currentPageKey, t]);

  const handleCloseChat = useCallback(() => {
    setPhase('hidden');
    setDismissedPages((prev) => new Set(prev).add(currentPageKey));
  }, [currentPageKey]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: text,
    };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput('');
    setLoading(true);

    try {
      const apiMessages = updatedMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const pageCtx: Record<string, string> = {};
      if (pageContext.tokenSymbol) pageCtx.symbol = pageContext.tokenSymbol;
      if (pageContext.tokenChain) pageCtx.chain = pageContext.tokenChain;
      if (pageContext.marketType) pageCtx.marketType = pageContext.marketType;

      const result = await agentChat({
        sessionId,
        page: currentPageKey,
        pageContext: pageCtx,
        messages: apiMessages,
      });

      setMessages((prev) => [
        ...prev,
        {
          id: `assistant_${Date.now()}`,
          role: 'assistant',
          content: result.reply,
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
  }, [input, loading, messages, sessionId, currentPageKey, pageContext, t]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  if (phase === 'hidden') return null;

  const helpPromptKey = HELP_PROMPT_KEYS[currentPageKey] ?? HELP_PROMPT_KEYS.home;
  const helpPrompt = t(helpPromptKey);

  if (phase === 'bubble') {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40">
        <div
          className={`pointer-events-auto mx-auto w-full max-w-105 px-4 pb-22 ${bubbleExiting ? 'agent-bubble-exit' : 'agent-bubble-enter'}`}
        >
          <div className="rounded-2xl border border-base-300 bg-base-100 p-4 shadow-lg">
            <div className="mb-3 flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary">
                <Bot size={18} className="text-primary-content" />
              </div>
              <p className="pt-1 text-sm leading-relaxed text-base-content">
                {helpPrompt}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-ghost btn-sm h-8 min-h-0 rounded-lg text-xs"
                onClick={handleDismiss}
              >
                {t('agent.dismiss')}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm h-8 min-h-0 rounded-lg text-xs"
                onClick={handleOpenChat}
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
