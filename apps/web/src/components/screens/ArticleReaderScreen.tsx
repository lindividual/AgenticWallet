import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bookmark, Heart, Pause, Play, Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getAgentArticleDetail,
  ingestAgentEvent,
  type AgentArticleRelatedAsset,
  type TopMarketAsset,
} from '../../api';
import { buildChainAssetId } from '../../utils/assetIdentity';
import { markTopicArticleRead } from '../../utils/topicFeedCache';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { useToast } from '../../contexts/ToastContext';
import type { TradeMarketDetailType } from '../../utils/tradeMarketDetail';

type ArticleReaderScreenProps = {
  articleId: string;
  userId?: string;
  onBack: () => void;
  onOpenToken?: (chain: string, contract: string, tokenPreview?: TopMarketAsset) => void;
  onOpenMarketDetail?: (marketType: TradeMarketDetailType, itemId: string) => void;
};

type ArticleEngagement = {
  liked: boolean;
  favorited: boolean;
};

type RelatedAssetPill = {
  symbol: string;
  name: string;
  priceChangePct: number | null;
  marketType: 'spot' | 'perp' | 'prediction' | null;
  marketItemId: string | null;
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
  SOL: {
    chain: 'sol',
    contract: 'native',
    name: 'Solana',
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

function stripLeadingMarkdownH1(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const withoutLeadingHeading = normalized.replace(/^\uFEFF?(?:\s*\n)*#(?!#)[ \t]+[^\n]+(?:\n+|$)/, '');
  return withoutLeadingHeading.trimStart();
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

function normalizeRoutableTokenContract(chain: string, contract: string): string | null {
  const trimmed = contract.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  if (normalized === 'native') return 'native';
  if (chain === 'sol' || chain === 'tron') return trimmed;
  if (/^0x[a-f0-9]{40}$/.test(normalized)) return normalized;
  return null;
}

function toTokenPreview(asset: AgentArticleRelatedAsset, chain: string, contract: string): TopMarketAsset | null {
  const chainAssetId = buildChainAssetId(chain, contract);
  const assetId = asset.asset_id ?? chainAssetId;
  return {
    id: assetId,
    asset_id: assetId,
    chain_asset_id: chainAssetId,
    chain,
    contract,
    symbol: asset.symbol,
    name: asset.name,
    image: asset.image,
    current_price: null,
    market_cap_rank: null,
    market_cap: null,
    price_change_percentage_24h: asset.price_change_percentage_24h,
    turnover_24h: null,
    risk_level: null,
  };
}

export function ArticleReaderScreen({ articleId, userId, onBack, onOpenToken, onOpenMarketDetail }: ArticleReaderScreenProps) {
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
  const displayMarkdown = useMemo(() => (data ? stripLeadingMarkdownH1(data.markdown) : ''), [data]);
  const speakText = useMemo(() => stripMarkdown(displayMarkdown), [displayMarkdown]);

  const relatedPills = useMemo<RelatedAssetPill[]>(() => {
    if (!data || data.relatedAssets.length === 0) return [];

    return data.relatedAssets.map((asset) => {
      const symbol = normalizeSymbol(asset.symbol);
      const marketChain = asset.chain?.trim().toLowerCase() ?? '';
      const marketContract = asset.contract?.trim() ?? '';
      const normalizedRouteContract = normalizeRoutableTokenContract(marketChain, marketContract);
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
        marketType: asset.market_type,
        marketItemId: asset.market_item_id,
        name: asset.name?.trim() || fallbackRoute?.name || symbol,
        priceChangePct: asset.price_change_percentage_24h ?? null,
        chain: route?.chain ?? null,
        contract: route?.contract ?? null,
        clickable: asset.market_type === 'spot'
          ? Boolean(route?.chain && route?.contract && onOpenToken)
          : Boolean(asset.market_item_id && asset.market_type && onOpenMarketDetail),
        tokenPreview: route?.chain && route?.contract ? toTokenPreview(asset, route.chain, route.contract) : null,
      };
    });
  }, [data, onOpenMarketDetail, onOpenToken]);

  const hasRelatedPanel = relatedPills.length > 0;

  useEffect(() => {
    ingestAgentEvent('article_read', { articleId }).catch(() => undefined);
    if (userId) {
      void markTopicArticleRead(userId, articleId);
    }
  }, [articleId, userId]);

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
    if (!asset.clickable) return;
    if (asset.marketType === 'perp' || asset.marketType === 'prediction') {
      if (!asset.marketItemId || !onOpenMarketDetail) return;
      onOpenMarketDetail(asset.marketType, asset.marketItemId);
      return;
    }
    if (!asset.chain || !asset.contract || !onOpenToken) return;
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
            <MarkdownRenderer markdown={displayMarkdown} />
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
