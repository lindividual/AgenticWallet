import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bookmark, Heart, Pause, Play, Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getAgentArticleDetail,
  getTopMarketAssets,
  ingestAgentEvent,
  type TopMarketAsset,
} from '../../api';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { useToast } from '../../contexts/ToastContext';

type ArticleReaderScreenProps = {
  articleId: string;
  onBack: () => void;
  onOpenToken?: (chain: string, contract: string, tokenPreview?: TopMarketAsset) => void;
};

type ArticleEngagement = {
  liked: boolean;
  favorited: boolean;
};

type RelatedAssetPill = {
  symbol: string;
  name: string;
  priceChangePct: number | null;
  chain: string | null;
  contract: string | null;
  clickable: boolean;
  tokenPreview: TopMarketAsset | null;
};

const DEFAULT_TOKEN_ROUTE_BY_SYMBOL: Record<string, { chain: string; contract: string; name?: string }> = {
  ETH: {
    chain: 'eth',
    contract: 'native',
    name: 'Ethereum',
  },
  BTC: {
    chain: 'eth',
    contract: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    name: 'Bitcoin',
  },
  USDT: {
    chain: 'eth',
    contract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    name: 'Tether',
  },
  USDC: {
    chain: 'eth',
    contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    name: 'USD Coin',
  },
  BNB: {
    chain: 'bnb',
    contract: 'native',
    name: 'BNB',
  },
  LEO: {
    chain: 'eth',
    contract: '0x2af5d2ad76741191d15dfe7bf6ac92d4bd912ca3',
    name: 'LEO Token',
  },
};

const STORAGE_KEY = 'agentic_wallet_article_engagement_v1';

function readEngagementMap(): Record<string, ArticleEngagement> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ArticleEngagement>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveEngagementMap(value: Record<string, ArticleEngagement>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage write errors in private or restricted modes.
  }
}

