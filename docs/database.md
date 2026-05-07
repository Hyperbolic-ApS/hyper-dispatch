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
| `status` | `TEXT` | `blocked`, `queued`, `running`, `succeeded`, `failed`, `stale` |
| `blocked_by` | `TEXT[]` | Blocking ticket keys (when status = blocked) |
| `model` | `TEXT` | Model used for this run |
| `priority` | `INTEGER` | From Jira priority (for queue ordering) |
| `spawned_at` | `TIMESTAMPTZ` | When the agent was spawned |
| `completed_at` | `TIMESTAMPTZ` | When the run completed |
| `pr_url` | `TEXT` | Pull request URL |
| `pr_has_conflicts` | `BOOLEAN` | Whether GitHub currently reports merge conflicts for the PR (`true`/`false`/`null` unknown) |
| `session_link` | `TEXT` | Oz session link for live monitoring |
| `error` | `TEXT` | Last failure reason |
| `created_at` | `TIMESTAMPTZ` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | Last update time |

## Indexes

- `idx_status` on `dispatch_runs(status)` — for run monitor queries and concurrency counting.
- `idx_project` on `dispatch_runs(project_key)` — for per-project dashboard filtering.

## Migrations

Schema migrations are managed with raw SQL files in `src/db/migrations/`. Each migration file is named `NNN_description.sql` and applied in order on startup.
