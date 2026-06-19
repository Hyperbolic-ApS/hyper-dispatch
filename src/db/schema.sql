CREATE TABLE IF NOT EXISTS project_configs (
  project_key    TEXT PRIMARY KEY,
  jira_cloud_id  TEXT NOT NULL,
  board_id       INTEGER NOT NULL,
  oz_env_id      TEXT NOT NULL,
  oz_api_key     TEXT,
  oz_agent_identity_uid TEXT,
  github_repo    TEXT NOT NULL,
  default_model  TEXT,
  model_field_id TEXT,
  backlog_column_name TEXT NOT NULL DEFAULT 'Backlog',
  to_do_column_name TEXT NOT NULL DEFAULT 'To Do',
  in_progress_column_name TEXT NOT NULL DEFAULT 'In Progress',
  in_review_column_name TEXT NOT NULL DEFAULT 'In Review',
  done_column_name TEXT NOT NULL DEFAULT 'Done',
  skills         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  mcp_servers    JSONB,
  github_pat     TEXT,
  jira_api_token TEXT,
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
  pr_has_conflicts BOOLEAN,
  pr_display_state TEXT CHECK (pr_display_state IN ('open', 'draft', 'merged', 'closed')),
  pr_review_running BOOLEAN,
  pr_revision_running BOOLEAN,
  session_link   TEXT,
  error          TEXT,
  ticket_status_name TEXT,
  ticket_status_category TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_runs_status ON dispatch_runs(status);
CREATE INDEX IF NOT EXISTS idx_dispatch_runs_project ON dispatch_runs(project_key);
-- Supports the dashboard/API ordering (ORDER BY created_at DESC) so large tables
-- are not fully sorted on every read.
CREATE INDEX IF NOT EXISTS idx_dispatch_runs_created_at ON dispatch_runs(created_at DESC);

-- Idempotency ledger for PR revision webhook events. Each row records a single
-- processed delivery (keyed by GitHub review/comment id) so redelivered webhooks
-- do not spawn duplicate revision runs.
CREATE TABLE IF NOT EXISTS revision_events (
  event_key   TEXT PRIMARY KEY,
  ticket_key  TEXT NOT NULL,
  pr_url      TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revision_events_ticket ON revision_events(ticket_key);
-- Supports efficient range deletes when purging old rows (no automatic TTL; see
-- docs/database.md — operators periodically prune rows older than a retention window).
CREATE INDEX IF NOT EXISTS idx_revision_events_created_at ON revision_events(created_at);
