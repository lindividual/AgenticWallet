import { useMemo, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeft,
  Bot,
  Newspaper,
  RefreshCcw,
  Sparkles,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getAgentOpsOverview,
  regenerateAgentDailyDigest,
  runAgentDailyDigest,
  runAgentPortfolioSnapshot,
  runAgentRecommendations,
  type AgentArticle,
  type AgentOpsJob,
  type AgentOpsOverviewResponse,
} from '../../api';
import type { AuthState } from '../../hooks/useWalletApp';
import { useToast } from '../../contexts/ToastContext';
import { formatUsdAdaptive } from '../../utils/currency';

type AgentOpsScreenProps = {
  auth: AuthState;
  onBack: () => void;
  onOpenArticle: (articleId: string) => void;
};

type Copy = {
  title: string;
  subtitle: string;
  back: string;
  refresh: string;
  refreshing: string;
  live: string;
  generatedAt: string;
  quickActions: string;
  actionRunDaily: string;
  actionRegenerateDaily: string;
  actionRefreshRecommendations: string;
  actionCaptureSnapshot: string;
  actionQueued: string;
  actionAlreadyQueued: string;
  actionDone: string;
  llm: string;
  daily: string;
  recommendations: string;
  activity: string;
  jobs: string;
  outputs: string;
  signals: string;
  recentArticles: string;
  recentRecommendations: string;
  recentEvents: string;
  recentTransfers: string;
  watchlist: string;
  balance24h: string;
  latestSnapshot: string;
  latestDailySnapshot: string;
  nextJob: string;
  activeUntil: string;
  locale: string;
  preferredLocale: string;
  requestLocale: string;
  effectiveLocale: string;
  user: string;
  wallet: string;
  noData: string;
  openArticle: string;
  payloadEmpty: string;
  active: string;
  idle: string;
  enabled: string;
  disabled: string;
  dirty: string;
  clean: string;
  ready: string;
  generating: string;
  failed: string;
  stale: string;
  queued: string;
  running: string;
  succeeded: string;
  events: string;
  transfers: string;
  items: string;
  retries: string;
  status: string;
  runAt: string;
  updatedAt: string;
};

