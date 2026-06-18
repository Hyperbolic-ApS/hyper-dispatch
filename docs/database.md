# Database

HyperDispatch uses PostgreSQL for persistent state. Two tables serve both orchestration logic and the dashboard.

## Tables

### `project_configs`

Stores per-project configuration. Managed via the config UI.

| Column | Type | Description |
|---|---|---|
| `project_key` | `TEXT` PK | Jira project key (e.g., "PROJ") |
| `jira_cloud_id` | `TEXT` | Jira cloud site ID for API calls |
| `board_id` | `INTEGER` | Board ID for validation |
| `oz_env_id` | `TEXT` | Oz environment ID |
| `oz_api_key` | `TEXT` | Optional per-project Oz API key override used for all Oz SDK calls (null = global `WARP_API_KEY`) |
| `oz_agent_identity_uid` | `TEXT` | Optional Oz agent identity UID used as the execution principal for spawned runs (null = API key default) |
| `github_repo` | `TEXT` | GitHub repo (e.g., "org/mono-repo") |
| `default_model` | `TEXT` | Default LLM model ID (null = Oz default) |
| `model_field_id` | `TEXT` | Jira custom field ID for per-ticket model override |
| `backlog_column_name` | `TEXT` | Jira backlog column/status name for this project (default: `Backlog`) |
| `to_do_column_name` | `TEXT` | Jira to-do column/status name (default: `To Do`) |
| `in_progress_column_name` | `TEXT` | Jira in-progress column/status name (default: `In Progress`) |
| `in_review_column_name` | `TEXT` | Jira in-review column/status name (default: `In Review`) |
| `done_column_name` | `TEXT` | Jira done column/status name (default: `Done`) |
| `skills` | `TEXT[]` | Skill specs (e.g., `["org/repo:hyperdispatch-worker"]`) |
| `mcp_servers` | `JSONB` | Optional MCP server map passed to Oz as `mcp_servers` when spawning |
| `active` | `BOOLEAN` | Whether this project is active |
| `created_at` | `TIMESTAMPTZ` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | Last update time |

### `dispatch_runs`

Tracks ticket → agent run state. Managed by the orchestration loop.

| Column | Type | Description |
|---|---|---|
| `ticket_key` | `TEXT` PK | Jira issue key (e.g., "PROJ-123") |
| `project_key` | `TEXT` FK | References `project_configs.project_key` |
| `summary` | `TEXT` | Ticket summary for dashboard display |
| `run_id` | `TEXT` | Oz run ID (null if blocked/queued) |
| `status` | `TEXT` | `blocked`, `blocked_cycle`, `queued`, `running`, `succeeded`, `failed`, `stale` |
| `blocked_by` | `TEXT[]` | Blocking ticket keys (when status = blocked) |
| `model` | `TEXT` | Model used for this run |
| `priority` | `INTEGER` | From Jira priority (for queue ordering) |
| `spawned_at` | `TIMESTAMPTZ` | When the agent was spawned |
| `completed_at` | `TIMESTAMPTZ` | When the run completed |
| `pr_url` | `TEXT` | Pull request URL |
| `pr_has_conflicts` | `BOOLEAN` | Whether GitHub currently reports merge conflicts for the PR (`true`/`false`/`null` unknown) |
| `pr_display_state` | `TEXT` | Persisted PR display state for dashboard rendering (`open`/`draft`/`merged`/`closed`/`null` unknown), DB-constrained to the four non-null states |
| `pr_review_running` | `BOOLEAN` | Whether the PR review workflow is currently in-flight (`true`/`false`/`null` unknown); resolved out-of-band by the run monitor so the dashboard renders the badge without live GitHub calls |
| `pr_revision_running` | `BOOLEAN` | Whether the PR revision workflow is currently in-flight (`true`/`false`/`null` unknown); resolved out-of-band by the run monitor |
| `session_link` | `TEXT` | Oz session link for live monitoring |
| `error` | `TEXT` | Last failure reason |
| `ticket_status_name` | `TEXT` | Persisted Jira workflow status name (e.g. `To Do`, `In Progress`, `Done`); written by the scheduler's reconcile loop so the dashboard never calls Jira on render |
| `ticket_status_category` | `TEXT` | Persisted Jira status category key (e.g. `new`, `in-flight`, `done`); used by the dashboard for badge color and by `hideDone` filtering (`hideDone` excludes rows whose category is `done`; null categories are shown) |
| `created_at` | `TIMESTAMPTZ` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | Last update time |

## Indexes

- `idx_status` on `dispatch_runs(status)` — for run monitor queries and concurrency counting.
- `idx_project` on `dispatch_runs(project_key)` — for per-project dashboard filtering.
- `idx_dispatch_runs_created_at` on `dispatch_runs(created_at DESC)` — supports the dashboard's default ordering and keeps `LIMIT`/`OFFSET` pagination cheap as the table grows.

## Status transition notes

- `removeBlocker(ticketKey, blockerKey)` removes a blocker from `blocked_by`.
- If that removal empties `blocked_by`, only runs currently in `blocked` auto-transition to `queued`.
- Runs in `blocked_cycle` remain `blocked_cycle` after blocker removal (cycle status is not auto-cleared by this query path).
- `claimRunForSpawn(ticketKey)` atomically transitions a row from `queued` → `running` and returns whether the claim succeeded. This is used to prevent duplicate dispatches across concurrent triggers.
- `releaseSpawnClaim(ticketKey)` reverts `running` → `queued` only when `run_id IS NULL` (failed pre-spawn path), so claimed rows tied to real Oz runs are never accidentally released.
- Scheduler errors after `spawnAgent` invocation are persisted as `failed` instead of being re-queued; if that failure-state write also fails, claim rollback is attempted so rows remain recoverable and do not stay stranded in `running` indefinitely.
- `upsertDispatchRun` conflict updates do not allow stale incoming `queued` writes to overwrite rows already in `running` or `succeeded`.

## Migrations

Schema migrations are managed with raw SQL files in `src/db/migrations/`. Each migration file is named `NNN_description.sql` and applied in order on startup.
