import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bot, CheckCircle2, ChevronDown, LoaderCircle, Send } from 'lucide-react';
import {
  agentChat,
  getAppConfig,
  getCoinDetail,
  getMarketWatchlist,
  quoteTransfer,
  searchMarketTokens,
  submitTransfer,
  type AgentChatMessage,
  type AgentChatQuickReplyOption,
  type AgentChatResponse,
  type AgentChatTransferAction,
  type TopMarketAsset,
  type TransferQuoteResponse,
  type TransferRecord,
} from '../api';
import type { AgentChatContextOverrides, AgentChatOpenRequest, AgentNudge, PageContext } from '../agent/types';
import { normalizeContractForChain } from '../utils/chainIdentity';

type AgentAssistantProps = {
  entryNudge?: AgentNudge | null;
  onClose?: () => void;
  pageContext: PageContext;
  openRequest?: {
    key: number;
  } & AgentChatOpenRequest;
};

type TransferPreviewActionState = 'quoting' | 'ready' | 'quoteError' | 'submitting' | 'submitError' | 'submitted';

type TransferPreviewActionCard = {
  kind: 'transfer_preview';
  id: string;
  request: AgentChatTransferAction;
  state: TransferPreviewActionState;
  quote: TransferQuoteResponse | null;
  transfer: TransferRecord | null;
  resolvedSymbol: string | null;
  errorMessage: string | null;
};

type QuickRepliesActionCard = {
  kind: 'quick_replies';
  id: string;
  options: AgentChatQuickReplyOption[];
};

type ChatActionCard = TransferPreviewActionCard | QuickRepliesActionCard;

type ChatMessage = AgentChatMessage & {
  id: string;
  actions?: ChatActionCard[];
};

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