const COPY: Record<'en' | 'zh' | 'ar', Copy> = {
  en: {
    title: 'Agent Ops',
    subtitle: 'Monitor the agent pipeline, inspect recent outputs, and trigger recovery actions.',
    back: 'Back',
    refresh: 'Refresh',
    refreshing: 'Refreshing...',
    live: 'Live',
    generatedAt: 'Updated',
    quickActions: 'Quick Actions',
    actionRunDaily: 'Run daily digest',
    actionRegenerateDaily: 'Regenerate daily',
    actionRefreshRecommendations: 'Refresh recommendations',
    actionCaptureSnapshot: 'Capture portfolio snapshot',
    actionQueued: 'Task queued.',
    actionAlreadyQueued: 'Task already queued.',
    actionDone: 'Action completed.',
    llm: 'LLM',
    daily: 'Daily Digest',
    recommendations: 'Recommendations',
    activity: 'Activity Window',
    jobs: 'Recent Jobs',
    outputs: 'Work Outputs',
    signals: 'Signals',
    recentArticles: 'Recent Articles',
    recentRecommendations: 'Recent Recommendations',
    recentEvents: 'Recent Events',
    recentTransfers: 'Recent Transfers',
    watchlist: 'Watchlist',
    balance24h: '24h Balance Trace',
    latestSnapshot: 'Latest hourly snapshot',
    latestDailySnapshot: 'Latest daily snapshot',
    nextJob: 'Next queued job',
    activeUntil: 'Active until',
    locale: 'Locale',
    preferredLocale: 'Preferred',
    requestLocale: 'Request',
    effectiveLocale: 'Effective',
    user: 'User',
    wallet: 'Wallet',
    noData: 'No data yet.',
    openArticle: 'Open article',
    payloadEmpty: 'No payload',
    active: 'Active',
    idle: 'Idle',
    enabled: 'Enabled',
    disabled: 'Disabled',
    dirty: 'Dirty',
    clean: 'Clean',
    ready: 'Ready',
    generating: 'Generating',
    failed: 'Failed',
    stale: 'Stale',
    queued: 'Queued',
    running: 'Running',
    succeeded: 'Succeeded',
    events: 'events',
    transfers: 'transfers',
    items: 'items',
    retries: 'Retries',
    status: 'Status',
    runAt: 'Run at',
    updatedAt: 'Updated',
  },
  zh: {
    title: 'Agent 后台',
    subtitle: '集中查看 Agent 的任务状态、最近产出，并支持手动触发补跑。',
    back: '返回',
    refresh: '刷新',
    refreshing: '刷新中...',
    live: '实时',
    generatedAt: '更新时间',
    quickActions: '快捷操作',
    actionRunDaily: '生成今日日报',
    actionRegenerateDaily: '重建今日日报',
    actionRefreshRecommendations: '刷新推荐',
    actionCaptureSnapshot: '抓取资产快照',
    actionQueued: '任务已入队。',
    actionAlreadyQueued: '任务已在队列中。',
    actionDone: '操作已完成。',
    llm: 'LLM',
    daily: '日报状态',
    recommendations: '推荐状态',
    activity: '活跃窗口',
    jobs: '最近任务',
    outputs: '工作产出',
    signals: '输入信号',
    recentArticles: '最近文章',
    recentRecommendations: '最近推荐',
    recentEvents: '最近事件',
    recentTransfers: '最近转账',
    watchlist: '关注列表',
    balance24h: '24 小时余额轨迹',
    latestSnapshot: '最新小时快照',
    latestDailySnapshot: '最新日快照',
    nextJob: '下一条排队任务',
    activeUntil: '活跃到',
    locale: '语言上下文',
    preferredLocale: '用户偏好',
    requestLocale: '请求语言',
    effectiveLocale: '生效语言',
    user: '用户',
    wallet: '钱包',
    noData: '暂无数据。',
    openArticle: '打开文章',
    payloadEmpty: '无 payload',
    active: '活跃中',
    idle: '未活跃',
    enabled: '已启用',
    disabled: '未启用',
    dirty: '待刷新',
    clean: '已同步',
    ready: '已完成',
    generating: '生成中',
    failed: '失败',
    stale: '待补齐',
    queued: '排队中',
    running: '运行中',
    succeeded: '成功',
    events: '个事件',
    transfers: '笔转账',
    items: '项',
    retries: '重试次数',
    status: '状态',
    runAt: '计划时间',
    updatedAt: '更新时间',
  },
  ar: {
    title: 'لوحة الوكيل',
    subtitle: 'تابع حالة مهام الوكيل، وراجع المخرجات الأخيرة، وشغّل إجراءات التعافي يدويًا.',
    back: 'رجوع',
    refresh: 'تحديث',
    refreshing: 'جارٍ التحديث...',
    live: 'مباشر',
    generatedAt: 'آخر تحديث',
    quickActions: 'إجراءات سريعة',
    actionRunDaily: 'تشغيل الملخص اليومي',
    actionRegenerateDaily: 'إعادة إنشاء الملخص اليومي',
    actionRefreshRecommendations: 'تحديث التوصيات',
    actionCaptureSnapshot: 'التقاط لقطة للمحفظة',
    actionQueued: 'تمت إضافة المهمة إلى الطابور.',
    actionAlreadyQueued: 'المهمة موجودة بالفعل في الطابور.',
    actionDone: 'اكتمل الإجراء.',
    llm: 'النموذج',
    daily: 'الملخص اليومي',
    recommendations: 'التوصيات',
    activity: 'نافذة النشاط',
    jobs: 'الوظائف الأخيرة',
    outputs: 'مخرجات العمل',
    signals: 'الإشارات',
    recentArticles: 'المقالات الأخيرة',
    recentRecommendations: 'التوصيات الأخيرة',
    recentEvents: 'الأحداث الأخيرة',
    recentTransfers: 'التحويلات الأخيرة',
    watchlist: 'قائمة المراقبة',
    balance24h: 'مسار الرصيد خلال 24 ساعة',
    latestSnapshot: 'آخر لقطة ساعية',
    latestDailySnapshot: 'آخر لقطة يومية',
    nextJob: 'الوظيفة التالية في الطابور',
    activeUntil: 'نشط حتى',
    locale: 'اللغة',
    preferredLocale: 'المفضلة',
    requestLocale: 'لغة الطلب',
    effectiveLocale: 'الفعالة',
    user: 'المستخدم',
    wallet: 'المحفظة',
    noData: 'لا توجد بيانات بعد.',
    openArticle: 'فتح المقال',
    payloadEmpty: 'لا توجد حمولة',
    active: 'نشط',
    idle: 'خامل',
    enabled: 'مفعل',
    disabled: 'غير مفعل',
    dirty: 'بحاجة لتحديث',
    clean: 'متزامن',
    ready: 'جاهز',
    generating: 'جارٍ الإنشاء',
    failed: 'فشل',
    stale: 'قديم',
    queued: 'في الطابور',
    running: 'قيد التشغيل',
    succeeded: 'نجح',
    events: 'أحداث',
    transfers: 'تحويلات',
    items: 'عناصر',
    retries: 'إعادات المحاولة',
    status: 'الحالة',
    runAt: 'موعد التشغيل',
    updatedAt: 'آخر تحديث',
  },
};

