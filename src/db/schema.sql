CREATE TABLE IF NOT EXISTS project_configs (
  project_key    TEXT PRIMARY KEY,
  jira_cloud_id  TEXT NOT NULL,
  board_id       INTEGER NOT NULL,
  oz_env_id      TEXT NOT NULL,
  github_repo    TEXT NOT NULL,
  default_model  TEXT,
  model_field_id TEXT,
  skills         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  active         BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dispatch_runs (
  ticket_key     TEXT PRIMARY KEY,
  project_key    TEXT NOT NULL REFERENCES project_configs(project_key),
  summary        TEXT,
  run_id         TEXT,
  status         TEXT NOT NULL CHECK (status IN ('blocked', 'queued', 'running', 'succeeded', 'failed', 'stale', 'blocked_cycle')),
  blocked_by     TEXT[],
  model          TEXT,
  priority       INTEGER DEFAULT 0,
  spawned_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  pr_url         TEXT,
  session_link   TEXT,
  error          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_runs_status ON dispatch_runs(status);
CREATE INDEX IF NOT EXISTS idx_dispatch_runs_project ON dispatch_runs(project_key);
