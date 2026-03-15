CREATE TABLE agent_prompt_configs (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  chat_system_prompt_mode TEXT NOT NULL DEFAULT 'append',
  chat_system_prompt_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
