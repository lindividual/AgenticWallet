import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bookmark, Heart, Pause, Play, Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAgentArticleDetail, ingestAgentEvent } from '../../api';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { useToast } from '../../contexts/ToastContext';

type ArticleReaderScreenProps = {
  articleId: string;
  onBack: () => void;
};

type ArticleEngagement = {
  liked: boolean;
  favorited: boolean;
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

export function ArticleReaderScreen({ articleId, onBack }: ArticleReaderScreenProps) {
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

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-4 p-5 py-8">
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
    </section>
  );
}
