import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEntryState, AgentMood, AgentNudge, AgentNudgeType, PageContext } from '../agent/types';
import { subscribeAgentInterventionSignals, type AgentInterventionSignal } from '../utils/agentInterventionBus';

const ARTICLE_DEEP_READ_MS = 25_000;
const DETAIL_COMPARISON_WINDOW_MS = 10 * 60 * 1000;
const GLOBAL_COOLDOWN_MS = 30 * 60 * 1000;
const ENTITY_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_SESSION_NUDGES = 2;
const BUBBLE_VISIBLE_MS = 5_500;

type InterventionCopy = {
  title: string;
  message: string;
  actionLabel: string;
  presetPrompt: string;
};

type UseAgentInterventionResult = {
  activeNudge: AgentNudge | null;
  bubbleMessage: string | null;
  entryState: AgentEntryState;
  mood: AgentMood;
  handleAssistantClosed: () => void;
  dismissActiveNudge: () => void;
  handleEntryOpen: () => void;
};

type DetailVisit = {
  entityKey: string;
  page: PageContext['page'];
  at: number;
};

function resolveLocalePack(locale: string | null): 'zh' | 'en' | 'ar' {
  const normalized = (locale ?? '').trim().toLowerCase();
  if (normalized.startsWith('zh')) return 'zh';
  if (normalized.startsWith('ar')) return 'ar';
  return 'en';
}

function buildEntityKey(pageContext: PageContext): string {
  switch (pageContext.page) {
    case 'article':
      return `article:${pageContext.articleId ?? 'unknown'}`;
    case 'token':
      return `token:${pageContext.tokenChain ?? 'unknown'}:${pageContext.tokenContract ?? 'unknown'}`;
    case 'market':
      return `market:${pageContext.marketType ?? 'unknown'}:${pageContext.marketItemId ?? 'unknown'}`;
    default:
      return pageContext.page;
  }
}

function buildNudgeCopy(type: AgentNudgeType, locale: string | null): InterventionCopy {
  const pack = resolveLocalePack(locale);
  const copy = {
    zh: {
      comparison_intent: {
        title: '我注意到你在比较几个标的',
        message: '你刚刚连续看了几个标的，我可以帮你快速比较波动、流动性和风险。',
        actionLabel: '立即对比',
        presetPrompt: '请帮我对比我刚刚查看的几个标的，重点看波动、流动性和风险。',
      },
      article_deep_read: {
        title: '这篇内容我可以先帮你提炼',
        message: '这篇文章信息较多，我可以先帮你总结重点，并指出值得继续看的部分。',
        actionLabel: '提炼重点',
        presetPrompt: '请先帮我总结这篇文章的重点，并告诉我最值得关注的部分。',
      },
      trade_form_struggle: {
        title: '这一步我可以帮你检查',
        message: '这一步最容易出错，我可以先帮你检查交易参数和关键细节。',
        actionLabel: '帮我检查',
        presetPrompt: '请先帮我检查这笔交易需要注意的参数和潜在错误。',
      },
    },
    en: {
      comparison_intent: {
        title: 'It looks like you are comparing a few assets',
        message: 'You have opened several assets in a row. I can quickly compare volatility, liquidity, and risk.',
        actionLabel: 'Compare now',
        presetPrompt: 'Please compare the assets I just viewed, focusing on volatility, liquidity, and risk.',
      },
      article_deep_read: {
        title: 'I can summarize this article first',
        message: 'This article contains a lot of information. I can extract the key points before you continue.',
        actionLabel: 'Summarize',
        presetPrompt: 'Please summarize this article and point out the most important takeaways.',
      },
      trade_form_struggle: {
        title: 'I can help check this step',
        message: 'This step is easy to get wrong. I can help review the trade details before you proceed.',
        actionLabel: 'Check it',
        presetPrompt: 'Please review this trade setup and tell me what to double-check before submitting.',
      },
    },
    ar: {
      comparison_intent: {
        title: 'يبدو أنك تقارن بين عدة أصول',
        message: 'لقد فتحت عدة أصول بشكل متتالٍ. يمكنني مقارنة التقلب والسيولة والمخاطر بسرعة.',
        actionLabel: 'قارن الآن',
        presetPrompt: 'يرجى مقارنة الأصول التي شاهدتها للتو مع التركيز على التقلب والسيولة والمخاطر.',
      },
      article_deep_read: {
        title: 'يمكنني تلخيص هذا المقال أولاً',
        message: 'هذا المقال يحتوي على معلومات كثيرة. يمكنني استخراج النقاط الأساسية قبل أن تتابع.',
        actionLabel: 'لخصه',
        presetPrompt: 'يرجى تلخيص هذا المقال وتوضيح أهم النقاط التي تستحق المتابعة.',
      },
      trade_form_struggle: {
        title: 'يمكنني مساعدتك في التحقق من هذه الخطوة',
        message: 'هذه الخطوة يسهل أن يحدث فيها خطأ. يمكنني مراجعة تفاصيل الصفقة قبل المتابعة.',
        actionLabel: 'افحصها',
        presetPrompt: 'يرجى مراجعة إعداد هذه الصفقة وإخباري بما يجب التحقق منه قبل الإرسال.',
      },
    },
  } as const;

  return copy[pack][type];
}