function getCopy(language: string): Copy {
  const normalized = language.toLowerCase();
  if (normalized.startsWith('zh')) return COPY.zh;
  if (normalized.startsWith('ar')) return COPY.ar;
  return COPY.en;
}

function truncateMiddle(value: string | null | undefined, start = 6, end = 4): string {
  const normalized = (value ?? '').trim();
  if (!normalized) return '--';
  if (normalized.length <= start + end + 1) return normalized;
  return `${normalized.slice(0, start)}...${normalized.slice(-end)}`;
}

function formatDateTime(value: string | null | undefined, language: string): string {
  const normalized = (value ?? '').trim();
  if (!normalized) return '--';
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return normalized;
  return new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
}

function formatEventType(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function formatJobType(value: AgentOpsJob['type']): string {
  if (value === 'daily_digest') return 'Daily digest';
  if (value === 'portfolio_snapshot') return 'Portfolio snapshot';
  return value;
}

function formatJsonPreview(value: Record<string, unknown> | null, fallback: string): string {
  if (!value) return fallback;
  const text = JSON.stringify(value);
  if (!text) return fallback;
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function buildSparkline(points: AgentOpsOverviewResponse['portfolio']['points24h']): string {
  if (points.length === 0) return '';
  if (points.length === 1) return '0,18 100,18';
  const values = points.map((point) => point.total_usd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * 100;
      const y = 32 - ((point.total_usd - min) / range) * 28;
      return `${x},${y}`;
    })
    .join(' ');
}

function statusClasses(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'ready' || normalized === 'succeeded' || normalized === 'clean' || normalized === 'active') {
    return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  }
  if (normalized === 'running' || normalized === 'generating' || normalized === 'queued') {
    return 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300';
  }
  if (normalized === 'failed' || normalized === 'stale' || normalized === 'dirty' || normalized === 'idle') {
    return 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  }
  return 'border-base-300 bg-base-200 text-base-content/80';
}

function formatDailyStatus(status: AgentOpsOverviewResponse['daily']['status'], copy: Copy): string {
  if (status === 'ready') return copy.ready;
  if (status === 'generating') return copy.generating;
  if (status === 'failed') return copy.failed;
  return copy.stale;
}

function formatJobStatus(status: string, copy: Copy): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'queued') return copy.queued;
  if (normalized === 'running') return copy.running;
  if (normalized === 'succeeded') return copy.succeeded;
  if (normalized === 'failed') return copy.failed;
  return status;
}

