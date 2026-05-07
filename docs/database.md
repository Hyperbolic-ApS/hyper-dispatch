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
| `skills` | `TEXT[]` | Skill specs (e.g., `["org/repo:hyperdispatch-worker"]`) |
| `active` | `BOOLEAN` | Whether this project is active |
| `created_at` | `TIMESTAMPTZ` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | Last update time |

### `users`

Stores frontend-authenticated users.

| Column | Type | Description |
|---|---|---|
| `id` | `TEXT` PK | User ID |
| `email` | `TEXT` unique | Login identifier |
| `password_hash` | `TEXT` | Scrypt-hashed password with salt |
| `role` | `TEXT` | `admin` or `member` |
| `created_at` | `TIMESTAMPTZ` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | Last update time |

### `sessions`

Stores active login sessions for cookie authentication.

| Column | Type | Description |
|---|---|---|
| `id` | `TEXT` PK | Session ID |
| `user_id` | `TEXT` FK | References `users.id` |
| `token_hash` | `TEXT` unique | SHA-256 hash of cookie token |
| `expires_at` | `TIMESTAMPTZ` | Session expiry |
| `created_at` | `TIMESTAMPTZ` | Row creation time |

### `invite_links`

Stores one-time invite tokens for user signup.

| Column | Type | Description |
|---|---|---|
| `id` | `TEXT` PK | Invite ID |
| `token_hash` | `TEXT` unique | SHA-256 hash of invite token |
| `created_by_user_id` | `TEXT` FK | Admin who created invite |
| `used_by_user_id` | `TEXT` FK nullable | User created from invite |
| `used_at` | `TIMESTAMPTZ` nullable | Consumption timestamp |
| `created_at` | `TIMESTAMPTZ` | Row creation time |

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
| `session_link` | `TEXT` | Oz session link for live monitoring |
| `error` | `TEXT` | Last failure reason |
| `created_at` | `TIMESTAMPTZ` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | Last update time |

## Indexes

- `idx_status` on `dispatch_runs(status)` — for run monitor queries and concurrency counting.
- `idx_project` on `dispatch_runs(project_key)` — for per-project dashboard filtering.
- `idx_sessions_token_hash` and `idx_sessions_user_id` for session lookup and cleanup.
- `idx_invite_links_token_hash` for invite token validation.

## Migrations

Schema migrations are managed with raw SQL files in `src/db/migrations/`. Each migration file is named `NNN_description.sql` and applied in order on startup.