export function useAgentIntervention(
  pageContext: PageContext,
  locale: string | null,
): UseAgentInterventionResult {
  const [activeNudge, setActiveNudge] = useState<AgentNudge | null>(null);
  const [bubbleMessage, setBubbleMessage] = useState<string | null>(null);
  const [manualState, setManualState] = useState<AgentEntryState>('idle');
  const detailVisitsRef = useRef<DetailVisit[]>([]);
  const globalCooldownUntilRef = useRef(0);
  const entityCooldownRef = useRef(new Map<string, number>());
  const nudgeCountRef = useRef(0);
  const bubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentEntityKey = buildEntityKey(pageContext);

  const clearBubbleTimer = useCallback(() => {
    if (!bubbleTimerRef.current) return;
    clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = null;
  }, []);

  const isPageObservable = pageContext.page === 'article' || pageContext.page === 'token' || pageContext.page === 'market';

  const enterCooldown = useCallback((entityKey: string, durationMs: number) => {
    const until = Date.now() + durationMs;
    entityCooldownRef.current.set(entityKey, until);
    globalCooldownUntilRef.current = Math.max(globalCooldownUntilRef.current, until);
  }, []);

  const dismissActiveNudge = useCallback(() => {
    if (activeNudge) {
      enterCooldown(`${activeNudge.type}:${activeNudge.entityKey}`, ENTITY_COOLDOWN_MS);
    }
    clearBubbleTimer();
    setBubbleMessage(null);
    setActiveNudge(null);
    setManualState('cooldown');
  }, [activeNudge, clearBubbleTimer, enterCooldown]);

  const hideBubble = useCallback(() => {
    setBubbleMessage(null);
  }, []);

  const queueNudge = useCallback(
    (type: AgentNudgeType, page: PageContext['page'], entityKey: string, priority: 'medium' | 'high' = 'medium') => {
      const now = Date.now();
      if (nudgeCountRef.current >= MAX_SESSION_NUDGES) return;
      if (globalCooldownUntilRef.current > now) return;
      if ((entityCooldownRef.current.get(`${type}:${entityKey}`) ?? 0) > now) return;
      if (activeNudge?.type === type && activeNudge.entityKey === entityKey) return;

      const copy = buildNudgeCopy(type, locale);
      const nextNudge: AgentNudge = {
        id: `${type}:${entityKey}:${now}`,
        type,
        page,
        entityKey,
        title: copy.title,
        message: copy.message,
        actionLabel: copy.actionLabel,
        presetPrompt: copy.presetPrompt,
        priority,
        createdAt: now,
      };

      nudgeCountRef.current += 1;
      setActiveNudge(nextNudge);
      setBubbleMessage(copy.message);
      setManualState('nudging');
      clearBubbleTimer();
      bubbleTimerRef.current = setTimeout(() => {
        hideBubble();
      }, BUBBLE_VISIBLE_MS);
    },
    [activeNudge, clearBubbleTimer, hideBubble, locale],
  );

  const handleEntryOpen = useCallback(() => {
    clearBubbleTimer();
    setBubbleMessage(null);
    setManualState('engaged');
    const entityKey = activeNudge?.entityKey ?? currentEntityKey;
    const cooldownKey = activeNudge ? `${activeNudge.type}:${entityKey}` : entityKey;
    enterCooldown(cooldownKey, GLOBAL_COOLDOWN_MS);
    if (!activeNudge) {
      globalCooldownUntilRef.current = Date.now() + GLOBAL_COOLDOWN_MS;
    }
  }, [activeNudge, clearBubbleTimer, currentEntityKey, enterCooldown]);

  const handleAssistantClosed = useCallback(() => {
    setActiveNudge(null);
    setBubbleMessage(null);
    setManualState(isPageObservable ? 'observing' : 'idle');
  }, [isPageObservable]);

  useEffect(() => {
    return () => {
      clearBubbleTimer();
    };
  }, [clearBubbleTimer]);

  useEffect(() => {
    if (!activeNudge) return;
    if (activeNudge.page === pageContext.page && activeNudge.entityKey === currentEntityKey) return;
    clearBubbleTimer();
    setBubbleMessage(null);
    setActiveNudge(null);
  }, [activeNudge, clearBubbleTimer, currentEntityKey, pageContext.page]);

  useEffect(() => {
    if (!isPageObservable && !activeNudge) {
      setManualState('idle');
      return;
    }
    if (activeNudge) return;
    setManualState(isPageObservable ? 'observing' : 'idle');
  }, [activeNudge, isPageObservable, currentEntityKey]);

  useEffect(() => {
    const isDetailPage = pageContext.page === 'token' || pageContext.page === 'market';
    if (!isDetailPage) return;

    const now = Date.now();
    const nextVisit: DetailVisit = {
      entityKey: currentEntityKey,
      page: pageContext.page,
      at: now,
    };

    const recent = detailVisitsRef.current
      .filter((visit) => now - visit.at <= DETAIL_COMPARISON_WINDOW_MS)
      .filter((visit, index, visits) => visits.findIndex((item) => item.entityKey === visit.entityKey) === index);

    if (!recent.some((visit) => visit.entityKey === nextVisit.entityKey)) {
      recent.push(nextVisit);
    }
    detailVisitsRef.current = recent;

    if (recent.length < 3) return;

    const timeout = setTimeout(() => {
      queueNudge('comparison_intent', pageContext.page, currentEntityKey);
    }, 1_600);

    return () => clearTimeout(timeout);
  }, [currentEntityKey, pageContext.page, queueNudge]);

  useEffect(() => {
    if (pageContext.page !== 'article') return;
    const timeout = setTimeout(() => {
      queueNudge('article_deep_read', 'article', currentEntityKey);
    }, ARTICLE_DEEP_READ_MS);

    return () => clearTimeout(timeout);
  }, [currentEntityKey, pageContext.page, queueNudge]);

  useEffect(() => {
    return subscribeAgentInterventionSignals((signal: AgentInterventionSignal) => {
      if (signal.type !== 'trade_form_struggle') return;
      if (pageContext.page !== 'trade') return;
      queueNudge('trade_form_struggle', 'trade', signal.entityKey ?? 'trade', 'high');
    });
  }, [pageContext.page, queueNudge]);

  const mood = useMemo<AgentMood>(() => {
    if (activeNudge?.priority === 'high') return 'warning';
    if (activeNudge && bubbleMessage) return 'ready';
    if (activeNudge) return 'thinking';
    if (manualState === 'cooldown') return 'neutral';
    if (isPageObservable) return 'watching';
    return 'neutral';
  }, [activeNudge, bubbleMessage, isPageObservable, manualState]);

  const entryState = useMemo<AgentEntryState>(() => {
    if (manualState === 'engaged') return 'engaged';
    if (manualState === 'cooldown') return 'cooldown';
    if (activeNudge && bubbleMessage) return 'nudging';
    if (activeNudge) return 'thinking';
    if (isPageObservable) return 'observing';
    return 'idle';
  }, [activeNudge, bubbleMessage, isPageObservable, manualState]);

  return {
    activeNudge,
    bubbleMessage,
    entryState,
    mood,
    handleAssistantClosed,
    dismissActiveNudge,
    handleEntryOpen,
  };
}