function StatusChip({ label, tone }: { label: string; tone: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}

function MetricCard({
  icon,
  label,
  value,
  meta,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  meta?: string;
}) {
  return (
    <article className="rounded-[24px] border border-base-300/70 bg-gradient-to-br from-base-100 via-base-100 to-base-200/70 p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3 text-base-content/60">
        <span className="text-sm font-medium">{label}</span>
        <span className="flex size-9 items-center justify-center rounded-2xl bg-base-200 text-base-content/70">
          {icon}
        </span>
      </div>
      <p className="m-0 mt-4 text-2xl font-semibold tracking-tight">{value}</p>
      {meta ? <p className="m-0 mt-2 text-sm text-base-content/60">{meta}</p> : null}
    </article>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-base-300/70 bg-base-100/90 p-5 shadow-sm backdrop-blur">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-lg font-semibold tracking-tight">{title}</h2>
          {subtitle ? <p className="m-0 mt-1 text-sm text-base-content/60">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function AgentOpsScreen({ auth, onBack, onOpenArticle }: AgentOpsScreenProps) {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const copy = useMemo(() => getCopy(language), [language]);
  const queryClient = useQueryClient();
  const { showError, showSuccess } = useToast();

  const overviewQuery = useQuery({
    queryKey: ['agent-ops-overview'],
    queryFn: getAgentOpsOverview,
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  async function refreshOpsData() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['agent-ops-overview'] }),
      queryClient.invalidateQueries({ queryKey: ['home-agent-daily-today'] }),
      queryClient.invalidateQueries({ queryKey: ['home-agent-topic'] }),
    ]);
  }

  const runDailyMutation = useMutation({
    mutationFn: runAgentDailyDigest,
    onSuccess: async (result) => {
      showSuccess(result.deduped ? copy.actionAlreadyQueued : copy.actionQueued);
      await refreshOpsData();
    },
    onError: (error) => showError((error as Error).message),
  });

  const regenerateDailyMutation = useMutation({
    mutationFn: regenerateAgentDailyDigest,
    onSuccess: async () => {
      showSuccess(copy.actionDone);
      await refreshOpsData();
    },
    onError: (error) => showError((error as Error).message),
  });

  const refreshRecommendationMutation = useMutation({
    mutationFn: runAgentRecommendations,
    onSuccess: async () => {
      showSuccess(copy.actionDone);
      await refreshOpsData();
    },
    onError: (error) => showError((error as Error).message),
  });

  const captureSnapshotMutation = useMutation({
    mutationFn: runAgentPortfolioSnapshot,
    onSuccess: async (result) => {
      showSuccess(result.deduped ? copy.actionAlreadyQueued : copy.actionQueued);
      await refreshOpsData();
    },
    onError: (error) => showError((error as Error).message),
  });

  const overview = overviewQuery.data;
  const sparkline = overview ? buildSparkline(overview.portfolio.points24h) : '';
  const userName = auth.user.displayName || auth.user.handle;
  const walletAddress = auth.wallet?.address ?? auth.wallet?.chainAccounts?.[0]?.address ?? null;

  return (
    <section className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(15,118,110,0.12),transparent_28%),radial-gradient(circle_at_top_right,rgba(59,130,246,0.12),transparent_30%)]">
      <div className="mx-auto flex min-h-screen w-full max-w-[80rem] flex-col gap-5 p-5 pb-12">
        <header className="rounded-[30px] border border-base-300/70 bg-gradient-to-br from-base-100 via-base-100 to-base-200/80 p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-3">
              <button
                type="button"
                className="btn btn-ghost btn-sm gap-2 px-0"
                onClick={onBack}
              >
                <ArrowLeft size={16} />
                {copy.back}
              </button>
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <StatusChip label={copy.live} tone="border-base-300 bg-base-200 text-base-content/70" />
                  {overview ? (
                    <StatusChip
                      label={overview.activity.isActive ? copy.active : copy.idle}
                      tone={statusClasses(overview.activity.isActive ? 'active' : 'idle')}
                    />
                  ) : null}
                </div>
                <h1 className="m-0 text-3xl font-semibold tracking-tight">{copy.title}</h1>
                <p className="m-0 mt-2 max-w-2xl text-sm text-base-content/65">{copy.subtitle}</p>
              </div>
            </div>

            <div className="flex flex-col items-start gap-3 text-sm text-base-content/65 sm:items-end">
              <button
                type="button"
                className="btn btn-sm rounded-full border-base-300 bg-base-100"
                onClick={() => void overviewQuery.refetch()}
                disabled={overviewQuery.isFetching}
              >
                <RefreshCcw size={16} className={overviewQuery.isFetching ? 'animate-spin' : ''} />
                {overviewQuery.isFetching ? copy.refreshing : copy.refresh}
              </button>
              <div className="space-y-1">
                <p className="m-0">
                  <span className="text-base-content/50">{copy.user}: </span>
                  <span className="font-medium text-base-content">{userName}</span>
                </p>
                <p className="m-0">
                  <span className="text-base-content/50">{copy.wallet}: </span>
                  <span className="font-medium text-base-content">{truncateMiddle(walletAddress)}</span>
                </p>
                <p className="m-0">
                  <span className="text-base-content/50">{copy.generatedAt}: </span>
                  <span className="font-medium text-base-content">
                    {formatDateTime(overview?.generatedAt, language)}
                  </span>
                </p>
              </div>
            </div>
          </div>
        </header>

        {overviewQuery.isPending && !overview ? (
          <div className="grid gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="h-32 animate-pulse rounded-[24px] bg-base-200" />
            ))}
            <div className="h-72 animate-pulse rounded-[28px] bg-base-200 lg:col-span-2" />
            <div className="h-72 animate-pulse rounded-[28px] bg-base-200 lg:col-span-2" />
          </div>
        ) : overviewQuery.isError ? (
          <SectionCard title={copy.title} subtitle={(overviewQuery.error as Error).message}>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void overviewQuery.refetch()}>
              {copy.refresh}
            </button>
          </SectionCard>
        ) : overview ? (
          <>
            <div className="grid gap-4 lg:grid-cols-4">
              <MetricCard
                icon={<Bot size={18} />}
                label={copy.llm}
                value={overview.llm.enabled ? overview.llm.model : copy.disabled}
                meta={`${overview.llm.enabled ? copy.enabled : copy.disabled} · ${overview.llm.provider}`}
              />
              <MetricCard
                icon={<Newspaper size={18} />}
                label={copy.daily}
                value={formatDailyStatus(overview.daily.status, copy)}
                meta={overview.daily.article ? overview.daily.article.title : formatDateTime(overview.jobs.nextQueuedRunAt, language)}
              />
              <MetricCard
                icon={<Sparkles size={18} />}
                label={copy.recommendations}
                value={`${overview.recommendations.count}`}
                meta={`${overview.recommendations.dirty ? copy.dirty : copy.clean} · ${formatDateTime(
                  overview.recommendations.lastRefreshedAt,
                  language,
                )}`}
              />
              <MetricCard
                icon={<Activity size={18} />}
                label={copy.activity}
                value={`${overview.activity.eventCount} ${copy.events}`}
                meta={`${overview.activity.isActive ? copy.active : copy.idle} · ${formatDateTime(
                  overview.activity.activeUntil,
                  language,
                )}`}
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-[1.1fr_1.3fr]">
              <SectionCard title={copy.quickActions} subtitle={copy.nextJob} action={(
                <StatusChip
                  label={overview.jobs.nextQueuedRunAt ? formatDateTime(overview.jobs.nextQueuedRunAt, language) : '--'}
                  tone="border-base-300 bg-base-200 text-base-content/70"
                />
              )}>
                <div className="grid gap-3 md:grid-cols-2">
                  <button
                    type="button"
                    className="btn h-auto min-h-0 justify-start rounded-[22px] border border-base-300 bg-base-100 px-4 py-4 text-left"
                    onClick={() => runDailyMutation.mutate()}
                    disabled={runDailyMutation.isPending}
                  >
                    <div>
                      <p className="m-0 text-sm font-semibold">{copy.actionRunDaily}</p>
                      <p className="m-0 mt-1 text-xs text-base-content/60">{copy.daily}</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="btn h-auto min-h-0 justify-start rounded-[22px] border border-base-300 bg-base-100 px-4 py-4 text-left"
                    onClick={() => regenerateDailyMutation.mutate()}
                    disabled={regenerateDailyMutation.isPending}
                  >
                    <div>
                      <p className="m-0 text-sm font-semibold">{copy.actionRegenerateDaily}</p>
                      <p className="m-0 mt-1 text-xs text-base-content/60">{copy.outputs}</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="btn h-auto min-h-0 justify-start rounded-[22px] border border-base-300 bg-base-100 px-4 py-4 text-left"
                    onClick={() => refreshRecommendationMutation.mutate()}
                    disabled={refreshRecommendationMutation.isPending}
                  >
                    <div>
                      <p className="m-0 text-sm font-semibold">{copy.actionRefreshRecommendations}</p>
                      <p className="m-0 mt-1 text-xs text-base-content/60">{copy.recommendations}</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="btn h-auto min-h-0 justify-start rounded-[22px] border border-base-300 bg-base-100 px-4 py-4 text-left"
                    onClick={() => captureSnapshotMutation.mutate()}
                    disabled={captureSnapshotMutation.isPending}
                  >
                    <div>
                      <p className="m-0 text-sm font-semibold">{copy.actionCaptureSnapshot}</p>
                      <p className="m-0 mt-1 text-xs text-base-content/60">{copy.balance24h}</p>
                    </div>
                  </button>
                </div>
              </SectionCard>

              <SectionCard title={copy.locale} subtitle={copy.generatedAt}>
                <div className="grid gap-3 md:grid-cols-3">
                  <LocaleTile label={copy.preferredLocale} value={overview.locale.preferred} />
                  <LocaleTile label={copy.requestLocale} value={overview.locale.request} />
                  <LocaleTile label={copy.effectiveLocale} value={overview.locale.effective} />
                </div>
              </SectionCard>
            </div>

            <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
              <SectionCard
                title={copy.jobs}
                subtitle={`${overview.jobs.counts.queued} ${copy.queued} · ${overview.jobs.counts.running} ${copy.running} · ${overview.jobs.counts.failed} ${copy.failed}`}
              >
                {overview.jobs.recent.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="table table-sm">
                      <thead>
                        <tr className="text-xs uppercase text-base-content/50">
                          <th>{copy.status}</th>
                          <th>Job</th>
                          <th>{copy.runAt}</th>
                          <th>{copy.updatedAt}</th>
                          <th>{copy.retries}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.jobs.recent.map((job) => (
                          <tr key={job.id}>
                            <td className="align-top">
                              <StatusChip label={formatJobStatus(job.status, copy)} tone={statusClasses(job.status)} />
                            </td>
                            <td className="align-top">
                              <p className="m-0 font-medium">{formatJobType(job.type)}</p>
                              <p className="m-0 mt-1 text-xs text-base-content/55">
                                {job.jobKey ?? truncateMiddle(job.id, 8, 6)}
                              </p>
                              <p className="m-0 mt-2 text-xs text-base-content/60">
                                {formatJsonPreview(job.payload, copy.payloadEmpty)}
                              </p>
                            </td>
                            <td className="align-top text-sm text-base-content/70">{formatDateTime(job.runAt, language)}</td>
                            <td className="align-top text-sm text-base-content/70">{formatDateTime(job.updatedAt, language)}</td>
                            <td className="align-top text-sm text-base-content/70">{job.retryCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="m-0 text-sm text-base-content/60">{copy.noData}</p>
                )}
              </SectionCard>

              <SectionCard title={copy.balance24h} subtitle={copy.latestSnapshot}>
                <div className="space-y-4">
                  <div className="rounded-[22px] border border-base-300/70 bg-base-200/60 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="m-0 text-sm text-base-content/55">{copy.latestSnapshot}</p>
                        <p className="m-0 mt-2 text-2xl font-semibold">
                          {overview.portfolio.latestHourlySnapshot
                            ? formatUsdAdaptive(overview.portfolio.latestHourlySnapshot.totalUsd, language)
                            : '--'}
                        </p>
                      </div>
                      <div className="text-right text-sm text-base-content/60">
                        <p className="m-0">
                          {overview.portfolio.latestHourlySnapshot?.holdingsCount ?? 0} {copy.items}
                        </p>
                        <p className="m-0 mt-1">
                          {formatDateTime(overview.portfolio.latestHourlySnapshot?.asOf, language)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 overflow-hidden rounded-[20px] border border-base-300/60 bg-base-100/80 p-3">
                      {sparkline ? (
                        <svg viewBox="0 0 100 36" className="h-28 w-full" preserveAspectRatio="none" aria-hidden="true">
                          <defs>
                            <linearGradient id="agent-ops-sparkline" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
                              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                            </linearGradient>
                          </defs>
                          <polyline
                            points={`${sparkline} 100,36 0,36`}
                            fill="url(#agent-ops-sparkline)"
                            className="text-sky-500"
                          />
                          <polyline
                            points={sparkline}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="text-sky-500"
                          />
                        </svg>
                      ) : (
                        <p className="m-0 text-sm text-base-content/60">{copy.noData}</p>
                      )}
                    </div>
                  </div>
                  <div className="rounded-[22px] border border-base-300/70 bg-base-200/50 p-4 text-sm text-base-content/70">
                    <p className="m-0 text-base-content/55">{copy.latestDailySnapshot}</p>
                    <p className="m-0 mt-2 text-base font-medium text-base-content">
                      {overview.portfolio.latestDailySnapshot
                        ? formatUsdAdaptive(overview.portfolio.latestDailySnapshot.totalUsd, language)
                        : '--'}
                    </p>
                    <p className="m-0 mt-1">
                      {formatDateTime(overview.portfolio.latestDailySnapshot?.asOf, language)}
                    </p>
                  </div>
                </div>
              </SectionCard>
            </div>

            <div className="grid gap-4 xl:grid-cols-[1.15fr_1.05fr]">
              <SectionCard title={copy.outputs} subtitle={copy.recentArticles}>
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="space-y-3">
                    <h3 className="m-0 text-sm font-semibold uppercase tracking-[0.18em] text-base-content/50">
                      {copy.recentArticles}
                    </h3>
                    {overview.articles.items.length > 0 ? (
                      overview.articles.items.map((article) => (
                        <ArticleCard
                          key={article.id}
                          article={article}
                          copy={copy}
                          language={language}
                          onOpenArticle={onOpenArticle}
                        />
                      ))
                    ) : (
                      <p className="m-0 text-sm text-base-content/60">{copy.noData}</p>
                    )}
                  </div>

                  <div className="space-y-3">
                    <h3 className="m-0 text-sm font-semibold uppercase tracking-[0.18em] text-base-content/50">
                      {copy.recentRecommendations}
                    </h3>
                    {overview.recommendations.items.length > 0 ? (
                      overview.recommendations.items.map((item) => (
                        <article key={item.id} className="rounded-[22px] border border-base-300/70 bg-base-200/45 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="m-0 text-base font-semibold">{item.title}</p>
                              <p className="m-0 mt-1 text-xs uppercase tracking-[0.18em] text-base-content/45">
                                {item.kind}
                              </p>
                            </div>
                            <StatusChip
                              label={typeof item.score === 'number' ? item.score.toFixed(2) : '--'}
                              tone="border-base-300 bg-base-100 text-base-content/70"
                            />
                          </div>
                          <p className="m-0 mt-3 text-sm leading-6 text-base-content/72">{item.content}</p>
                          <p className="m-0 mt-3 text-xs text-base-content/55">
                            {item.asset?.symbol ?? '--'} · {formatDateTime(item.created_at, language)}
                          </p>
                        </article>
                      ))
                    ) : (
                      <p className="m-0 text-sm text-base-content/60">{copy.noData}</p>
                    )}
                  </div>
                </div>
              </SectionCard>

              <SectionCard title={copy.signals} subtitle={`${overview.watchlist.count} ${copy.items}`}>
                <div className="space-y-5">
                  <div>
                    <h3 className="m-0 text-sm font-semibold uppercase tracking-[0.18em] text-base-content/50">
                      {copy.recentEvents}
                    </h3>
                    <div className="mt-3 space-y-3">
                      {overview.activity.recentEvents.length > 0 ? (
                        overview.activity.recentEvents.map((event) => (
                          <article key={event.id} className="rounded-[20px] border border-base-300/60 bg-base-200/40 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <p className="m-0 text-sm font-medium">{formatEventType(event.type)}</p>
                              <p className="m-0 text-xs text-base-content/55">{formatDateTime(event.occurredAt, language)}</p>
                            </div>
                            <p className="m-0 mt-2 text-xs leading-5 text-base-content/60">
                              {formatJsonPreview(event.payload, copy.payloadEmpty)}
                            </p>
                          </article>
                        ))
                      ) : (
                        <p className="m-0 mt-3 text-sm text-base-content/60">{copy.noData}</p>
                      )}
                    </div>
                  </div>

                  <div>
                    <h3 className="m-0 text-sm font-semibold uppercase tracking-[0.18em] text-base-content/50">
                      {copy.watchlist}
                    </h3>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {overview.watchlist.items.length > 0 ? (
                        overview.watchlist.items.map((item) => (
                          <article key={item.id} className="rounded-[18px] border border-base-300/60 bg-base-200/35 px-3 py-2">
                            <p className="m-0 text-sm font-medium">{item.symbol}</p>
                            <p className="m-0 mt-1 text-xs text-base-content/55">
                              {item.watch_type} · {item.chain}
                            </p>
                          </article>
                        ))
                      ) : (
                        <p className="m-0 text-sm text-base-content/60">{copy.noData}</p>
                      )}
                    </div>
                  </div>

                  <div>
                    <h3 className="m-0 text-sm font-semibold uppercase tracking-[0.18em] text-base-content/50">
                      {copy.recentTransfers}
                    </h3>
                    <div className="mt-3 space-y-3">
                      {overview.transfers.items.length > 0 ? (
                        overview.transfers.items.map((transfer) => (
                          <article key={transfer.id} className="rounded-[20px] border border-base-300/60 bg-base-200/40 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <p className="m-0 text-sm font-medium">
                                {transfer.tokenSymbol ?? 'TOKEN'} · {transfer.amountInput}
                              </p>
                              <StatusChip label={formatJobStatus(transfer.status, copy)} tone={statusClasses(transfer.status)} />
                            </div>
                            <p className="m-0 mt-2 text-xs text-base-content/60">
                              {truncateMiddle(transfer.fromAddress)} → {truncateMiddle(transfer.toAddress)}
                            </p>
                            <p className="m-0 mt-1 text-xs text-base-content/55">{formatDateTime(transfer.updatedAt, language)}</p>
                          </article>
                        ))
                      ) : (
                        <p className="m-0 mt-3 text-sm text-base-content/60">{copy.noData}</p>
                      )}
                    </div>
                  </div>
                </div>
              </SectionCard>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

function LocaleTile({ label, value }: { label: string; value: string | null }) {
  return (
    <article className="rounded-[20px] border border-base-300/70 bg-base-200/40 p-4">
      <p className="m-0 text-xs uppercase tracking-[0.18em] text-base-content/45">{label}</p>
      <p className="m-0 mt-2 text-lg font-semibold">{value || '--'}</p>
    </article>
  );
}

function ArticleCard({
  article,
  copy,
  language,
  onOpenArticle,
}: {
  article: AgentArticle;
  copy: Copy;
  language: string;
  onOpenArticle: (articleId: string) => void;
}) {
  return (
    <article className="rounded-[22px] border border-base-300/70 bg-base-200/45 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="m-0 text-base font-semibold">{article.title}</p>
          <p className="m-0 mt-1 text-xs uppercase tracking-[0.18em] text-base-content/45">{article.type}</p>
        </div>
        <StatusChip label={article.status} tone={statusClasses(article.status)} />
      </div>
      <p className="m-0 mt-3 text-sm leading-6 text-base-content/72">{article.summary}</p>
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="m-0 text-xs text-base-content/55">{formatDateTime(article.created_at, language)}</p>
        <button type="button" className="btn btn-xs rounded-full" onClick={() => onOpenArticle(article.id)}>
          {copy.openArticle}
        </button>
      </div>
    </article>
  );
}