function generateChatActionId(): string {
  return `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

function truncateAddress(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatFeeAmount(rawAmount: string | null, decimals: number | null | undefined): string | null {
  if (!rawAmount) return null;
  const normalizedDecimals = Number.isFinite(Number(decimals)) ? Number(decimals) : 18;
  if (normalizedDecimals < 0 || normalizedDecimals > 36) return null;
  try {
    const raw = BigInt(rawAmount);
    const divisor = 10n ** BigInt(normalizedDecimals);
    const whole = raw / divisor;
    const fraction = raw % divisor;
    if (fraction === 0n) return whole.toString();
    const fractionText = fraction.toString().padStart(normalizedDecimals, '0').replace(/0+$/, '').slice(0, 6);
    return `${whole.toString()}.${fractionText}`;
  } catch {
    return null;
  }
}

function isTransferActionCard(action: ChatActionCard): action is TransferPreviewActionCard {
  return action.kind === 'transfer_preview';
}

function isQuickRepliesActionCard(action: ChatActionCard): action is QuickRepliesActionCard {
  return action.kind === 'quick_replies';
}

export function AgentAssistant({ entryNudge = null, onClose, pageContext, openRequest }: AgentAssistantProps) {
  const { i18n, t } = useTranslation();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'closed' | 'panel' | 'chat'>('closed');
  const [activeNudge, setActiveNudge] = useState<AgentNudge | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [contextOverrides, setContextOverrides] = useState<AgentChatContextOverrides>({});
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
  const { data: appConfig } = useQuery({
    queryKey: ['app-config'],
    queryFn: getAppConfig,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const transferSupportedChains = useMemo(
    () => (appConfig?.supportedChains ?? []).filter((chain) => chain.protocol === 'evm' || chain.protocol === 'svm' || chain.protocol === 'tvm' || chain.protocol === 'btc'),
    [appConfig?.supportedChains],
  );

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

  const buildStarterQuickReplies = useCallback((): AgentChatQuickReplyOption[] => {
    const locale = (i18n.resolvedLanguage ?? i18n.language ?? '').trim().toLowerCase();
    const pack = locale.startsWith('zh') ? 'zh' : locale.startsWith('ar') ? 'ar' : 'en';
    const symbol = pageContext.tokenSymbol ?? tokenDetail?.symbol ?? routePreview?.symbol ?? null;
    const tokenLabel = symbol ? symbol.trim().toUpperCase() : null;

    const options = {
      home: {
        en: [
          { label: 'Review portfolio', message: 'Review my portfolio and tell me the main risks and opportunities.' },
          { label: 'Find setups', message: "Find a few trading setups worth watching today." },
          { label: 'Summarize market', message: 'Give me a quick market summary for today.' },
        ],
        zh: [
          { label: '看组合', message: '帮我看看我的投资组合，告诉我当前主要风险和机会。' },
          { label: '找机会', message: '帮我找几个今天值得关注的交易机会。' },
          { label: '看市场', message: '给我一个今天的市场简报。' },
        ],
        ar: [
          { label: 'راجع المحفظة', message: 'راجع محفظتي وأخبرني بأهم المخاطر والفرص الآن.' },
          { label: 'ابحث عن فرص', message: 'اعثر لي على بعض فرص التداول الجديرة بالمتابعة اليوم.' },
          { label: 'ملخص السوق', message: 'أعطني ملخصاً سريعاً للسوق اليوم.' },
        ],
      },
      trade: {
        en: [
          { label: 'Top setups', message: 'Show me the strongest trading setups on this page.' },
          { label: 'Risk check', message: 'Which setups here look too risky right now?' },
          { label: 'Explain momentum', message: 'Explain what is driving momentum here.' },
        ],
        zh: [
          { label: '强势机会', message: '帮我找出这个页面里最强的交易机会。' },
          { label: '风险检查', message: '这里哪些机会现在风险偏高？' },
          { label: '解释动能', message: '解释一下这里的行情动能主要来自什么。' },
        ],
        ar: [
          { label: 'أفضل الفرص', message: 'اعرض لي أقوى فرص التداول في هذه الصفحة.' },
          { label: 'فحص المخاطر', message: 'أي الفرص هنا تبدو عالية المخاطر الآن؟' },
          { label: 'اشرح الزخم', message: 'اشرح ما الذي يدفع الزخم في هذه الصفحة.' },
        ],
      },
      wallet: {
        en: [
          { label: 'Review balances', message: 'Review my wallet balances and tell me what stands out.' },
          { label: 'Transfer help', message: 'Help me prepare a transfer safely.' },
          { label: 'Reduce risk', message: 'How can I reduce wallet risk from here?' },
        ],
        zh: [
          { label: '看余额', message: '帮我看看钱包余额，指出最值得注意的地方。' },
          { label: '转账帮助', message: '帮我安全地准备一笔转账。' },
          { label: '降低风险', message: '从当前持仓看，我可以怎么降低钱包风险？' },
        ],
        ar: [
          { label: 'راجع الأرصدة', message: 'راجع أرصدة المحفظة وأخبرني بما يستحق الانتباه.' },
          { label: 'مساعدة تحويل', message: 'ساعدني في تجهيز تحويل بشكل آمن.' },
          { label: 'خفض المخاطر', message: 'كيف يمكنني خفض مخاطر المحفظة من هنا؟' },
        ],
      },
      token: {
        en: [
          { label: tokenLabel ? `Analyze ${tokenLabel}` : 'Analyze token', message: tokenLabel ? `Analyze ${tokenLabel} using the current page context.` : 'Analyze this token using the current page context.' },
          { label: 'Key risks', message: 'What are the main risks for this token right now?' },
          { label: 'Plan next step', message: 'What is the most sensible next step for me on this token?' },
        ],
        zh: [
          { label: tokenLabel ? `分析 ${tokenLabel}` : '分析代币', message: tokenLabel ? `请结合当前页面信息分析 ${tokenLabel}。` : '请结合当前页面信息分析这个代币。' },
          { label: '主要风险', message: '这个代币当前最需要注意的风险是什么？' },
          { label: '下一步建议', message: '基于当前页面，你建议我的下一步动作是什么？' },
        ],
        ar: [
          { label: tokenLabel ? `حلل ${tokenLabel}` : 'حلل الرمز', message: tokenLabel ? `حلل ${tokenLabel} بالاعتماد على معلومات الصفحة الحالية.` : 'حلل هذا الرمز بالاعتماد على معلومات الصفحة الحالية.' },
          { label: 'المخاطر الرئيسية', message: 'ما هي أهم المخاطر لهذا الرمز الآن؟' },
          { label: 'الخطوة التالية', message: 'ما هي الخطوة التالية الأنسب لي بخصوص هذا الرمز؟' },
        ],
      },
      article: {
        en: [
          { label: 'Summarize article', message: 'Summarize this article into the most actionable points.' },
          { label: 'Why it matters', message: 'Why does this article matter for my portfolio?' },
          { label: 'What to verify', message: 'What claims in this article should I verify before acting?' },
        ],
        zh: [
          { label: '总结文章', message: '把这篇文章总结成最有行动价值的几点。' },
          { label: '和我有关吗', message: '这篇文章为什么和我的持仓有关？' },
          { label: '先核实什么', message: '如果要据此行动，我应该先核实文章里的哪些点？' },
        ],
        ar: [
          { label: 'لخص المقال', message: 'لخص هذا المقال إلى أهم النقاط القابلة للتنفيذ.' },
          { label: 'لماذا يهمني', message: 'لماذا يهم هذا المقال محفظتي؟' },
          { label: 'ما الذي أتحقق منه', message: 'ما الادعاءات التي يجب أن أتحقق منها قبل أن أتصرف؟' },
        ],
      },
      market: {
        en: [
          { label: 'Explain this market', message: 'Explain the market data on this page in simple terms.' },
          { label: 'Spot the risk', message: 'What risk signals stand out in this market right now?' },
          { label: 'Find an angle', message: 'What trading angle is most interesting here?' },
        ],
        zh: [
          { label: '解释市场', message: '用简单的话解释一下这个页面里的市场数据。' },
          { label: '识别风险', message: '这个市场现在最明显的风险信号是什么？' },
          { label: '找角度', message: '这里最值得关注的交易角度是什么？' },
        ],
        ar: [
          { label: 'اشرح السوق', message: 'اشرح بيانات السوق في هذه الصفحة بطريقة بسيطة.' },
          { label: 'حدد المخاطر', message: 'ما إشارات المخاطر الأوضح في هذا السوق الآن؟' },
          { label: 'ابحث عن زاوية', message: 'ما الزاوية التداولية الأكثر إثارة هنا؟' },
        ],
      },
    } as const;

    const selected = options[currentPageKey]?.[pack] ?? options.home[pack];
    return selected.map((option) => ({ ...option }));
  }, [currentPageKey, i18n.language, i18n.resolvedLanguage, pageContext.tokenSymbol, routePreview?.symbol, tokenDetail?.symbol]);

  useEffect(() => {
    setPhase('closed');
    setActiveNudge(null);
    setMessages([]);
    setInput('');
    setLoading(false);
    setContextOverrides({});
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
    setContextOverrides({});
    const helpPrompt = t(HELP_PROMPT_KEYS[currentPageKey] ?? HELP_PROMPT_KEYS.home);
    setMessages([
      {
        id: `greeting_${Date.now()}`,
        role: 'assistant',
        content: helpPrompt,
        actions: [
          {
            kind: 'quick_replies',
            id: generateChatActionId(),
            options: buildStarterQuickReplies(),
          },
        ],
      },
    ]);
  }, [buildStarterQuickReplies, currentPageKey, t]);

  const buildPageContextPayload = useCallback((requestOverrides?: AgentChatContextOverrides): Record<string, string> => {
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

    const mergedOverrides = {
      ...contextOverrides,
      ...(requestOverrides ?? {}),
    };

    for (const [key, value] of Object.entries(mergedOverrides)) {
      const normalized = value.trim();
      if (normalized) pageCtx[key] = normalized;
    }

    return pageCtx;
  }, [
    contextOverrides,
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

  const getSupportedChain = useCallback(
    (networkKey: string) => transferSupportedChains.find((chain) => chain.networkKey === networkKey) ?? null,
    [transferSupportedChains],
  );

  const getTransferFeeText = useCallback(
    (quote: TransferQuoteResponse) => {
      const symbol = quote.tokenSymbol ?? '';
      if (quote.estimatedFeeTokenAmount) {
        return `${quote.estimatedFeeTokenAmount} ${symbol}`.trim();
      }
      const normalized = formatFeeAmount(quote.estimatedFeeTokenWei, quote.tokenDecimals);
      if (normalized) return `${normalized} ${symbol}`.trim();
      return quote.estimatedFeeWei ?? t('wallet.transferQuoteUnavailable');
    },
    [t],
  );

  const getTransferActionErrorMessage = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : 'unknown_error';
      if (message === 'transfer_chain_not_supported' || message === 'invalid_network_key') {
        return t('wallet.transferChainNotSupported');
      }
      if (message === 'agent_transfer_token_not_found') {
        return t('agent.chatTransferTokenNotFound');
      }
      if (message === 'insufficient_fee_token_balance') {
        return t('wallet.transferInsufficientFeeTokenBalance');
      }
      if (message === 'unsupported_fee_token') {
        return t('wallet.transferUnsupportedFeeToken');
      }
      return `${t('wallet.transferFailed')}: ${message}`;
    },
    [t],
  );

  const resolveTransferQuoteRequest = useCallback(
    async (request: AgentChatTransferAction) => {
      const chain = getSupportedChain(request.networkKey);
      if (!chain) {
        throw new Error('transfer_chain_not_supported');
      }

      let tokenSymbol = request.tokenSymbol?.trim().toUpperCase() || undefined;
      let tokenAddress = request.tokenAddress?.trim() || undefined;
      const tokenDecimals = Number.isFinite(Number(request.tokenDecimals)) ? Number(request.tokenDecimals) : undefined;
      const isNativeAsset = tokenSymbol ? tokenSymbol === chain.symbol.trim().toUpperCase() : !tokenAddress;

      if (!tokenAddress && tokenSymbol && !isNativeAsset) {
        const results = await searchMarketTokens(tokenSymbol, 12);
        const matched = results.find((item) => (
          item.marketType === 'spot'
          && item.symbol.trim().toUpperCase() === tokenSymbol
          && (item.chain ?? '').trim().toLowerCase() === chain.marketChain
          && Boolean(item.contract)
        ));
        if (!matched?.contract) {
          throw new Error('agent_transfer_token_not_found');
        }
        tokenAddress = matched.contract;
        tokenSymbol = matched.symbol.trim().toUpperCase();
      }

      return {
        networkKey: chain.networkKey,
        toAddress: request.toAddress.trim(),
        amount: request.amount.trim(),
        tokenAddress: isNativeAsset ? undefined : tokenAddress,
        tokenSymbol,
        tokenDecimals,
      };
    },
    [getSupportedChain],
  );

  const buildTransferActionCard = useCallback(
    async (request: AgentChatTransferAction): Promise<TransferPreviewActionCard> => {
      const chain = getSupportedChain(request.networkKey);
      const fallbackSymbol = request.tokenSymbol?.trim().toUpperCase() || chain?.symbol || null;
      try {
        const quoteRequest = await resolveTransferQuoteRequest(request);
        const quote = await quoteTransfer(quoteRequest);
        if (quote.insufficientFeeTokenBalance) {
          return {
            kind: 'transfer_preview',
            id: generateChatActionId(),
            request,
            state: 'quoteError',
            quote,
            transfer: null,
            resolvedSymbol: quote.tokenSymbol ?? fallbackSymbol,
            errorMessage: t('wallet.transferInsufficientFeeTokenBalanceWithFee', { fee: getTransferFeeText(quote) }),
          };
        }
        return {
          kind: 'transfer_preview',
          id: generateChatActionId(),
          request,
          state: 'ready',
          quote,
          transfer: null,
          resolvedSymbol: quote.tokenSymbol ?? fallbackSymbol,
          errorMessage: null,
        };
      } catch (error) {
        return {
          kind: 'transfer_preview',
          id: generateChatActionId(),
          request,
          state: 'quoteError',
          quote: null,
          transfer: null,
          resolvedSymbol: fallbackSymbol,
          errorMessage: getTransferActionErrorMessage(error),
        };
      }
    },
    [getSupportedChain, getTransferActionErrorMessage, getTransferFeeText, resolveTransferQuoteRequest, t],
  );

  const buildAssistantMessage = useCallback(
    async (result: AgentChatResponse): Promise<ChatMessage> => {
      const actions = await Promise.all(
        (result.actions ?? []).map(async (action) => {
          if (action.type === 'transfer_preview') {
            return buildTransferActionCard(action);
          }
          if (action.type === 'quick_replies') {
            return {
              kind: 'quick_replies' as const,
              id: generateChatActionId(),
              options: action.options,
            };
          }
          return null;
        }),
      );
      return {
        id: `assistant_${Date.now()}`,
        role: 'assistant',
        content: result.reply,
        actions: actions.filter((action): action is ChatActionCard => Boolean(action)),
      };
    },
    [buildTransferActionCard],
  );

  const updateTransferActionCard = useCallback(
    (
      actionId: string,
      updater: (action: TransferPreviewActionCard) => TransferPreviewActionCard,
    ) => {
      setMessages((prev) => prev.map((message) => {
        if (!message.actions?.length) return message;
        let changed = false;
        const nextActions = message.actions.map((action) => {
          if (!isTransferActionCard(action) || action.id !== actionId) return action;
          changed = true;
          return updater(action);
        });
        return changed ? { ...message, actions: nextActions } : message;
      }));
    },
    [],
  );

  const retryTransferPreview = useCallback(
    async (actionId: string, request: AgentChatTransferAction) => {
      updateTransferActionCard(actionId, (action) => ({
        ...action,
        state: 'quoting',
        errorMessage: null,
      }));

      try {
        const quoteRequest = await resolveTransferQuoteRequest(request);
        const quote = await quoteTransfer(quoteRequest);
        if (quote.insufficientFeeTokenBalance) {
          updateTransferActionCard(actionId, (action) => ({
            ...action,
            state: 'quoteError',
            quote,
            resolvedSymbol: quote.tokenSymbol ?? action.resolvedSymbol,
            errorMessage: t('wallet.transferInsufficientFeeTokenBalanceWithFee', { fee: getTransferFeeText(quote) }),
          }));
          return;
        }
        updateTransferActionCard(actionId, (action) => ({
          ...action,
          state: 'ready',
          quote,
          resolvedSymbol: quote.tokenSymbol ?? action.resolvedSymbol,
          errorMessage: null,
        }));
      } catch (error) {
        updateTransferActionCard(actionId, (action) => ({
          ...action,
          state: 'quoteError',
          errorMessage: getTransferActionErrorMessage(error),
        }));
      }
    },
    [getTransferActionErrorMessage, getTransferFeeText, resolveTransferQuoteRequest, t, updateTransferActionCard],
  );

  const findLatestConfirmableTransfer = useCallback((): TransferPreviewActionCard | null => {
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const action = [...(messages[messageIndex]?.actions ?? [])]
        .reverse()
        .find((candidate) => (
          isTransferActionCard(candidate)
          && (candidate.state === 'ready' || candidate.state === 'submitError')
          && !candidate.transfer
        ));
      if (action && isTransferActionCard(action)) {
        return action;
      }
    }
    return null;
  }, [messages]);

  const findTransferActionById = useCallback(
    (actionId: string): TransferPreviewActionCard | null => {
      for (const message of messages) {
        for (const action of message.actions ?? []) {
          if (isTransferActionCard(action) && action.id === actionId) {
            return action;
          }
        }
      }
      return null;
    },
    [messages],
  );

  const requestReply = useCallback(
    async (apiMessages: AgentChatMessage[], requestContextOverrides?: AgentChatContextOverrides) => {
      return agentChat({
        sessionId,
        page: currentPageKey,
        pageContext: buildPageContextPayload(requestContextOverrides),
        messages: apiMessages,
      });
    },
    [buildPageContextPayload, currentPageKey, sessionId],
  );

  const confirmTransferAction = useCallback(
    async (actionId: string) => {
      const activeAction = findTransferActionById(actionId);
      if (!activeAction || (activeAction.state !== 'ready' && activeAction.state !== 'submitError')) return;

      const quote = activeAction.quote;
      if (!quote) {
        await retryTransferPreview(actionId, activeAction.request);
        return;
      }

      updateTransferActionCard(actionId, (action) => ({
        ...action,
        state: 'submitting',
        errorMessage: null,
      }));

      try {
        const result = await submitTransfer({
          networkKey: quote.networkKey,
          toAddress: quote.toAddress,
          amount: quote.amountInput,
          tokenAddress: quote.tokenAddress ?? undefined,
          tokenSymbol: quote.tokenSymbol ?? undefined,
          tokenDecimals: quote.tokenDecimals,
          idempotencyKey: `agent-chat:${sessionId}:${actionId}`,
        });
        updateTransferActionCard(actionId, (action) => ({
          ...action,
          state: 'submitted',
          transfer: result.transfer,
          errorMessage: null,
        }));
      } catch (error) {
        updateTransferActionCard(actionId, (action) => ({
          ...action,
          state: 'submitError',
          errorMessage: getTransferActionErrorMessage(error),
        }));
      }
    },
    [findTransferActionById, getTransferActionErrorMessage, retryTransferPreview, sessionId, updateTransferActionCard],
  );

  const openTaskChat = useCallback(
    async (prompt: string, intro: string, requestContextOverrides?: AgentChatContextOverrides) => {
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
        const result = await requestReply(
          seededMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          requestContextOverrides,
        );
        const assistantMessage = await buildAssistantMessage(result);
        setMessages((prev) => [...prev, assistantMessage]);
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
    [buildAssistantMessage, loading, requestReply, t],
  );

  useEffect(() => {
    const requestKey = openRequest?.key ?? 0;
    if (requestKey <= handledOpenRequestKeyRef.current) return;
    handledOpenRequestKeyRef.current = requestKey;
    setMessages([]);
    setInput('');
    setLoading(false);
    setContextOverrides(openRequest?.contextOverrides ?? {});
    if (entryNudge) {
      setActiveNudge(entryNudge);
      setPhase('panel');
      return;
    }
    if (openRequest?.prompt && openRequest.intro) {
      void openTaskChat(openRequest.prompt, openRequest.intro, openRequest.contextOverrides);
      return;
    }
    openGenericChat();
  }, [entryNudge, openGenericChat, openRequest, openTaskChat]);

  const handleCloseChat = useCallback(() => {
    setPhase('closed');
    setActiveNudge(null);
    setInput('');
    onClose?.();
  }, [onClose]);

  const sendChatText = useCallback(async (rawText: string) => {
    const text = rawText.trim();
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
    const pendingTransferAction = !shouldExpandTokenAnalysis && isShortAffirmation(text)
      ? findLatestConfirmableTransfer()
      : null;
    const normalizedUserMsg = shouldExpandTokenAnalysis
      ? {
          ...userMsg,
          content: buildTokenAnalysisPrompt(i18n.resolvedLanguage ?? i18n.language ?? null),
        }
      : userMsg;
    const updatedMessages = [...messages, normalizedUserMsg];
    setMessages(updatedMessages);
    setInput('');

    if (pendingTransferAction) {
      await confirmTransferAction(pendingTransferAction.id);
      return;
    }

    setLoading(true);

    try {
      const apiMessages = updatedMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const result = await requestReply(apiMessages);
      const assistantMessage = await buildAssistantMessage(result);
      setMessages((prev) => [...prev, assistantMessage]);
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
  }, [
    buildAssistantMessage,
    confirmTransferAction,
    findLatestConfirmableTransfer,
    i18n.language,
    i18n.resolvedLanguage,
    input,
    loading,
    messages,
    requestReply,
    t,
    currentPageKey,
  ]);

  const handleSend = useCallback(async () => {
    await sendChatText(input);
  }, [input, sendChatText]);

  const renderTransferActionCard = useCallback(
    (action: TransferPreviewActionCard) => {
      const chain = getSupportedChain(action.request.networkKey);
      const networkLabel = chain?.name ?? action.request.networkKey;
      const assetSymbol = action.quote?.tokenSymbol ?? action.resolvedSymbol ?? chain?.symbol ?? t('trade.nativeToken');
      const feeText = action.quote ? getTransferFeeText(action.quote) : t('wallet.transferQuoteUnavailable');
      const statusText = (() => {
        if (action.state === 'quoting') return t('agent.chatTransferPreparing');
        if (action.state === 'ready') return t('agent.chatTransferConfirmHint');
        if (action.state === 'submitting') return t('wallet.transferSubmitting');
        if (action.state === 'submitted') return action.transfer?.txHash
          ? `${t('agent.chatTransferSubmitted')} ${truncateAddress(action.transfer.txHash)}`
          : t('agent.chatTransferSubmitted');
        return action.errorMessage ?? t('agent.chatTransferPreviewFailed');
      })();

      return (
        <div key={action.id} className="rounded-[1.5rem] border border-primary/15 bg-gradient-to-br from-base-100 via-base-100 to-base-200/70 p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.24em] text-primary/70">
                {t('agent.chatTransferPreviewTitle')}
              </p>
              <p className="m-0 mt-1 text-lg font-semibold text-base-content">
                {action.request.amount} {assetSymbol}
              </p>
            </div>
            {action.state === 'submitting' || action.state === 'quoting' ? (
              <LoaderCircle size={18} className="mt-1 animate-spin text-primary" />
            ) : action.state === 'submitted' ? (
              <CheckCircle2 size={18} className="mt-1 text-success" />
            ) : (
              <Send size={17} className="mt-1 text-primary" />
            )}
          </div>

          <div className="mt-4 grid gap-2 rounded-2xl bg-base-200/60 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-base-content/60">{t('wallet.transferChain')}</span>
              <span className="font-medium text-base-content">{networkLabel}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-base-content/60">{t('agent.chatTransferFrom')}</span>
              <span className="font-medium text-base-content">{truncateAddress(action.quote?.fromAddress ?? '--')}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-base-content/60">{t('wallet.transferToAddress')}</span>
              <span className="font-medium text-base-content">{truncateAddress(action.request.toAddress)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-base-content/60">{t('wallet.transferQuoteFee')}</span>
              <span className="font-medium text-base-content">{feeText}</span>
            </div>
          </div>

          <p className={`m-0 mt-3 text-xs leading-relaxed ${
            action.state === 'quoteError' || action.state === 'submitError' ? 'text-error' : 'text-base-content/65'
          }`}>
            {statusText}
          </p>

          <div className="mt-3 flex gap-2">
            {(action.state === 'quoteError' || action.state === 'quoting') && (
              <button
                type="button"
                className="btn btn-outline btn-sm flex-1 rounded-full"
                onClick={() => void retryTransferPreview(action.id, action.request)}
                disabled={action.state === 'quoting'}
              >
                {t('wallet.transferRetry')}
              </button>
            )}
            {(action.state === 'ready' || action.state === 'submitError') && (
              <button
                type="button"
                className="btn btn-primary btn-sm flex-1 rounded-full"
                onClick={() => void confirmTransferAction(action.id)}
              >
                {t('wallet.transferConfirm')}
              </button>
            )}
          </div>
        </div>
      );
    },
    [confirmTransferAction, getSupportedChain, getTransferFeeText, retryTransferPreview, t],
  );

  const renderQuickRepliesActionCard = useCallback(
    (action: QuickRepliesActionCard) => (
      <div key={action.id} className="flex flex-wrap gap-2">
        {action.options.map((option, index) => {
          const message = option.message?.trim() || option.label.trim();
          const label = option.label.trim();
          if (!message || !label) return null;

          return (
            <button
              key={`${action.id}_${index}`}
              type="button"
              className="btn btn-outline btn-sm min-h-0 rounded-full px-4"
              onClick={() => void sendChatText(message)}
              disabled={loading}
            >
              {label}
            </button>
          );
        })}
      </div>
    ),
    [loading, sendChatText],
  );

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
        <div className="agent-chat-sheet mx-auto flex w-full flex-col bg-base-100 shadow-2xl">
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

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
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
      <div className="agent-chat-sheet mx-auto flex w-full flex-col bg-base-100 shadow-2xl">
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
              className={`agent-chat-message-row ${
                msg.role === 'user' ? 'agent-chat-message-row--user' : 'agent-chat-message-row--assistant'
              }`}
            >
              {msg.role === 'assistant' && (
                <div className="mr-2 mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary">
                  <Bot size={12} className="text-primary-content" />
                </div>
              )}
              <div
                className={`agent-chat-message-content ${
                  msg.role === 'user'
                    ? 'agent-chat-message-content--user'
                    : 'agent-chat-message-content--assistant'
                }`}
              >
                {msg.content ? (
                  <div
                    className={`agent-chat-bubble ${
                      msg.role === 'user' ? 'agent-chat-bubble--user' : 'agent-chat-bubble--assistant'
                    } ${
                      msg.role === 'user'
                        ? 'bg-primary text-primary-content'
                        : 'bg-base-200 text-base-content'
                    }`}
                  >
                    {msg.content}
                  </div>
                ) : null}
                {msg.role === 'assistant' && msg.actions?.length ? (
                  <div className={msg.content ? 'mt-3 space-y-3' : 'space-y-3'}>
                    {msg.actions.map((action) => {
                      if (isTransferActionCard(action)) return renderTransferActionCard(action);
                      if (isQuickRepliesActionCard(action)) return renderQuickRepliesActionCard(action);
                      return null;
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {loading && (
            <div className="agent-chat-message-row agent-chat-message-row--assistant">
              <div className="mr-2 mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary">
                <Bot size={12} className="text-primary-content" />
              </div>
              <div className="agent-chat-bubble agent-chat-loading-bubble bg-base-200 text-base-content/60">
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