function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>-]/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSymbol(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatPct(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(2)}%`;
}

function normalizeRoutableTokenContract(contract: string): string | null {
  const normalized = contract.trim().toLowerCase();
  if (!normalized || normalized === 'native') return 'native';
  if (/^0x[a-f0-9]{40}$/.test(normalized)) return normalized;
  return null;
}

function extractRelatedSymbols(tags: string[] | undefined, markdown: string): string[] {
  const collected: string[] = [];

  for (const tag of tags ?? []) {
    if (!tag.startsWith('asset:')) continue;
    const symbol = normalizeSymbol(tag.slice('asset:'.length));
    if (symbol) collected.push(symbol);
  }

  if (collected.length === 0) {
    const section = markdown.match(/##\s*Related Assets\s*([\s\S]*?)(?:\n##\s+|$)/i);
    const body = section?.[1] ?? '';
    const lines = body.split('\n');
    for (const line of lines) {
      const bullet = line.match(/^\s*[-*+]\s+([A-Za-z0-9._-]{2,24})/);
      if (!bullet?.[1]) continue;
      const symbol = normalizeSymbol(bullet[1]);
      if (symbol) collected.push(symbol);
    }
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const symbol of collected) {
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    deduped.push(symbol);
  }
  return deduped.slice(0, 8);
}

function hasTokenRoute(asset: TopMarketAsset | null | undefined): boolean {
  if (!asset) return false;
  return Boolean(asset.chain?.trim() && normalizeRoutableTokenContract(asset.contract ?? ''));
}

function shouldPreferAsset(candidate: TopMarketAsset, current: TopMarketAsset): boolean {
  const candidateHasRoute = hasTokenRoute(candidate);
  const currentHasRoute = hasTokenRoute(current);
  if (candidateHasRoute && !currentHasRoute) return true;
  if (!candidateHasRoute && currentHasRoute) return false;
  const candidateRank = Number(candidate.market_cap_rank ?? Number.MAX_SAFE_INTEGER);
  const currentRank = Number(current.market_cap_rank ?? Number.MAX_SAFE_INTEGER);
  if (candidateRank !== currentRank) return candidateRank < currentRank;
  return false;
}

export function ArticleReaderScreen({ articleId, onBack, onOpenToken }: ArticleReaderScreenProps) {
  const { t, i18n } = useTranslation();
  const { showError, showSuccess, showInfo } = useToast();
  const [engagementMap, setEngagementMap] = useState<Record<string, ArticleEngagement>>(() => readEngagementMap());
  const [isSpeaking, setIsSpeaking] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['article-reader-detail', articleId],
    queryFn: () => getAgentArticleDetail(articleId),
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  const engagement = engagementMap[articleId] ?? { liked: false, favorited: false };
  const speakText = useMemo(() => (data ? stripMarkdown(data.markdown) : ''), [data]);
  const relatedSymbols = useMemo(
    () => (data ? extractRelatedSymbols(data.article.tags, data.markdown) : []),
    [data],
  );

  const { data: relatedTopAssets } = useQuery({
    queryKey: ['top-assets', 'marketCap', 'auto', 120],
    queryFn: () =>
      getTopMarketAssets({
        name: 'marketCap',
        source: 'auto',
        limit: 120,
      }),
    enabled: relatedSymbols.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const relatedPills = useMemo<RelatedAssetPill[]>(() => {
    if (!data || relatedSymbols.length === 0) return [];

    const marketAssets = [...(relatedTopAssets ?? [])];

    const bySymbol = new Map<string, TopMarketAsset | null>();
    for (const asset of marketAssets) {
      const symbol = normalizeSymbol(asset.symbol);
      if (!symbol) continue;
      const existing = bySymbol.get(symbol);
      if (existing === undefined) {
        bySymbol.set(symbol, asset);
        continue;
      }
      if (!existing) continue;
      if (existing.asset_id !== asset.asset_id) {
        bySymbol.set(symbol, null);
        continue;
      }
      if (shouldPreferAsset(asset, existing)) {
        bySymbol.set(symbol, asset);
      }
    }

    return relatedSymbols.map((symbol) => {
      const matched = bySymbol.get(symbol) ?? undefined;
      const marketChain = matched?.chain?.trim() ?? '';
      const marketContract = matched?.contract?.trim() ?? '';
      const normalizedRouteContract = normalizeRoutableTokenContract(marketContract);
      const routeFromMarket = marketChain && normalizedRouteContract
        ? {
            chain: marketChain,
            contract: normalizedRouteContract,
          }
        : null;
      const fallbackRoute = DEFAULT_TOKEN_ROUTE_BY_SYMBOL[symbol] ?? null;
      const route = routeFromMarket ?? fallbackRoute;
      return {
        symbol,
        name: matched?.name?.trim() || fallbackRoute?.name || symbol,
        priceChangePct: matched?.price_change_percentage_24h ?? null,
        chain: route?.chain ?? null,
        contract: route?.contract ?? null,
        clickable: Boolean(route?.chain && route?.contract && onOpenToken),
        tokenPreview: routeFromMarket ? matched ?? null : null,
      };
    });
  }, [data, onOpenToken, relatedSymbols, relatedTopAssets]);

  const hasRelatedPanel = relatedPills.length > 0;

  useEffect(() => {
    ingestAgentEvent('article_read', { articleId }).catch(() => undefined);
  }, [articleId]);

  useEffect(
    () => () => {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    },
    [],
  );

  function patchEngagement(next: Partial<ArticleEngagement>) {
    setEngagementMap((prev) => {
      const merged = {
        ...(prev[articleId] ?? { liked: false, favorited: false }),
        ...next,
      };
      const map = {
        ...prev,
        [articleId]: merged,
      };
      saveEngagementMap(map);
      return map;
    });
  }

  function toggleLike() {
    patchEngagement({ liked: !engagement.liked });
  }

  function toggleFavorite() {
    const nextFavorited = !engagement.favorited;
    patchEngagement({ favorited: nextFavorited });
    if (nextFavorited) {
      ingestAgentEvent('article_favorited', { articleId }).catch(() => undefined);
    }
  }

  async function handleShare() {
    if (!data) return;
    const sharePayload = {
      title: data.article.title,
      text: `${data.article.title}\n${data.article.summary}`,
    };

    try {
      if (navigator.share) {
        await navigator.share(sharePayload);
        showSuccess(t('home.shareSuccess'));
        return;
      }

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(sharePayload.text);
        showSuccess(t('home.shareCopied'));
        return;
      }

      showError(t('home.shareNotSupported'));
    } catch {
      showInfo(t('home.shareCanceled'));
    }
  }

  function toggleSpeech() {
    if (!data) return;
    if (!('speechSynthesis' in window)) {
      showError(t('home.listenNotSupported'));
      return;
    }

    if (isSpeaking) {
      window.speechSynthesis.cancel();
      utteranceRef.current = null;
      setIsSpeaking(false);
      showInfo(t('home.listenStopped'));
      return;
    }

    const utterance = new SpeechSynthesisUtterance(`${data.article.title}. ${speakText}`);
    utterance.lang = i18n.resolvedLanguage ?? i18n.language;
    utterance.rate = 1;
    utterance.onend = () => {
      setIsSpeaking(false);
      utteranceRef.current = null;
    };
    utterance.onerror = () => {
      setIsSpeaking(false);
      utteranceRef.current = null;
      showError(t('home.listenFailed'));
    };

    utteranceRef.current = utterance;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setIsSpeaking(true);
    showSuccess(t('home.listenStarted'));
  }

  function handleOpenRelatedAsset(asset: RelatedAssetPill) {
    if (!asset.clickable || !asset.chain || !asset.contract || !onOpenToken) return;
    ingestAgentEvent('asset_viewed', {
      asset: asset.symbol,
      chain: asset.chain,
      contract: asset.contract,
      source: 'article_related',
    }).catch(() => undefined);
    onOpenToken(asset.chain, asset.contract, asset.tokenPreview ?? undefined);
  }

  return (
    <section className={`mx-auto flex min-h-screen w-full max-w-105 flex-col gap-4 p-5 py-8 ${hasRelatedPanel ? 'pb-36' : ''}`}>
      <button type="button" className="btn btn-ghost btn-sm h-12 min-h-0 w-8 p-0" onClick={onBack} aria-label={t('home.backToFeed')}>
        <ArrowLeft size={24} />
      </button>

      {isLoading && <p className="m-0 mt-2 text-base text-base-content/70">{t('home.loadingArticle')}</p>}

      {isError && (
        <p className="m-0 mt-2 text-base text-error">
          {t('home.loadArticleFailed', { message: (error as Error).message })}
        </p>
      )}

      {!isLoading && !isError && data && (
        <article className="bg-base-100">
          {/* <p className="m-0 text-xs uppercase tracking-wide text-base-content/50">
            {data.article.type === 'daily' ? t('home.dailyNewsTitle') : t('home.topicRecommendationsTitle')}
          </p> */}
          <h1 className="m-0 mt-2 text-2xl font-bold">{data.article.title}</h1>
          <p className="m-0 mt-2 text-sm text-base-content/60">
            {new Date(data.article.created_at).toLocaleString(i18n.language)}
          </p>

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <button
              type="button"
              className={`btn btn-sm h-9 min-h-0 gap-1.5 ${engagement.liked ? 'btn-primary' : 'btn-outline'}`}
              onClick={toggleLike}
            >
              <Heart size={16} />
              {engagement.liked ? t('home.actionLiked') : t('home.actionLike')}
            </button>
            <button
              type="button"
              className={`btn btn-sm h-9 min-h-0 gap-1.5 ${engagement.favorited ? 'btn-primary' : 'btn-outline'}`}
              onClick={toggleFavorite}
            >
              <Bookmark size={16} />
              {engagement.favorited ? t('home.actionFavorited') : t('home.actionFavorite')}
            </button>
            <button type="button" className="btn btn-outline btn-sm h-9 min-h-0 gap-1.5" onClick={handleShare}>
              <Share2 size={16} />
              {t('home.actionShare')}
            </button>
            <button type="button" className="btn btn-outline btn-sm h-9 min-h-0 gap-1.5" onClick={toggleSpeech}>
              {isSpeaking ? <Pause size={16} /> : <Play size={16} />}
              {isSpeaking ? t('home.actionStopListen') : t('home.actionListen')}
            </button>
          </div>

          <div className="mt-4">
            <MarkdownRenderer markdown={data.markdown} />
          </div>
        </article>
      )}

      {hasRelatedPanel && (
        <div className="fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-3">
          <section className="w-full max-w-105 rounded-2xl border border-base-300 bg-base-100/98 px-3 py-2 shadow-lg backdrop-blur">
            <p className="m-0 text-xs font-semibold uppercase tracking-wide text-base-content/60">{t('home.related')}</p>
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              {relatedPills.map((asset) => {
                const isUp = Number(asset.priceChangePct ?? 0) > 0;
                const isDown = Number(asset.priceChangePct ?? 0) < 0;
                const pctClass = isUp ? 'text-success' : isDown ? 'text-error' : 'text-base-content/60';
                return (
                  <button
                    key={asset.symbol}
                    type="button"
                    onClick={() => handleOpenRelatedAsset(asset)}
                    disabled={!asset.clickable}
                    className={`flex min-w-max items-center gap-2 rounded-full border px-3 py-1.5 text-left transition-colors ${
                      asset.clickable
                        ? 'border-base-300 bg-base-100 hover:border-primary hover:bg-base-200/70'
                        : 'border-base-300 bg-base-100/70 opacity-60'
                    }`}
                  >
                    <span className="text-sm font-medium text-base-content">{asset.name}</span>
                    <span className={`text-xs font-semibold ${pctClass}`}>{formatPct(asset.priceChangePct)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
