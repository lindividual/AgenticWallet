export type AgentPromptConfig = {
  basePromptText: string;
  updatedAt: string | null;
};

export type AgentPromptSkill = {
  slug: string;
  name: string;
  description: string;
  promptText: string;
  enabled: boolean;
  sortOrder: number;
  updatedAt: string | null;
};

const DEFAULT_AGENT_PROMPT_CONFIG: AgentPromptConfig = {
  basePromptText: '',
  updatedAt: null,
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPromptConfigSchemaError(error: unknown, tableName: string): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes(`no such table: ${tableName}`) ||
    (message.includes('no such column') && message.includes(tableName))
  );
}

function normalizePromptText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function getAgentPromptConfig(db: D1Database): Promise<AgentPromptConfig> {
  let row:
    | {
        chat_system_prompt_mode?: string | null;
        chat_system_prompt_text?: string | null;
        updated_at?: string | null;
      }
    | null
    | undefined;
  try {
    row = await db
      .prepare(
        `SELECT chat_system_prompt_mode, chat_system_prompt_text, updated_at
           FROM agent_prompt_configs
          WHERE id = 1`,
      )
      .first<{
        chat_system_prompt_mode?: string | null;
        chat_system_prompt_text?: string | null;
        updated_at?: string | null;
      }>();
  } catch (error) {
    if (!isMissingPromptConfigSchemaError(error, 'agent_prompt_configs')) {
      throw error;
    }
    console.warn('agent_prompt_config_read_unavailable', {
      table: 'agent_prompt_configs',
      message: getErrorMessage(error),
    });
    return DEFAULT_AGENT_PROMPT_CONFIG;
  }

  if (!row) return DEFAULT_AGENT_PROMPT_CONFIG;
  return {
    basePromptText: normalizePromptText(row.chat_system_prompt_text),
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
  };
}

export async function getAgentPromptSkills(db: D1Database): Promise<AgentPromptSkill[]> {
  let result: {
    results?: Array<{
      slug?: string | null;
      name?: string | null;
      description?: string | null;
      prompt_text?: string | null;
      enabled?: number | null;
      sort_order?: number | null;
      updated_at?: string | null;
    }>;
  };
  try {
    result = await db
      .prepare(
        `SELECT slug, name, description, prompt_text, enabled, sort_order, updated_at
           FROM agent_prompt_skills
          ORDER BY sort_order ASC, updated_at ASC, slug ASC`,
      )
      .all<{
        slug?: string | null;
        name?: string | null;
        description?: string | null;
        prompt_text?: string | null;
        enabled?: number | null;
        sort_order?: number | null;
        updated_at?: string | null;
      }>();
  } catch (error) {
    if (!isMissingPromptConfigSchemaError(error, 'agent_prompt_skills')) {
      throw error;
    }
    console.warn('agent_prompt_config_read_unavailable', {
      table: 'agent_prompt_skills',
      message: getErrorMessage(error),
    });
    return [];
  }

  return (result.results ?? [])
    .map((row) => ({
      slug: typeof row.slug === 'string' ? row.slug.trim() : '',
      name: typeof row.name === 'string' ? row.name : '',
      description: typeof row.description === 'string' ? row.description : '',
      promptText: typeof row.prompt_text === 'string' ? row.prompt_text : '',
      enabled: Number(row.enabled) === 1,
      sortOrder: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0,
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
    }))
    .filter((skill) => Boolean(skill.slug && skill.name));
}

export async function saveAgentPromptConfig(
  db: D1Database,
  input: {
    basePromptText: string;
  },
): Promise<AgentPromptConfig> {
  const updatedAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO agent_prompt_configs (id, chat_system_prompt_mode, chat_system_prompt_text, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         chat_system_prompt_mode = excluded.chat_system_prompt_mode,
         chat_system_prompt_text = excluded.chat_system_prompt_text,
         updated_at = excluded.updated_at`,
    )
    .bind('replace', input.basePromptText, updatedAt)
    .run();

  return {
    basePromptText: input.basePromptText,
    updatedAt,
  };
}

export async function saveAgentPromptSkills(
  db: D1Database,
  skills: Array<{
    slug: string;
    name: string;
    description: string;
    promptText: string;
    enabled: boolean;
    sortOrder: number;
  }>,
): Promise<AgentPromptSkill[]> {
  const normalizedSkills = skills
    .map((skill, index) => ({
      slug: skill.slug.trim().toLowerCase(),
      name: skill.name.trim(),
      description: skill.description.trim(),
      promptText: skill.promptText.trim(),
      enabled: skill.enabled,
      sortOrder: Number.isFinite(Number(skill.sortOrder)) ? Math.max(0, Math.trunc(skill.sortOrder)) : index,
    }))
    .filter((skill) => Boolean(skill.slug && skill.name));

  const updatedAt = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM agent_prompt_skills'),
    ...normalizedSkills.map((skill) =>
      db
        .prepare(
          `INSERT INTO agent_prompt_skills (
            slug,
            name,
            description,
            prompt_text,
            enabled,
            sort_order,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          skill.slug,
          skill.name,
          skill.description,
          skill.promptText,
          skill.enabled ? 1 : 0,
          skill.sortOrder,
          updatedAt,
        )),
  ];

  await db.batch(statements);
  return getAgentPromptSkills(db);
}

export function applyAgentPromptConfig(basePrompt: string, config: AgentPromptConfig): string {
  const configuredBasePrompt = config.basePromptText.trim();
  return configuredBasePrompt || basePrompt;
}

export function applyAgentPromptSkills(basePrompt: string, skills: AgentPromptSkill[]): string {
  const enabledSkills = skills.filter((skill) => skill.enabled && skill.promptText.trim());
  if (enabledSkills.length === 0) return basePrompt;

  return [
    basePrompt,
    '',
    'Admin-configured skills:',
    '- If the user request clearly matches one of the skills below, follow that skill prompt first.',
    '- If multiple skills apply, combine them and keep the answer concise.',
    ...enabledSkills.flatMap((skill) => [
      '',
      `Skill: ${skill.name} [${skill.slug}]`,
      skill.description ? `When to use: ${skill.description}` : '',
      'Instructions:',
      skill.promptText,
    ]),
  ]
    .filter(Boolean)
    .join('\n');
}
