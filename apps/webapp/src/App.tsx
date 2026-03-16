import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeft,
  Bot,
  BrainCircuit,
  KeyRound,
  LogOut,
  Newspaper,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
} from 'lucide-react';
import {
  clearAdminToken,
  enqueueTopicAgentRun,
  getAdminAgentPromptConfig,
  getAdminAgentSkills,
  getAdminToken,
  getAdminTopicAgentOverview,
  getAdminUserAgentArticleDetail,
  getAdminUserAgentDetail,
  getAdminUserAgents,
  runTopicAgentNow,
  saveAdminAgentSkills,
  saveAdminAgentPromptConfig,
  setAdminToken,
  validateAdminToken,
  type AdminUserAgentDetailResponse,
  type AdminUserAgentListItem,
  type AgentArticle,
  type AgentArticleDetailResponse,
  type AgentOpsJob,
  type AgentOpsOverviewResponse,
  type AgentPromptConfigResponse,
  type AgentPromptSkillResponse,
  type TopicAgentJob,
  type TopicAgentOverviewResponse,
} from './api';

type OpsView = 'useragent' | 'topic-agent';
type Notice = { type: 'success' | 'error'; message: string } | null;

function formatDateTime(value: string | null | undefined): string {
  const normalized = (value ?? '').trim();
  if (!normalized) return '--';
  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) return normalized;
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(time);
}

function formatUsd(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: Number(value) >= 1000 ? 0 : 2,
  }).format(Number(value));
}

function formatCompactNumber(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  const abs = Math.abs(numeric);
  if (abs >= 1_000_000_000) return `${(numeric / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}B`;
  if (abs >= 1_000_000) return `${(numeric / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(numeric / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return `${Math.round(numeric)}`;
}

function truncateMiddle(value: string | null | undefined, start = 6, end = 4): string {
  const normalized = (value ?? '').trim();
  if (!normalized) return '--';
  if (normalized.length <= start + end + 1) return normalized;
  return `${normalized.slice(0, start)}...${normalized.slice(-end)}`;
}

function formatStatus(status: string): string {
  switch (status) {
    case 'ready':
      return '已完成';
    case 'generating':
      return '生成中';
    case 'failed':
      return '失败';
    case 'stale':
      return '待补齐';
    case 'queued':
      return '排队中';
    case 'staged':
      return '已暂存';
    case 'running':
      return '运行中';
    case 'succeeded':
      return '成功';
    case 'created':
      return '已创建';
    case 'submitted':
      return '已提交';
    case 'confirmed':
      return '已确认';
    case 'unknown':
      return '未初始化';
    default:
      return status;
  }
}

function statusClass(status: string): string {
  if (['ready', 'succeeded', 'confirmed'].includes(status)) {
    return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  }
  if (['queued', 'staged', 'running', 'generating', 'submitted'].includes(status)) {
    return 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300';
  }
  if (['failed', 'stale', 'unknown'].includes(status)) {
    return 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  }
  return 'border-base-300 bg-base-200 text-base-content/80';
}

function formatJobType(value: AgentOpsJob['type']): string {
  if (value === 'daily_digest') return '日报生成';
  if (value === 'portfolio_snapshot') return '资产快照';
  return value;
}

function jsonPreview(value: unknown): string {
  if (value == null) return '无数据';
  if (typeof value === 'string') return value.length > 180 ? `${value.slice(0, 177)}...` : value;
  const text = JSON.stringify(value);
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

type TopicTaskPromptStats = {
  systemChars?: number;
  userChars?: number;
  totalChars?: number;
  systemEstimatedTokens?: number;
  userEstimatedTokens?: number;
  totalEstimatedTokens?: number;
};

type TopicTaskLlmCall = {
  mode?: string;
  fallbackReason?: string | null;
  requestId?: string | null;
  cfRay?: string | null;
  provider?: string | null;
  model?: string | null;
  promptStats?: TopicTaskPromptStats | null;
  systemPrompt?: string | null;
  userPrompt?: string | null;
  responseSnippet?: string | null;
  markdownSnippet?: string | null;
  error?: unknown;
};

type TopicTaskEditorDebug = TopicTaskLlmCall & {
  id?: string;
  label?: string;
  generatedDraftCount?: number;
};

type TopicTaskArticleDebug = {
  topic?: string;
  topicSlug?: string;
  editorId?: string;
  editorLabel?: string;
  relatedAssets?: string[];
  sourceRefs?: string[];
  llm?: TopicTaskLlmCall;
};

type TopicTaskDebug = {
  llm?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
    fallbackEnabled?: boolean;
    fallbackProvider?: string;
    fallbackModel?: string;
  };
  sources?: {
    sourceRefCount?: number;
    newsCount?: number;
    twitterCount?: number;
    rssHeadlineCount?: number;
    marketAssetCount?: number;
    memeHeatCount?: number;
    perpCount?: number;
    predictionCount?: number;
    existingTopicsTodayCount?: number;
  };
  draft?: TopicTaskLlmCall & {
    parsedDraftCount?: number;
  };
  editors?: Record<string, TopicTaskEditorDebug>;
  chief?: TopicTaskLlmCall & {
    selectedDraftCount?: number;
  };
  articles?: TopicTaskArticleDebug[];
};

type TopicTaskResult = {
  slotKey?: string;
  generated?: number;
  skipped?: boolean;
  totalInSlot?: number;
  debug?: TopicTaskDebug;
};

type UserAgentJobResult = {
  kind?: 'daily_digest' | 'portfolio_snapshot' | string;
  skipped?: boolean;
  dateKey?: string;
  articleId?: string | null;
  title?: string | null;
  summary?: string | null;
  reason?: string | null;
  walletAddress?: string | null;
  asOf?: string | null;
  totalUsd?: number | null;
  holdingsCount?: number | null;
  debug?: {
    llm?: TopicTaskDebug['llm'];
    sources?: {
      newsHeadlineCount?: number;
      userNewsCount?: number;
      marketNewsCount?: number;
      twitterCount?: number;
      marketAssetCount?: number;
      holdingsCount?: number;
      watchlistCount?: number;
    };
    userContext?: {
      preferredLocale?: string | null;
      outputLanguage?: string | null;
      contextStrength?: string | null;
      summary?: string | null;
      facts?: string[];
    };
    generation?: TopicTaskLlmCall;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeSkillSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

type SkillDraft = {
  slug: string;
  name: string;
  description: string;
  promptText: string;
  enabled: boolean;
  sortOrder: number;
};

type UserAgentConfigPage = 'home' | 'prompt-config' | 'skills';

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function readTopicTaskResult(value: unknown): TopicTaskResult | null {
  return isRecord(value) ? value as TopicTaskResult : null;
}

function readUserAgentJobResult(value: unknown): UserAgentJobResult | null {
  return isRecord(value) ? value as UserAgentJobResult : null;
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

function StatusChip({ label, status }: { label: string; status: string }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${statusClass(status)}`}>{label}</span>;
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
        <span className="flex size-9 items-center justify-center rounded-2xl bg-base-200 text-base-content/70">{icon}</span>
      </div>
      <p className="m-0 mt-4 text-2xl font-semibold tracking-tight">{value}</p>
      {meta ? <p className="m-0 mt-2 text-sm text-base-content/60">{meta}</p> : null}
    </article>
  );
}

function SectionCard({
  title,
  subtitle,
  action,
  children,
  bodyClassName,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
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
      <div className={`mt-5 ${bodyClassName ?? ''}`.trim()}>{children}</div>
    </section>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-[20px] border border-base-300/70 bg-base-200/40 p-4">
      <p className="m-0 text-xs uppercase tracking-[0.18em] text-base-content/45">{label}</p>
      <p className="m-0 mt-2 text-lg font-semibold">{value}</p>
    </article>
  );
}

function NoticeBanner({ notice }: { notice: Exclude<Notice, null> }) {
  const className = notice.type === 'error'
    ? 'border-error/30 bg-error/10 text-error'
    : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  return (
    <div className={`rounded-[20px] border px-4 py-3 text-sm ${className}`}>
      {notice.message}
    </div>
  );
}

function TabButton({
  active,
  label,
  description,
  onClick,
}: {
  active: boolean;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex min-w-[14rem] flex-col items-start rounded-[24px] border px-4 py-3 text-left transition ${
        active
          ? 'border-base-content/15 bg-base-content text-base-100'
          : 'border-base-300/80 bg-base-100/85 text-base-content hover:bg-base-200/80'
      }`}
      onClick={onClick}
    >
      <span className="text-sm font-semibold">{label}</span>
      <span className={`mt-1 text-xs ${active ? 'text-base-100/70' : 'text-base-content/60'}`}>{description}</span>
    </button>
  );
}

function SkeletonPanel() {
  return (
    <div className="grid gap-4 lg:grid-cols-4">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="h-32 animate-pulse rounded-[24px] bg-base-200" />
      ))}
      <div className="h-72 animate-pulse rounded-[28px] bg-base-200 lg:col-span-2" />
      <div className="h-72 animate-pulse rounded-[28px] bg-base-200 lg:col-span-2" />
    </div>
  );
}

function UserAgentListCard({
  item,
  selected,
  onClick,
}: {
  item: AdminUserAgentListItem;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`w-full rounded-[24px] border p-4 text-left transition ${
        selected
          ? 'border-base-content/15 bg-base-content text-base-100 shadow-sm'
          : 'border-base-300/70 bg-base-100/85 hover:bg-base-200/70'
      }`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="m-0 text-base font-semibold">{item.user.displayName || item.user.handle}</p>
          <p className={`m-0 mt-1 text-sm ${selected ? 'text-base-100/70' : 'text-base-content/55'}`}>@{item.user.handle}</p>
        </div>
        <StatusChip label={formatStatus(item.overview.daily.status)} status={item.overview.daily.status} />
      </div>
      <div className={`mt-4 grid gap-2 text-xs ${selected ? 'text-base-100/70' : 'text-base-content/60'}`}>
        <p className="m-0">钱包: {truncateMiddle(item.walletAddress)}</p>
        <p className="m-0">最近登录: {formatDateTime(item.user.lastLoginAt)}</p>
        <p className="m-0">活跃事件: {item.overview.activity.eventCount}</p>
        <p className="m-0">任务: {item.overview.jobs.counts.queued} 排队 / {item.overview.jobs.counts.running} 运行</p>
      </div>
      <p className={`m-0 mt-4 text-sm leading-6 ${selected ? 'text-base-100/80' : 'text-base-content/72'}`}>
        {item.overview.daily.articleTitle ?? item.overview.articles.latestTitle ?? '暂无内容产出'}
      </p>
    </button>
  );
}

function AppHeader({
  currentView,
  onChangeView,
  onRefresh,
  refreshing,
  onLogout,
}: {
  currentView: OpsView;
  onChangeView: (view: OpsView) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onLogout: () => void;
}) {
  return (
    <header className="rounded-[32px] border border-base-300/70 bg-[radial-gradient(circle_at_top_left,rgba(15,118,110,0.15),transparent_28%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.12),transparent_24%),linear-gradient(135deg,rgba(255,255,255,0.96),rgba(246,244,238,0.92))] p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-3 flex items-center gap-2">
            <span className="inline-flex rounded-full border border-base-300 bg-base-100 px-2.5 py-1 text-xs font-medium text-base-content/70">
              Admin Token
            </span>
            <span className="inline-flex rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700">
              Multi-Agent Ops
            </span>
          </div>
          <h1 className="m-0 text-3xl font-semibold tracking-tight">Agent Ops Console</h1>
          <p className="m-0 mt-2 max-w-3xl text-sm leading-6 text-base-content/65">
            同一个后台里切换 `useragent` 与 `topic agent`。前者看不同用户的 agent 运行状态，后者看内容生产流水线里的任务阶段与最近产出。
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-sm rounded-full border-base-300 bg-base-100"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCcw size={16} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? '刷新中...' : '刷新'}
          </button>
          <button type="button" className="btn btn-sm rounded-full border-base-300 bg-base-100" onClick={onLogout}>
            <LogOut size={16} />
            退出
          </button>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <TabButton
          active={currentView === 'useragent'}
          label="User Agent"
          description="查看不同用户的 agent 状态与内容产出"
          onClick={() => onChangeView('useragent')}
        />
        <TabButton
          active={currentView === 'topic-agent'}
          label="Topic Agent"
          description="查看选题、暂存、生成等阶段任务"
          onClick={() => onChangeView('topic-agent')}
        />
      </div>
    </header>
  );
}

function UserAgentPanel({
  users,
  total,
  openedUserId,
  onOpenUser,
  onCloseUser,
  userDetailQuery,
  articleQuery,
  selectedArticle,
  onOpenArticle,
  onCloseArticle,
  searchInput,
  onSearchInput,
  promptConfigQuery,
  savePromptConfig,
  skillsQuery,
  saveSkills,
}: {
  users: AdminUserAgentListItem[];
  total: number;
  openedUserId: string | null;
  onOpenUser: (userId: string) => void;
  onCloseUser: () => void;
  userDetailQuery: {
    data: AdminUserAgentDetailResponse | undefined;
    isPending: boolean;
    isFetching: boolean;
    isError: boolean;
    error: unknown;
  };
  articleQuery: {
    data: AgentArticleDetailResponse | undefined;
    isPending: boolean;
    isError: boolean;
    error: unknown;
  };
  selectedArticle: { userId: string; articleId: string } | null;
  onOpenArticle: (userId: string, articleId: string) => void;
  onCloseArticle: () => void;
  searchInput: string;
  onSearchInput: (value: string) => void;
  promptConfigQuery: {
    data: AgentPromptConfigResponse | undefined;
    isPending: boolean;
    isFetching: boolean;
    isError: boolean;
    error: unknown;
  };
  savePromptConfig: {
    isPending: boolean;
    mutate: (input: { basePromptText: string }) => void;
  };
  skillsQuery: {
    data: { skills: AgentPromptSkillResponse[] } | undefined;
    isPending: boolean;
    isFetching: boolean;
    isError: boolean;
    error: unknown;
  };
  saveSkills: {
    isPending: boolean;
    mutate: (input: {
      skills: Array<{
        slug: string;
        name: string;
        description: string;
        promptText: string;
        enabled: boolean;
        sortOrder: number;
      }>;
    }) => void;
  };
}) {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [configPage, setConfigPage] = useState<UserAgentConfigPage>('home');
  const [promptText, setPromptText] = useState('');
  const [skillDrafts, setSkillDrafts] = useState<SkillDraft[]>([]);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const detail = userDetailQuery.data;
  const overview = detail?.overview;
  const sparkline = useMemo(
    () => (overview ? buildSparkline(overview.portfolio.points24h) : ''),
    [overview],
  );
  const selectedJob = overview?.jobs.recent.find((job) => job.id === selectedJobId) ?? null;

  useEffect(() => {
    if (!promptConfigQuery.data) return;
    setPromptText(promptConfigQuery.data.basePromptText);
  }, [promptConfigQuery.data]);

  useEffect(() => {
    if (!skillsQuery.data) return;
    setSkillDrafts(
      skillsQuery.data.skills.map((skill, index) => ({
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        promptText: skill.promptText,
        enabled: skill.enabled,
        sortOrder: skill.sortOrder ?? index,
      })),
    );
    setSelectedSkillIndex(0);
  }, [skillsQuery.data]);

  const hasPromptChanges = promptConfigQuery.data != null
    && promptText !== promptConfigQuery.data.basePromptText;
  const persistedSkills = skillsQuery.data?.skills ?? [];
  const hasSkillChanges = JSON.stringify(
    skillDrafts.map((skill, index) => ({
      slug: normalizeSkillSlug(skill.slug),
      name: skill.name.trim(),
      description: skill.description.trim(),
      promptText: skill.promptText,
      enabled: skill.enabled,
      sortOrder: index,
    })),
  ) !== JSON.stringify(
    persistedSkills.map((skill, index) => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      promptText: skill.promptText,
      enabled: skill.enabled,
      sortOrder: skill.sortOrder ?? index,
    })),
  );
  const selectedSkill = skillDrafts[selectedSkillIndex] ?? null;

  function updateSelectedSkill(patch: Partial<SkillDraft>) {
    setSkillDrafts((current) => current.map((skill, index) => (
      index === selectedSkillIndex ? { ...skill, ...patch } : skill
    )));
  }

  function resetSkillsToServer() {
    setSkillDrafts(
      persistedSkills.map((skill, index) => ({
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        promptText: skill.promptText,
        enabled: skill.enabled,
        sortOrder: skill.sortOrder ?? index,
      })),
    );
    setSelectedSkillIndex(0);
  }

  if (openedUserId == null) {
    if (configPage === 'prompt-config') {
      return (
        <SectionCard
          title="Base Prompt"
          subtitle="编辑 Agent 的全局 base prompt。留空时会回退到代码里的默认 prompt。"
          action={(
            <button type="button" className="btn btn-sm rounded-full" onClick={() => setConfigPage('home')}>
              <ArrowLeft size={16} />
              返回
            </button>
          )}
        >
          <div className="space-y-4">
            <div className="rounded-[20px] border border-base-300/60 bg-base-200/40 p-4 text-sm leading-6 text-base-content/65">
              <p className="m-0">当前更新时间: {formatDateTime(promptConfigQuery.data?.updatedAt)}</p>
              <p className="m-0 mt-2">这里维护的是聊天系统提示的 base prompt。留空时，Agent 会回退到代码里的默认主提示。</p>
            </div>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-base-content/70">Base prompt</span>
              <textarea
                value={promptText}
                onChange={(event) => setPromptText(event.target.value)}
                placeholder="在这里填写 Agent 的 base prompt..."
                className="textarea textarea-bordered min-h-72 w-full rounded-[20px] bg-base-100 leading-6"
              />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="m-0 text-sm text-base-content/55">
                {promptConfigQuery.isError
                  ? `加载失败: ${(promptConfigQuery.error as Error).message}`
                  : promptConfigQuery.isPending
                    ? '正在加载当前配置...'
                    : `${promptText.length} / 20000 字符`}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn btn-sm rounded-full"
                  onClick={() => setPromptText(promptConfigQuery.data?.basePromptText ?? '')}
                  disabled={promptConfigQuery.isPending || savePromptConfig.isPending}
                >
                  还原
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm rounded-full"
                  onClick={() => savePromptConfig.mutate({ basePromptText: promptText })}
                  disabled={!hasPromptChanges || savePromptConfig.isPending || promptText.length > 20_000}
                >
                  {savePromptConfig.isPending ? '保存中...' : '保存 Base Prompt'}
                </button>
              </div>
            </div>
          </div>
        </SectionCard>
      );
    }

    if (configPage === 'skills') {
      return (
        <SectionCard
          title="Agent Skills"
          subtitle="管理不同的 skill prompt。启用中的 skill 会在聊天时注入 system prompt。"
          action={(
            <button type="button" className="btn btn-sm rounded-full" onClick={() => setConfigPage('home')}>
              <ArrowLeft size={16} />
              返回
            </button>
          )}
        >
          <div className="grid gap-4 xl:grid-cols-[20rem_1fr]">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="m-0 text-sm font-medium text-base-content/70">Skills</p>
                <button
                  type="button"
                  className="btn btn-sm rounded-full"
                  onClick={() => {
                    setSkillDrafts((current) => [
                      ...current,
                      {
                        slug: '',
                        name: `New Skill ${current.length + 1}`,
                        description: '',
                        promptText: '',
                        enabled: true,
                        sortOrder: current.length,
                      },
                    ]);
                    setSelectedSkillIndex(skillDrafts.length);
                  }}
                >
                  新增 Skill
                </button>
              </div>
              <div className="space-y-2">
                {skillDrafts.length > 0 ? skillDrafts.map((skill, index) => (
                  <button
                    key={`${skill.slug || 'draft'}-${index}`}
                    type="button"
                    className={`w-full rounded-[20px] border p-3 text-left transition ${
                      index === selectedSkillIndex
                        ? 'border-base-content/15 bg-base-content text-base-100'
                        : 'border-base-300/70 bg-base-100/85 hover:bg-base-200/70'
                    }`}
                    onClick={() => setSelectedSkillIndex(index)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="m-0 text-sm font-semibold">{skill.name || 'Untitled Skill'}</p>
                        <p className={`m-0 mt-1 text-xs ${index === selectedSkillIndex ? 'text-base-100/70' : 'text-base-content/55'}`}>
                          {normalizeSkillSlug(skill.slug || skill.name) || 'missing_slug'}
                        </p>
                      </div>
                      <span className={`rounded-full border px-2 py-1 text-xs ${skill.enabled
                        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700'
                        : 'border-base-300 bg-base-100 text-base-content/60'}`}>
                        {skill.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </div>
                  </button>
                )) : (
                  <div className="rounded-[20px] border border-base-300/70 bg-base-100/85 p-4 text-sm text-base-content/60">
                    还没有 skill，可以先新增一个。
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-[24px] border border-base-300/70 bg-base-200/30 p-4">
              {selectedSkill ? (
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="m-0 text-base font-semibold">Skill Editor</p>
                      <p className="m-0 mt-1 text-sm text-base-content/60">建议用清晰的名称、触发场景和可执行 prompt。</p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm rounded-full"
                      onClick={() => {
                        setSkillDrafts((current) => current.filter((_, index) => index !== selectedSkillIndex));
                        setSelectedSkillIndex((current) => Math.max(0, current - 1));
                      }}
                    >
                      删除
                    </button>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="block">
                      <span className="mb-2 block text-sm font-medium text-base-content/70">Name</span>
                      <input
                        value={selectedSkill.name}
                        onChange={(event) => updateSelectedSkill({ name: event.target.value })}
                        className="input input-bordered w-full rounded-[18px]"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-sm font-medium text-base-content/70">Slug</span>
                      <input
                        value={selectedSkill.slug}
                        onChange={(event) => updateSelectedSkill({ slug: normalizeSkillSlug(event.target.value) })}
                        className="input input-bordered w-full rounded-[18px]"
                        placeholder="receive_address_help"
                      />
                    </label>
                  </div>

                  <label className="block">
                    <span className="mb-2 block text-sm font-medium text-base-content/70">When to use</span>
                    <textarea
                      value={selectedSkill.description}
                      onChange={(event) => updateSelectedSkill({ description: event.target.value })}
                      className="textarea textarea-bordered min-h-24 w-full rounded-[18px]"
                      placeholder="例如：用户询问收款地址、网络兼容性、跨链地址规则时"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-sm font-medium text-base-content/70">Skill prompt</span>
                    <textarea
                      value={selectedSkill.promptText}
                      onChange={(event) => updateSelectedSkill({ promptText: event.target.value })}
                      className="textarea textarea-bordered min-h-64 w-full rounded-[18px]"
                      placeholder="写这个 skill 的详细 prompt..."
                    />
                  </label>

                  <label className="inline-flex items-center gap-3 rounded-[18px] border border-base-300/70 bg-base-100 px-4 py-3">
                    <input
                      type="checkbox"
                      className="toggle toggle-sm"
                      checked={selectedSkill.enabled}
                      onChange={(event) => updateSelectedSkill({ enabled: event.target.checked })}
                    />
                    <span className="text-sm text-base-content/70">启用这个 skill</span>
                  </label>
                </div>
              ) : (
                <div className="flex min-h-48 items-center justify-center rounded-[20px] border border-dashed border-base-300/70 bg-base-100/80 text-sm text-base-content/60">
                  选择一个 skill，或者先新增一个。
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="m-0 text-sm text-base-content/55">
              {skillsQuery.isError
                ? `加载失败: ${(skillsQuery.error as Error).message}`
                : skillsQuery.isPending
                  ? '正在加载当前 skills...'
                  : `${skillDrafts.length} 个 skill`}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-sm rounded-full"
                onClick={resetSkillsToServer}
                disabled={skillsQuery.isPending || saveSkills.isPending}
              >
                还原
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm rounded-full"
                onClick={() => saveSkills.mutate({
                  skills: skillDrafts.map((skill, index) => ({
                    slug: normalizeSkillSlug(skill.slug || skill.name),
                    name: skill.name.trim(),
                    description: skill.description.trim(),
                    promptText: skill.promptText,
                    enabled: skill.enabled,
                    sortOrder: index,
                  })),
                })}
                disabled={
                  !hasSkillChanges
                  || saveSkills.isPending
                  || skillDrafts.some((skill) => !normalizeSkillSlug(skill.slug || skill.name) || !skill.name.trim() || skill.promptText.length > 20_000)
                }
              >
                {saveSkills.isPending ? '保存中...' : '保存 Skills'}
              </button>
            </div>
          </div>
        </SectionCard>
      );
    }

    return (
      <>
        <SectionCard
          title="Agent Configuration"
          subtitle="进入二级页面后再编辑 base prompt 或 skills。"
        >
          <div className="grid gap-4 md:grid-cols-2">
            <button
              type="button"
              className="rounded-[24px] border border-base-300/70 bg-base-100/90 p-5 text-left transition hover:bg-base-200/80"
              onClick={() => setConfigPage('prompt-config')}
            >
              <div className="flex items-center gap-3">
                <div className="flex size-11 items-center justify-center rounded-2xl bg-base-200 text-base-content/70">
                  <Bot size={20} />
                </div>
                <div>
                  <p className="m-0 text-base font-semibold">Agent Prompt Config</p>
                  <p className="m-0 mt-1 text-sm text-base-content/60">查看和编辑 base prompt</p>
                </div>
              </div>
              <p className="m-0 mt-4 text-sm leading-6 text-base-content/65">
                当前更新时间: {formatDateTime(promptConfigQuery.data?.updatedAt)}
              </p>
            </button>

            <button
              type="button"
              className="rounded-[24px] border border-base-300/70 bg-base-100/90 p-5 text-left transition hover:bg-base-200/80"
              onClick={() => setConfigPage('skills')}
            >
              <div className="flex items-center gap-3">
                <div className="flex size-11 items-center justify-center rounded-2xl bg-base-200 text-base-content/70">
                  <BrainCircuit size={20} />
                </div>
                <div>
                  <p className="m-0 text-base font-semibold">Agent Skills</p>
                  <p className="m-0 mt-1 text-sm text-base-content/60">管理不同 skill 和 prompt</p>
                </div>
              </div>
              <p className="m-0 mt-4 text-sm leading-6 text-base-content/65">
                当前共 {skillDrafts.length} 个 skill
              </p>
            </button>
          </div>
        </SectionCard>

        <SectionCard
          title="User Agents"
          subtitle={`匹配 ${total} 个用户，选择一个进入详情页`}
          action={(
            <label className="flex items-center gap-2 rounded-full border border-base-300 bg-base-100 px-3 py-2 text-sm">
              <Users size={16} className="text-base-content/55" />
              <input
                value={searchInput}
                onChange={(event) => onSearchInput(event.target.value)}
                placeholder="搜索 handle 或用户名"
                className="w-40 bg-transparent outline-none placeholder:text-base-content/35"
              />
            </label>
          )}
        >
          {users.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {users.map((item) => (
                <UserAgentListCard
                  key={item.user.id}
                  item={item}
                  selected={false}
                  onClick={() => onOpenUser(item.user.id)}
                />
              ))}
            </div>
          ) : (
            <p className="m-0 text-sm text-base-content/60">没有匹配的 user agent。</p>
          )}
        </SectionCard>

        {selectedArticle ? (
          <ArticleModal
            articleQuery={articleQuery}
            onClose={onCloseArticle}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      {userDetailQuery.isPending && !detail ? (
        <SkeletonPanel />
      ) : userDetailQuery.isError ? (
        <SectionCard
          title="用户视图加载失败"
          subtitle={(userDetailQuery.error as Error).message}
          action={(
            <button type="button" className="btn btn-sm rounded-full" onClick={onCloseUser}>
              <ArrowLeft size={16} />
              返回列表
            </button>
          )}
        >
          <p className="m-0 text-sm text-base-content/60">可以返回列表换一个用户，或重新刷新后台。</p>
        </SectionCard>
      ) : detail && overview ? (
        <div className="space-y-4">
          <SectionCard
            title="User Agent Detail"
            subtitle="二级详情页"
            action={(
              <button type="button" className="btn btn-sm rounded-full" onClick={onCloseUser}>
                <ArrowLeft size={16} />
                返回列表
              </button>
            )}
          >
            <SectionCard
              title={detail.user.displayName || detail.user.handle}
              subtitle={`@${detail.user.handle} · 创建于 ${formatDateTime(detail.user.createdAt)}`}
              action={(
                <div className="space-y-1 text-right text-sm text-base-content/60">
                  <p className="m-0">最近登录: {formatDateTime(detail.user.lastLoginAt)}</p>
                  <p className="m-0">钱包: {truncateMiddle(detail.wallet?.address ?? detail.wallet?.chainAccounts?.[0]?.address)}</p>
                </div>
              )}
            >
              <div className="grid gap-4 lg:grid-cols-4">
                <MetricCard
                  icon={<Newspaper size={18} />}
                  label="日报"
                  value={formatStatus(overview.daily.status)}
                  meta={overview.daily.article?.title ?? overview.daily.lastReadyArticle?.title ?? '--'}
                />
                <MetricCard
                  icon={<Sparkles size={18} />}
                  label="推荐"
                  value={`${overview.recommendations.count} 条`}
                  meta={overview.recommendations.dirty ? '等待刷新' : '状态已同步'}
                />
                <MetricCard
                  icon={<Activity size={18} />}
                  label="活跃窗口"
                  value={`${overview.activity.eventCount} 个事件`}
                  meta={overview.activity.isActive ? `到 ${formatDateTime(overview.activity.activeUntil)}` : '当前未活跃'}
                />
                <MetricCard
                  icon={<Bot size={18} />}
                  label="LLM"
                  value={overview.llm.enabled ? overview.llm.model : '未启用'}
                  meta={`${overview.llm.provider} · ${overview.llm.enabled ? '可用' : '未配置'}`}
                />
              </div>
            </SectionCard>
          </SectionCard>

          <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
            <SectionCard
              title="任务与快照"
              subtitle={`${overview.jobs.counts.queued} 排队中 · ${overview.jobs.counts.running} 运行中 · ${overview.jobs.counts.failed} 失败`}
              bodyClassName="max-h-[36rem] overflow-y-auto pr-1"
            >
              <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                <div className="max-h-[31rem] overflow-auto">
                  <table className="table table-sm">
                    <thead>
                      <tr className="text-xs uppercase text-base-content/50">
                        <th>状态</th>
                        <th>任务</th>
                        <th>计划时间</th>
                        <th>更新时间</th>
                        <th>详情</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.jobs.recent.map((job) => (
                        <tr key={job.id}>
                          <td className="align-top">
                            <StatusChip label={formatStatus(job.status)} status={job.status} />
                          </td>
                          <td className="align-top">
                            <p className="m-0 font-medium">{formatJobType(job.type)}</p>
                            <p className="m-0 mt-1 text-xs text-base-content/55">{job.jobKey ?? truncateMiddle(job.id, 8, 6)}</p>
                            <p className="m-0 mt-2 text-xs text-base-content/60">{jsonPreview(job.payload)}</p>
                          </td>
                          <td className="align-top text-sm text-base-content/70">{formatDateTime(job.runAt)}</td>
                          <td className="align-top text-sm text-base-content/70">{formatDateTime(job.updatedAt)}</td>
                          <td className="align-top">
                            <button type="button" className="btn btn-xs rounded-full" onClick={() => setSelectedJobId(job.id)}>
                              查看任务
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="space-y-4">
                  <div className="rounded-[22px] border border-base-300/70 bg-base-200/60 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="m-0 text-sm text-base-content/55">最新小时快照</p>
                        <p className="m-0 mt-2 text-2xl font-semibold">
                          {overview.portfolio.latestHourlySnapshot ? formatUsd(overview.portfolio.latestHourlySnapshot.totalUsd) : '--'}
                        </p>
                      </div>
                      <div className="text-right text-sm text-base-content/60">
                        <p className="m-0">{overview.portfolio.latestHourlySnapshot?.holdingsCount ?? 0} 项资产</p>
                        <p className="m-0 mt-1">{formatDateTime(overview.portfolio.latestHourlySnapshot?.asOf)}</p>
                      </div>
                    </div>
                    <div className="mt-4 overflow-hidden rounded-[20px] border border-base-300/60 bg-base-100/80 p-3">
                      {sparkline ? (
                        <svg viewBox="0 0 100 36" className="h-28 w-full" preserveAspectRatio="none" aria-hidden="true">
                          <defs>
                            <linearGradient id="useragent-sparkline" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
                              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                            </linearGradient>
                          </defs>
                          <polyline points={`${sparkline} 100,36 0,36`} fill="url(#useragent-sparkline)" className="text-sky-500" />
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
                        <p className="m-0 text-sm text-base-content/60">暂无曲线。</p>
                      )}
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <MiniStat label="用户偏好" value={overview.locale.preferred || '--'} />
                    <MiniStat label="请求语言" value={overview.locale.request || '--'} />
                    <MiniStat label="生效语言" value={overview.locale.effective || '--'} />
                  </div>
                </div>
              </div>
            </SectionCard>

            <SectionCard title="内容产出" subtitle="最近文章与推荐" bodyClassName="max-h-[36rem] overflow-y-auto pr-1">
              <div className="grid gap-4 xl:grid-cols-2">
                <div className="max-h-[31rem] space-y-3 overflow-y-auto pr-1">
                  <h3 className="m-0 text-sm font-semibold uppercase tracking-[0.18em] text-base-content/50">文章</h3>
                  {overview.articles.items.length > 0 ? (
                    overview.articles.items.map((article) => (
                      <OutputCard
                        key={article.id}
                        article={article}
                        onOpen={() => onOpenArticle(detail.user.id, article.id)}
                      />
                    ))
                  ) : (
                    <p className="m-0 text-sm text-base-content/60">暂无文章。</p>
                  )}
                </div>

                <div className="max-h-[31rem] space-y-3 overflow-y-auto pr-1">
                  <h3 className="m-0 text-sm font-semibold uppercase tracking-[0.18em] text-base-content/50">推荐</h3>
                  {overview.recommendations.items.length > 0 ? (
                    overview.recommendations.items.map((item) => (
                      <article key={item.id} className="rounded-[22px] border border-base-300/70 bg-base-200/45 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="m-0 text-base font-semibold">{item.title}</p>
                            <p className="m-0 mt-1 text-xs uppercase tracking-[0.18em] text-base-content/45">{item.kind}</p>
                          </div>
                          <span className="inline-flex rounded-full border border-base-300 bg-base-100 px-2.5 py-1 text-xs font-medium text-base-content/70">
                            {typeof item.score === 'number' ? item.score.toFixed(2) : '--'}
                          </span>
                        </div>
                        <p className="m-0 mt-3 text-sm leading-6 text-base-content/72">{item.content}</p>
                        <p className="m-0 mt-3 text-xs text-base-content/55">
                          {item.asset?.symbol ?? '--'} · {formatDateTime(item.created_at)}
                        </p>
                      </article>
                    ))
                  ) : (
                    <p className="m-0 text-sm text-base-content/60">暂无推荐。</p>
                  )}
                </div>
              </div>
            </SectionCard>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
            <SectionCard title="输入信号" subtitle={`${overview.watchlist.count} 项 watchlist`} bodyClassName="max-h-[34rem] overflow-y-auto pr-1">
              <div className="space-y-5">
                <div>
                  <h3 className="m-0 text-sm font-semibold uppercase tracking-[0.18em] text-base-content/50">最近事件</h3>
                  <div className="mt-3 max-h-[14rem] space-y-3 overflow-y-auto pr-1">
                    {overview.activity.recentEvents.length > 0 ? (
                      overview.activity.recentEvents.map((event) => (
                        <article key={event.id} className="rounded-[20px] border border-base-300/60 bg-base-200/40 p-3">
                          <div className="flex items-center justify-between gap-3">
                            <p className="m-0 text-sm font-medium">{event.type}</p>
                            <p className="m-0 text-xs text-base-content/55">{formatDateTime(event.occurredAt)}</p>
                          </div>
                          <p className="m-0 mt-2 text-xs leading-5 text-base-content/60">{jsonPreview(event.payload)}</p>
                        </article>
                      ))
                    ) : (
                      <p className="m-0 mt-3 text-sm text-base-content/60">暂无事件。</p>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="m-0 text-sm font-semibold uppercase tracking-[0.18em] text-base-content/50">Watchlist</h3>
                  <div className="mt-3 grid max-h-[12rem] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                    {overview.watchlist.items.length > 0 ? (
                      overview.watchlist.items.map((item) => (
                        <article key={item.id} className="rounded-[18px] border border-base-300/60 bg-base-200/35 px-3 py-2">
                          <p className="m-0 text-sm font-medium">{item.symbol}</p>
                          <p className="m-0 mt-1 text-xs text-base-content/55">{item.watch_type} · {item.chain}</p>
                        </article>
                      ))
                    ) : (
                      <p className="m-0 text-sm text-base-content/60">暂无 watchlist。</p>
                    )}
                  </div>
                </div>
              </div>
            </SectionCard>

            <SectionCard title="最近转账" subtitle={`${overview.transfers.count} 条记录`} bodyClassName="max-h-[34rem] overflow-y-auto pr-1">
              <div className="max-h-[29rem] space-y-3 overflow-y-auto pr-1">
                {overview.transfers.items.length > 0 ? (
                  overview.transfers.items.map((transfer) => (
                    <article key={transfer.id} className="rounded-[20px] border border-base-300/60 bg-base-200/40 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="m-0 text-sm font-medium">{transfer.tokenSymbol ?? 'TOKEN'} · {transfer.amountInput}</p>
                        <StatusChip label={formatStatus(transfer.status)} status={transfer.status} />
                      </div>
                      <p className="m-0 mt-2 text-xs text-base-content/60">
                        {truncateMiddle(transfer.fromAddress)} → {truncateMiddle(transfer.toAddress)}
                      </p>
                      <p className="m-0 mt-1 text-xs text-base-content/55">{formatDateTime(transfer.updatedAt)}</p>
                    </article>
                  ))
                ) : (
                  <p className="m-0 text-sm text-base-content/60">暂无转账记录。</p>
                )}
              </div>
            </SectionCard>
          </div>
        </div>
      ) : (
        <SectionCard
          title="用户不存在"
          subtitle="这个 user agent 详情暂时不可用"
          action={(
            <button type="button" className="btn btn-sm rounded-full" onClick={onCloseUser}>
              <ArrowLeft size={16} />
              返回列表
            </button>
          )}
        >
          <p className="m-0 text-sm text-base-content/60">可以返回列表重新选择一个用户。</p>
        </SectionCard>
      )}

      {selectedArticle ? (
        <ArticleModal
          articleQuery={articleQuery}
          onClose={onCloseArticle}
        />
      ) : null}
      {selectedJob ? <UserAgentJobModal job={selectedJob} onClose={() => setSelectedJobId(null)} /> : null}
    </>
  );
}

function TopicAgentPanel({
  query,
  enqueueMutation,
  runNowMutation,
}: {
  query: {
    data: TopicAgentOverviewResponse | undefined;
    isPending: boolean;
    isFetching: boolean;
    isError: boolean;
    error: unknown;
  };
  enqueueMutation: {
    isPending: boolean;
    mutate: () => void;
  };
  runNowMutation: {
    isPending: boolean;
    mutate: () => void;
  };
}) {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  if (query.isPending && !query.data) {
    return <SkeletonPanel />;
  }

  if (query.isError) {
    return (
      <SectionCard title="Topic Agent 加载失败" subtitle={(query.error as Error).message}>
        <p className="m-0 text-sm text-base-content/60">请检查管理员 token 或稍后重试。</p>
      </SectionCard>
    );
  }

  const overview = query.data;
  if (!overview) return null;
  const selectedJob = overview.recentJobs.find((job) => job.id === selectedJobId) ?? null;

  return (
    <>
      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-4">
          <MetricCard icon={<Workflow size={18} />} label="排队任务" value={String(overview.counts.queued)} meta="等待进入 collect 阶段" />
          <MetricCard icon={<ShieldCheck size={18} />} label="已暂存" value={String(overview.counts.staged)} meta="已完成 collect，等待 generate" />
          <MetricCard icon={<Activity size={18} />} label="运行中" value={String(overview.counts.running)} meta="当前正在生成文章" />
          <MetricCard icon={<Newspaper size={18} />} label="最近文章" value={String(overview.recentArticles.length)} meta={`更新时间 ${formatDateTime(overview.generatedAt)}`} />
        </div>

        <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
          <SectionCard
            title="控制面板"
            subtitle="面向全局 topic agent 的调度操作"
            action={overview.activeSlotKeys.length > 0 ? (
              <div className="flex flex-wrap justify-end gap-2">
                {overview.activeSlotKeys.map((slotKey) => (
                  <span key={slotKey} className="rounded-full border border-base-300 bg-base-100 px-3 py-1 text-xs">
                    {slotKey}
                  </span>
                ))}
              </div>
            ) : undefined}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <ActionButton
                title="入队新批次"
                subtitle="执行 collect -> persist packet -> generate"
                pending={enqueueMutation.isPending}
                onClick={() => enqueueMutation.mutate()}
              />
              <ActionButton
                title="立即执行"
                subtitle="直接跑当前 slot 的生成批次"
                pending={runNowMutation.isPending}
                onClick={() => runNowMutation.mutate()}
              />
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-3">
              <MiniStat label="成功" value={String(overview.counts.succeeded)} />
              <MiniStat label="失败" value={String(overview.counts.failed)} />
              <MiniStat label="活跃 Slot" value={overview.activeSlotKeys.length > 0 ? overview.activeSlotKeys.join(', ') : '--'} />
            </div>
          </SectionCard>

          <SectionCard title="最近产出" subtitle="topic specials 文章" bodyClassName="h-[36rem] overflow-y-auto pr-1">
            <div className="flex flex-col gap-3">
              {overview.recentArticles.length > 0 ? (
                overview.recentArticles.map((article) => (
                  <article key={article.id} className="rounded-[22px] border border-base-300/70 bg-base-200/45 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="m-0 text-base font-semibold">{article.title}</p>
                        <p className="m-0 mt-1 text-xs uppercase tracking-[0.18em] text-base-content/45">{article.slotKey}</p>
                      </div>
                      <StatusChip label={article.status} status={article.status} />
                    </div>
                    <p className="m-0 mt-3 text-sm leading-6 text-base-content/72">{article.summary}</p>
                    <p className="m-0 mt-3 text-xs text-base-content/55">{formatDateTime(article.generatedAt)}</p>
                  </article>
                ))
              ) : (
                <p className="m-0 text-sm text-base-content/60">暂无 topic articles。</p>
              )}
            </div>
          </SectionCard>
        </div>

        <SectionCard title="任务流水线" subtitle="点开单个任务，查看各阶段 LLM 输入输出">
          {overview.recentJobs.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr className="text-xs uppercase text-base-content/50">
                    <th>状态</th>
                    <th>Slot</th>
                    <th>触发</th>
                    <th>时间</th>
                    <th>阶段数据</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recentJobs.map((job) => (
                    <tr key={job.id}>
                      <td className="align-top">
                        <StatusChip label={formatStatus(job.status)} status={job.status} />
                      </td>
                      <td className="align-top">
                        <p className="m-0 font-medium">{job.slotKey}</p>
                        <p className="m-0 mt-1 text-xs text-base-content/55">{job.force ? 'force run' : 'normal run'}</p>
                      </td>
                      <td className="align-top text-sm text-base-content/70">
                        <p className="m-0">{job.trigger}</p>
                        <p className="m-0 mt-1 text-xs text-base-content/55">重试 {job.retryCount}</p>
                      </td>
                      <td className="align-top text-sm text-base-content/70">
                        <p className="m-0">计划: {formatDateTime(job.runAt)}</p>
                        <p className="m-0 mt-1">更新: {formatDateTime(job.updatedAt)}</p>
                        <p className="m-0 mt-1 text-xs text-base-content/55">
                          {job.completedAt ? `完成 ${formatDateTime(job.completedAt)}` : job.startedAt ? `开始 ${formatDateTime(job.startedAt)}` : '等待执行'}
                        </p>
                      </td>
                      <td className="align-top">
                        <p className="m-0 text-xs leading-5 text-base-content/65">{jsonPreview(job.result)}</p>
                        {job.errorMessage ? <p className="m-0 mt-2 text-xs text-error">{job.errorMessage}</p> : null}
                        <button type="button" className="btn btn-xs mt-3 rounded-full" onClick={() => setSelectedJobId(job.id)}>
                          查看调用
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="m-0 text-sm text-base-content/60">暂无 topic agent 任务。</p>
          )}
        </SectionCard>
      </div>

      {selectedJob ? <TopicJobModal job={selectedJob} onClose={() => setSelectedJobId(null)} /> : null}
    </>
  );
}

function OutputCard({
  article,
  onOpen,
}: {
  article: AgentArticle;
  onOpen: () => void;
}) {
  return (
    <article className="rounded-[22px] border border-base-300/70 bg-base-200/45 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="m-0 text-base font-semibold">{article.title}</p>
          <p className="m-0 mt-1 text-xs uppercase tracking-[0.18em] text-base-content/45">{article.type}</p>
        </div>
        <StatusChip label={article.status} status={article.status} />
      </div>
      <p className="m-0 mt-3 text-sm leading-6 text-base-content/72">{article.summary}</p>
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="m-0 text-xs text-base-content/55">{formatDateTime(article.created_at)}</p>
        <button type="button" className="btn btn-xs rounded-full" onClick={onOpen}>
          查看全文
        </button>
      </div>
    </article>
  );
}

function ActionButton({
  title,
  subtitle,
  pending,
  onClick,
}: {
  title: string;
  subtitle: string;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="btn h-auto min-h-0 justify-start rounded-[22px] border border-base-300 bg-base-100 px-4 py-4 text-left"
      disabled={pending}
      onClick={onClick}
    >
      <div>
        <p className="m-0 text-sm font-semibold">{pending ? '处理中...' : title}</p>
        <p className="m-0 mt-1 text-xs text-base-content/60">{subtitle}</p>
      </div>
    </button>
  );
}

function ArticleModal({
  articleQuery,
  onClose,
}: {
  articleQuery: {
    data: AgentArticleDetailResponse | undefined;
    isPending: boolean;
    isError: boolean;
    error: unknown;
  };
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4 backdrop-blur-sm">
      <div className="mx-auto flex h-full max-w-5xl flex-col overflow-hidden rounded-[30px] border border-base-300 bg-base-100 shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-base-300 px-5 py-4">
          <div>
            <p className="m-0 text-sm text-base-content/55">文章详情</p>
            <h2 className="m-0 mt-1 text-xl font-semibold">{articleQuery.data?.article.title ?? '加载中...'}</h2>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-5">
          {articleQuery.isPending ? (
            <div className="h-48 animate-pulse rounded-[24px] bg-base-200" />
          ) : articleQuery.isError ? (
            <p className="m-0 text-sm text-error">{(articleQuery.error as Error).message}</p>
          ) : articleQuery.data ? (
            <div className="grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
              <article className="rounded-[24px] border border-base-300/70 bg-base-200/35 p-5">
                <pre className="m-0 whitespace-pre-wrap break-words font-sans text-sm leading-7 text-base-content/80">
                  {articleQuery.data.markdown}
                </pre>
              </article>
              <aside className="space-y-4">
                <article className="rounded-[24px] border border-base-300/70 bg-base-200/35 p-4">
                  <p className="m-0 text-sm text-base-content/55">摘要</p>
                  <p className="m-0 mt-2 text-sm leading-6 text-base-content/80">{articleQuery.data.article.summary}</p>
                </article>
                <article className="rounded-[24px] border border-base-300/70 bg-base-200/35 p-4">
                  <p className="m-0 text-sm text-base-content/55">相关资产</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {articleQuery.data.relatedAssets.length > 0 ? (
                      articleQuery.data.relatedAssets.map((asset) => (
                        <span key={`${asset.symbol}-${asset.contract ?? asset.market_item_id ?? asset.name}`} className="rounded-full border border-base-300 bg-base-100 px-3 py-1 text-xs">
                          {asset.symbol}
                        </span>
                      ))
                    ) : (
                      <span className="text-sm text-base-content/60">暂无</span>
                    )}
                  </div>
                </article>
              </aside>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function UserAgentJobModal({
  job,
  onClose,
}: {
  job: AgentOpsJob;
  onClose: () => void;
}) {
  const result = readUserAgentJobResult(job.result);
  const debug = result?.debug;

  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4 backdrop-blur-sm">
      <div className="mx-auto flex h-full max-w-6xl flex-col overflow-hidden rounded-[30px] border border-base-300 bg-base-100 shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-base-300 px-5 py-4">
          <div>
            <p className="m-0 text-sm text-base-content/55">任务详情</p>
            <h2 className="m-0 mt-1 text-xl font-semibold">{formatJobType(job.type)}</h2>
            <p className="m-0 mt-2 text-sm text-base-content/60">
              {formatStatus(job.status)} · {job.jobKey ?? truncateMiddle(job.id, 8, 6)}
            </p>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="grid flex-1 gap-4 overflow-hidden px-5 py-5 xl:grid-cols-[0.72fr_1.28fr]">
          <aside className="space-y-4 overflow-y-auto pr-1">
            <article className="rounded-[24px] border border-base-300/70 bg-base-200/35 p-4">
              <p className="m-0 text-sm text-base-content/55">任务概览</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <MiniStat label="计划时间" value={formatDateTime(job.runAt)} />
                <MiniStat label="更新时间" value={formatDateTime(job.updatedAt)} />
                <MiniStat label="任务类型" value={formatJobType(job.type)} />
                <MiniStat label="状态" value={formatStatus(job.status)} />
              </div>
              <pre className="mt-4 max-h-[12rem] overflow-auto whitespace-pre-wrap break-words rounded-[18px] bg-base-100/80 p-3 text-xs leading-6 text-base-content/70">
                {stringifyJson(job.payload)}
              </pre>
            </article>

            <article className="rounded-[24px] border border-base-300/70 bg-base-200/35 p-4">
              <p className="m-0 text-sm text-base-content/55">执行结果</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <MiniStat label="Kind" value={result?.kind ?? '--'} />
                <MiniStat label="Skipped" value={result?.skipped ? '是' : '否'} />
                {result?.kind === 'portfolio_snapshot' ? (
                  <>
                    <MiniStat label="快照金额" value={result.totalUsd != null ? formatUsd(result.totalUsd) : '--'} />
                    <MiniStat label="持仓数" value={result.holdingsCount != null ? String(result.holdingsCount) : '--'} />
                  </>
                ) : (
                  <>
                    <MiniStat label="文章" value={result?.title ?? '--'} />
                    <MiniStat label="日期" value={result?.dateKey ?? '--'} />
                  </>
                )}
              </div>
              <pre className="mt-4 max-h-[14rem] overflow-auto whitespace-pre-wrap break-words rounded-[18px] bg-base-100/80 p-3 text-xs leading-6 text-base-content/70">
                {stringifyJson(job.result)}
              </pre>
            </article>
          </aside>

          <section className="space-y-4 overflow-y-auto pr-1">
            {result?.kind === 'daily_digest' ? (
              <>
                <article className="rounded-[24px] border border-base-300/70 bg-base-200/35 p-4">
                  <p className="m-0 text-base font-semibold">{result.title ?? 'Daily Digest'}</p>
                  <p className="m-0 mt-2 text-sm leading-6 text-base-content/70">{result.summary ?? '暂无摘要'}</p>
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <MiniStat label="Locale" value={debug?.userContext?.preferredLocale ?? '--'} />
                    <MiniStat label="Output" value={debug?.userContext?.outputLanguage ?? '--'} />
                    <MiniStat label="Context" value={debug?.userContext?.contextStrength ?? '--'} />
                  </div>
                </article>

                <article className="rounded-[24px] border border-base-300/70 bg-base-200/35 p-4">
                  <p className="m-0 text-sm text-base-content/55">上下文来源</p>
                  <div className="mt-3 grid gap-3 md:grid-cols-3">
                    <MiniStat label="User News" value={String(debug?.sources?.userNewsCount ?? '--')} />
                    <MiniStat label="Market News" value={String(debug?.sources?.marketNewsCount ?? '--')} />
                    <MiniStat label="Twitter" value={String(debug?.sources?.twitterCount ?? '--')} />
                    <MiniStat label="Assets" value={String(debug?.sources?.marketAssetCount ?? '--')} />
                    <MiniStat label="Holdings" value={String(debug?.sources?.holdingsCount ?? '--')} />
                    <MiniStat label="Watchlist" value={String(debug?.sources?.watchlistCount ?? '--')} />
                  </div>
                  {debug?.userContext?.summary ? <p className="m-0 mt-4 text-sm leading-6 text-base-content/70">{debug.userContext.summary}</p> : null}
                  {readStringArray(debug?.userContext?.facts).length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {readStringArray(debug?.userContext?.facts).map((fact) => (
                        <span key={fact} className="rounded-full border border-base-300 bg-base-100 px-2.5 py-1 text-xs text-base-content/70">
                          {fact}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </article>

                <TopicLlmCallCard
                  title="Daily Digest LLM"
                  subtitle={result.skipped ? '本次没有重新生成内容' : '查看日报生成时的 prompt 与输出'}
                  call={debug?.generation}
                />
              </>
            ) : result?.kind === 'portfolio_snapshot' ? (
              <article className="rounded-[24px] border border-base-300/70 bg-base-200/35 p-4">
                <p className="m-0 text-base font-semibold">Portfolio Snapshot</p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <MiniStat label="Wallet" value={truncateMiddle(result.walletAddress)} />
                  <MiniStat label="As Of" value={formatDateTime(result.asOf)} />
                  <MiniStat label="Total USD" value={result.totalUsd != null ? formatUsd(result.totalUsd) : '--'} />
                  <MiniStat label="Holdings" value={result.holdingsCount != null ? String(result.holdingsCount) : '--'} />
                </div>
                {result.reason ? <p className="m-0 mt-4 text-sm text-base-content/65">跳过原因: {result.reason}</p> : null}
                <p className="m-0 mt-4 text-sm text-base-content/60">这个任务不调用 LLM，所以这里展示的是执行摘要而不是 prompt/response。</p>
              </article>
            ) : (
              <article className="rounded-[24px] border border-dashed border-base-300/80 bg-base-200/25 p-5">
                <p className="m-0 text-sm text-base-content/60">这个任务还没有可结构化展示的调试信息，当前先保留原始结果。</p>
              </article>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function TopicJobModal({
  job,
  onClose,
}: {
  job: TopicAgentJob;
  onClose: () => void;
}) {
  const result = readTopicTaskResult(job.result);
  const debug = isRecord(result?.debug) ? result.debug as TopicTaskDebug : null;
  const editors = debug?.editors ? Object.values(debug.editors) : [];
  const articles = Array.isArray(debug?.articles) ? debug?.articles : [];

  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-4 backdrop-blur-sm">
      <div className="mx-auto flex h-full max-w-7xl flex-col overflow-hidden rounded-[30px] border border-base-300 bg-base-100 shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-base-300 px-5 py-4">
          <div>
            <p className="m-0 text-sm text-base-content/55">任务详情</p>
            <h2 className="m-0 mt-1 text-xl font-semibold">{job.slotKey}</h2>
            <p className="m-0 mt-2 text-sm text-base-content/60">
              {job.trigger} · {formatStatus(job.status)} · {job.force ? 'force run' : 'normal run'}
            </p>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="grid flex-1 gap-4 overflow-hidden px-5 py-5 xl:grid-cols-[0.72fr_1.28fr]">
          <aside className="space-y-4 overflow-y-auto pr-1">
            <article className="rounded-[24px] border border-base-300/70 bg-base-200/35 p-4">
              <p className="m-0 text-sm text-base-content/55">任务概览</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <MiniStat label="计划时间" value={formatDateTime(job.runAt)} />
                <MiniStat label="更新时间" value={formatDateTime(job.updatedAt)} />
                <MiniStat label="生成篇数" value={String(result?.generated ?? 0)} />
                <MiniStat label="Slot 总数" value={String(result?.totalInSlot ?? '--')} />
              </div>
              {job.errorMessage ? <p className="m-0 mt-4 text-sm text-error">{job.errorMessage}</p> : null}
            </article>

            <article className="rounded-[24px] border border-base-300/70 bg-base-200/35 p-4">
              <p className="m-0 text-sm text-base-content/55">LLM 环境</p>
              <div className="mt-3 space-y-2 text-sm text-base-content/75">
                <p className="m-0">启用: {debug?.llm?.enabled ? '是' : '否'}</p>
                <p className="m-0">主模型: {debug?.llm?.provider ?? '--'} / {debug?.llm?.model ?? '--'}</p>
                <p className="m-0">回退模型: {debug?.llm?.fallbackEnabled ? `${debug?.llm?.fallbackProvider ?? '--'} / ${debug?.llm?.fallbackModel ?? '--'}` : '未启用'}</p>
              </div>
            </article>

            <article className="rounded-[24px] border border-base-300/70 bg-base-200/35 p-4">
              <p className="m-0 text-sm text-base-content/55">源数据规模</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <MiniStat label="Source Refs" value={String(debug?.sources?.sourceRefCount ?? '--')} />
                <MiniStat label="News" value={String(debug?.sources?.newsCount ?? '--')} />
                <MiniStat label="Twitter" value={String(debug?.sources?.twitterCount ?? '--')} />
                <MiniStat label="RSS" value={String(debug?.sources?.rssHeadlineCount ?? '--')} />
                <MiniStat label="Perps" value={String(debug?.sources?.perpCount ?? '--')} />
                <MiniStat label="Predictions" value={String(debug?.sources?.predictionCount ?? '--')} />
              </div>
            </article>

            <article className="rounded-[24px] border border-base-300/70 bg-base-200/35 p-4">
              <p className="m-0 text-sm text-base-content/55">原始结果</p>
              <pre className="mt-3 max-h-[20rem] overflow-auto whitespace-pre-wrap break-words rounded-[18px] bg-base-100/80 p-3 text-xs leading-6 text-base-content/70">
                {stringifyJson(job.result)}
              </pre>
            </article>
          </aside>

          <section className="space-y-4 overflow-y-auto pr-1">
            <TopicLlmCallCard
              title="Draft 汇总"
              subtitle={`解析草稿 ${debug?.draft?.parsedDraftCount ?? 0} 条`}
              call={debug?.draft}
            />

            {editors.length > 0 ? (
              <div className="grid gap-4 xl:grid-cols-2">
                {editors.map((editor, index) => (
                  <TopicLlmCallCard
                    key={editor.id ?? editor.label ?? `editor-${index}`}
                    title={editor.label ?? editor.id ?? 'Editor'}
                    subtitle={`候选草稿 ${editor.generatedDraftCount ?? 0} 条`}
                    call={editor}
                  />
                ))}
              </div>
            ) : null}

            <TopicLlmCallCard
              title="Chief Editor"
              subtitle={`最终选中 ${debug?.chief?.selectedDraftCount ?? 0} 条`}
              call={debug?.chief}
            />

            {articles.length > 0 ? (
              <div className="space-y-4">
                {articles.map((article, index) => (
                  <TopicLlmCallCard
                    key={article.topicSlug ?? `${article.topic}-${index}`}
                    title={article.topic ?? `Article ${index + 1}`}
                    subtitle={`${article.editorLabel ?? article.editorId ?? 'Editor'} · ${readStringArray(article.relatedAssets).join(', ') || '无相关资产'}`}
                    call={article.llm}
                    footer={(
                      <div className="grid gap-3 lg:grid-cols-2">
                        <div className="rounded-[18px] border border-base-300/60 bg-base-100/85 p-3">
                          <p className="m-0 text-xs uppercase tracking-[0.16em] text-base-content/45">Source Refs</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {readStringArray(article.sourceRefs).length > 0 ? (
                              readStringArray(article.sourceRefs).map((ref) => (
                                <span key={ref} className="rounded-full border border-base-300 bg-base-100 px-2.5 py-1 text-xs text-base-content/70">
                                  {ref}
                                </span>
                              ))
                            ) : (
                              <span className="text-xs text-base-content/55">无 source refs</span>
                            )}
                          </div>
                        </div>
                        {article.llm?.markdownSnippet ? (
                          <div className="rounded-[18px] border border-base-300/60 bg-base-100/85 p-3">
                            <p className="m-0 text-xs uppercase tracking-[0.16em] text-base-content/45">Markdown 片段</p>
                            <pre className="mt-2 max-h-[12rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-base-content/75">
                              {article.llm.markdownSnippet}
                            </pre>
                          </div>
                        ) : null}
                      </div>
                    )}
                  />
                ))}
              </div>
            ) : (
              <article className="rounded-[24px] border border-dashed border-base-300/80 bg-base-200/25 p-5">
                <p className="m-0 text-sm text-base-content/60">这个任务还没有可展示的 article LLM 调用信息。</p>
              </article>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function TopicLlmCallCard({
  title,
  subtitle,
  call,
  footer,
}: {
  title: string;
  subtitle?: string;
  call?: TopicTaskLlmCall | null;
  footer?: ReactNode;
}) {
  const promptStats = call?.promptStats;

  return (
    <article className="rounded-[24px] border border-base-300/70 bg-base-200/35 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="m-0 text-base font-semibold">{title}</p>
          {subtitle ? <p className="m-0 mt-1 text-sm text-base-content/60">{subtitle}</p> : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <StatusChip label={call?.mode === 'llm' ? 'LLM' : 'Fallback'} status={call?.mode === 'llm' ? 'succeeded' : 'failed'} />
          {call?.fallbackReason ? <span className="rounded-full border border-base-300 bg-base-100 px-2.5 py-1 text-xs text-base-content/70">{call.fallbackReason}</span> : null}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MiniStat label="Provider" value={call?.provider || '--'} />
        <MiniStat label="Model" value={call?.model || '--'} />
        <MiniStat label="Request ID" value={truncateMiddle(call?.requestId, 6, 4)} />
        <MiniStat label="Prompt Tokens" value={promptStats?.totalEstimatedTokens != null ? formatCompactNumber(promptStats.totalEstimatedTokens) : '--'} />
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-3">
        <TopicTextBlock label="System Prompt" content={call?.systemPrompt} />
        <TopicTextBlock label="User Prompt" content={call?.userPrompt} />
        <TopicTextBlock label="LLM Output" content={call?.responseSnippet} />
      </div>

      {call?.error ? (
        <div className="mt-4 rounded-[18px] border border-error/20 bg-error/8 p-3">
          <p className="m-0 text-xs uppercase tracking-[0.16em] text-error/80">Error</p>
          <pre className="mt-2 max-h-[10rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-error/85">
            {stringifyJson(call.error)}
          </pre>
        </div>
      ) : null}

      {footer ? <div className="mt-4">{footer}</div> : null}
    </article>
  );
}

function TopicTextBlock({
  label,
  content,
}: {
  label: string;
  content?: string | null;
}) {
  return (
    <div className="rounded-[18px] border border-base-300/60 bg-base-100/85 p-3">
      <p className="m-0 text-xs uppercase tracking-[0.16em] text-base-content/45">{label}</p>
      <pre className="mt-2 max-h-[16rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-base-content/75">
        {content?.trim() || '无'}
      </pre>
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice>(null);
  const [view, setView] = useState<OpsView>('useragent');
  const [tokenInput, setTokenInput] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(Boolean(getAdminToken()));
  const [searchInput, setSearchInput] = useState('');
  const deferredSearch = useDeferredValue(searchInput.trim());
  const [openedUserId, setOpenedUserId] = useState<string | null>(null);
  const [selectedArticle, setSelectedArticle] = useState<{ userId: string; articleId: string } | null>(null);

  useEffect(() => {
    if (notice == null) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const userAgentsQuery = useQuery({
    queryKey: ['admin-user-agents', deferredSearch],
    queryFn: () => getAdminUserAgents({ query: deferredSearch, limit: 12 }),
    enabled: isAuthenticated,
    staleTime: 5_000,
    refetchInterval: view === 'useragent' ? 15_000 : 30_000,
  });

  const userDetailQuery = useQuery({
    queryKey: ['admin-user-agent-detail', openedUserId],
    queryFn: () => getAdminUserAgentDetail(openedUserId!),
    enabled: isAuthenticated && openedUserId != null,
    staleTime: 5_000,
    refetchInterval: view === 'useragent' ? 15_000 : false,
  });

  const articleQuery = useQuery({
    queryKey: ['admin-user-agent-article', selectedArticle?.userId, selectedArticle?.articleId],
    queryFn: () => getAdminUserAgentArticleDetail(selectedArticle!.userId, selectedArticle!.articleId),
    enabled: isAuthenticated && selectedArticle != null,
  });

  const topicOverviewQuery = useQuery({
    queryKey: ['admin-topic-agent-overview'],
    queryFn: getAdminTopicAgentOverview,
    enabled: isAuthenticated,
    staleTime: 5_000,
    refetchInterval: view === 'topic-agent' ? 15_000 : 30_000,
  });

  const agentPromptConfigQuery = useQuery({
    queryKey: ['admin-agent-prompt-config'],
    queryFn: getAdminAgentPromptConfig,
    enabled: isAuthenticated,
    staleTime: 5_000,
  });

  const agentSkillsQuery = useQuery({
    queryKey: ['admin-agent-skills'],
    queryFn: getAdminAgentSkills,
    enabled: isAuthenticated,
    staleTime: 5_000,
  });

  const enqueueTopicMutation = useMutation({
    mutationFn: () => enqueueTopicAgentRun({}),
    onSuccess: async (result) => {
      setNotice({ type: 'success', message: result.deduped ? `slot ${result.slotKey} 已在队列中。` : `已为 ${result.slotKey} 创建 topic 任务。` });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-topic-agent-overview'] }),
      ]);
    },
    onError: (error) => setNotice({ type: 'error', message: (error as Error).message }),
  });

  const runNowTopicMutation = useMutation({
    mutationFn: () => runTopicAgentNow({}),
    onSuccess: async (result) => {
      setNotice({ type: 'success', message: `${result.slotKey} 已执行，生成 ${result.generated} 篇。` });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-topic-agent-overview'] }),
      ]);
    },
    onError: (error) => setNotice({ type: 'error', message: (error as Error).message }),
  });

  const savePromptConfigMutation = useMutation({
    mutationFn: saveAdminAgentPromptConfig,
    onSuccess: async () => {
      setNotice({ type: 'success', message: 'Agent prompt 配置已保存。' });
      await queryClient.invalidateQueries({ queryKey: ['admin-agent-prompt-config'] });
    },
    onError: (error) => setNotice({ type: 'error', message: (error as Error).message }),
  });

  const saveSkillsMutation = useMutation({
    mutationFn: saveAdminAgentSkills,
    onSuccess: async () => {
      setNotice({ type: 'success', message: 'Agent skills 已保存。' });
      await queryClient.invalidateQueries({ queryKey: ['admin-agent-skills'] });
    },
    onError: (error) => setNotice({ type: 'error', message: (error as Error).message }),
  });

  async function handleLogin() {
    const token = tokenInput.trim();
    if (!token) {
      setNotice({ type: 'error', message: '请先输入 ADMIN_API_TOKEN。' });
      return;
    }

    setAdminToken(token);
    try {
      await validateAdminToken();
      setIsAuthenticated(true);
      setNotice({ type: 'success', message: '管理员 token 验证通过。' });
    } catch (error) {
      clearAdminToken();
      setIsAuthenticated(false);
      setNotice({ type: 'error', message: (error as Error).message });
    }
  }

  function handleLogout() {
    clearAdminToken();
    setIsAuthenticated(false);
    setOpenedUserId(null);
    setSelectedArticle(null);
    setSearchInput('');
    queryClient.clear();
  }

  async function refreshActiveView() {
    if (view === 'useragent') {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-user-agents'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-user-agent-detail'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-user-agent-article'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-agent-prompt-config'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-agent-skills'] }),
      ]);
      return;
    }

    await queryClient.invalidateQueries({ queryKey: ['admin-topic-agent-overview'] });
  }

  const activeRefreshing = view === 'useragent'
    ? userAgentsQuery.isFetching || userDetailQuery.isFetching || articleQuery.isFetching
    : topicOverviewQuery.isFetching;

  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(15,118,110,0.14),transparent_28%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.12),transparent_28%),linear-gradient(180deg,#f7f4ec,#f4efe4)] px-5 py-10">
        <div className="mx-auto max-w-3xl space-y-4">
          {notice ? <NoticeBanner notice={notice} /> : null}
          <section className="rounded-[36px] border border-base-300/70 bg-base-100/92 p-8 shadow-sm">
            <p className="m-0 text-sm uppercase tracking-[0.24em] text-base-content/45">Agent Ops Console</p>
            <h1 className="m-0 mt-4 text-4xl font-semibold tracking-tight">管理员视角的多 Agent 后台</h1>
            <p className="m-0 mt-3 max-w-2xl text-base leading-7 text-base-content/68">
              `/ops/` 现在通过管理员 token 进入，不再依赖 passkey。登录后可以在同一套界面里查看不同用户的 `useragent`，以及全局 `topic agent` 的内容生成流程。
            </p>

            <div className="mt-8 grid gap-4 md:grid-cols-3">
              <article className="rounded-[24px] border border-base-300/70 bg-base-200/50 p-5">
                <Users size={18} className="text-base-content/60" />
                <p className="m-0 mt-3 text-sm font-semibold">User Agent</p>
                <p className="m-0 mt-2 text-sm leading-6 text-base-content/65">按用户切换，查看日报、推荐、任务、事件、资产快照。</p>
              </article>
              <article className="rounded-[24px] border border-base-300/70 bg-base-200/50 p-5">
                <Workflow size={18} className="text-base-content/60" />
                <p className="m-0 mt-3 text-sm font-semibold">Topic Agent</p>
                <p className="m-0 mt-2 text-sm leading-6 text-base-content/65">看 collect、staged、running、result 这条内容生产流水线。</p>
              </article>
              <article className="rounded-[24px] border border-base-300/70 bg-base-200/50 p-5">
                <KeyRound size={18} className="text-base-content/60" />
                <p className="m-0 mt-3 text-sm font-semibold">Admin Token</p>
                <p className="m-0 mt-2 text-sm leading-6 text-base-content/65">使用 `ADMIN_API_TOKEN`，通过 `Authorization: Bearer ...` 访问后台接口。</p>
              </article>
            </div>

            <div className="mt-8 space-y-3">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-base-content/70">管理员 Token</span>
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                  placeholder="输入 apps/api/.dev.vars 中的 ADMIN_API_TOKEN"
                  className="input input-bordered h-13 w-full rounded-[20px] bg-base-100"
                />
              </label>
              <button type="button" className="btn btn-primary btn-lg rounded-full" onClick={() => void handleLogin()}>
                进入后台
              </button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(15,118,110,0.10),transparent_28%),radial-gradient(circle_at_top_right,rgba(251,191,36,0.12),transparent_24%),linear-gradient(180deg,#f8f5ee,#f2ede3)] px-5 py-5">
      <div className="mx-auto flex min-h-screen w-full max-w-[90rem] flex-col gap-5 pb-12">
        {notice ? <NoticeBanner notice={notice} /> : null}

        <AppHeader
          currentView={view}
          onChangeView={setView}
          onRefresh={() => void refreshActiveView()}
          refreshing={activeRefreshing}
          onLogout={handleLogout}
        />

        {view === 'useragent' ? (
          <UserAgentPanel
            users={userAgentsQuery.data?.items ?? []}
            total={userAgentsQuery.data?.total ?? 0}
            openedUserId={openedUserId}
            onOpenUser={setOpenedUserId}
            onCloseUser={() => {
              setOpenedUserId(null);
              setSelectedArticle(null);
            }}
            userDetailQuery={userDetailQuery}
          articleQuery={articleQuery}
          selectedArticle={selectedArticle}
          onOpenArticle={(userId, articleId) => setSelectedArticle({ userId, articleId })}
          onCloseArticle={() => setSelectedArticle(null)}
            searchInput={searchInput}
            onSearchInput={setSearchInput}
            promptConfigQuery={agentPromptConfigQuery}
            savePromptConfig={savePromptConfigMutation}
            skillsQuery={agentSkillsQuery}
            saveSkills={saveSkillsMutation}
          />
        ) : (
          <TopicAgentPanel
            query={topicOverviewQuery}
            enqueueMutation={enqueueTopicMutation}
            runNowMutation={runNowTopicMutation}
          />
        )}
      </div>
    </main>
  );
}
