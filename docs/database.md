# Database

HyperDispatch uses PostgreSQL for persistent state. Four tables serve orchestration logic, API responses, and dashboard rendering.

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

### `dispatch_entries`
Tracks ticket-level state. One row per Jira ticket key. Managed by webhook + scheduler + monitor reconciliation.

| Column | Type | Description |
|---|---|---|
| `ticket_key` | `TEXT` PK | Jira issue key (e.g., "PROJ-123") |
| `project_key` | `TEXT` FK | References `project_configs.project_key` |
| `summary` | `TEXT` | Ticket summary for dashboard display |
| `status` | `TEXT` | `blocked`, `blocked_cycle`, `queued`, `running`, `succeeded`, `failed`, `stale` |
| `blocked_by` | `TEXT[]` | Blocking ticket keys (when status = blocked) |
| `priority` | `INTEGER` | From Jira priority (for queue ordering) |
| `ticket_status_name` | `TEXT` | Persisted Jira workflow status name (e.g. `To Do`, `In Progress`, `Done`); written by the scheduler's reconcile loop so the dashboard never calls Jira on render |
| `ticket_status_category` | `TEXT` | Persisted Jira status category key (e.g. `new`, `in-flight`, `done`); used by the dashboard for badge color and by `hideDone` filtering (`hideDone` excludes rows whose category is `done`; null categories are shown) |
| `created_at` | `TIMESTAMPTZ` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | Last update time |

### `dispatch_runs`
Tracks individual agent runs for a ticket. Multiple rows per ticket (`dispatch_entries.ticket_key`). Managed by spawner, monitor, and revision flows.

| Column | Type | Description |
|---|---|---|
| `id` | `UUID` PK | Run record identifier |
| `ticket_key` | `TEXT` FK | References `dispatch_entries.ticket_key` (`ON DELETE CASCADE`) |
| `run_type` | `TEXT` | Run category (`implementation`, `revision`; extensible) |
| `run_id` | `TEXT` | Oz run ID (null before/if spawn metadata not bound yet) |
| `status` | `TEXT` | `blocked`, `blocked_cycle`, `queued`, `running`, `succeeded`, `failed`, `stale` |
| `model` | `TEXT` | Model used for this run |
| `spawned_at` | `TIMESTAMPTZ` | When the run was spawned |
| `completed_at` | `TIMESTAMPTZ` | When the run completed |
| `pr_url` | `TEXT` | Pull request URL for this run |
| `pr_has_conflicts` | `BOOLEAN` | Whether GitHub currently reports merge conflicts (`true`/`false`/`null` unknown) |
| `pr_display_state` | `TEXT` | Persisted PR display state (`open`/`draft`/`merged`/`closed`) |
| `pr_review_running` | `BOOLEAN` | Whether PR review workflow is currently in-flight (`true`/`false`/`null`) |
| `pr_revision_running` | `BOOLEAN` | Whether PR revision workflow is currently in-flight (`true`/`false`/`null`) |
| `session_link` | `TEXT` | Oz session link for this run |
| `error` | `TEXT` | Last failure reason for this run |
| `created_at` | `TIMESTAMPTZ` | Row creation time |
| `updated_at` | `TIMESTAMPTZ` | Last update time |

### `revision_events`

Idempotency ledger for PR revision webhook events. One row per processed delivery so redelivered GitHub webhooks do not spawn duplicate revision runs.

| Column | Type | Description |
|---|---|---|
| `event_key` | `TEXT` PK | Stable per-delivery key (`review:<reviewId>` or `comment:<commentId>`) |
| `ticket_key` | `TEXT` | Jira issue key the revision targets |
| `pr_url` | `TEXT` | Pull request URL the event was received for |
| `created_at` | `TIMESTAMPTZ` | Row creation time |

## Indexes

- `idx_dispatch_entries_status` on `dispatch_entries(status)` — for scheduler queue and entry-level status reads.
- `idx_dispatch_entries_project` on `dispatch_entries(project_key)` — for per-project dashboard/API filtering.
- `idx_dispatch_entries_created_at` on `dispatch_entries(created_at DESC)` — supports entry-level ordering.
- `idx_dispatch_runs_ticket` on `dispatch_runs(ticket_key)` — for run-history fetches by ticket.
- `idx_dispatch_runs_status` on `dispatch_runs(status)` — for monitor polling and running-run counts.
- `idx_dispatch_runs_created_at` on `dispatch_runs(created_at DESC)` — supports latest-run selection and run-history ordering.
- `idx_revision_events_ticket` on `revision_events(ticket_key)` — for looking up revision events by ticket.
- `idx_revision_events_created_at` on `revision_events(created_at)` — supports efficient range deletes when purging old rows (see retention note below).

## Status transition notes

- `removeBlocker(ticketKey, blockerKey)` removes a blocker from `dispatch_entries.blocked_by`.
- If blocker removal empties `blocked_by`, only entries currently in `blocked` auto-transition to `queued`.
- Entries in `blocked_cycle` remain `blocked_cycle` after blocker removal.
- `claimRunForSpawn(ticketKey)` atomically claims a queued entry for dispatch (`queued` → `running`) and prevents duplicate scheduler dispatches.
- `releaseSpawnClaim(ticketKey)` reverts a claimed entry (`running` → `queued`) only if no run id has been bound on the active run.
- `createRun(ticketKey, runType)` inserts a new run record for every implementation/revision spawn attempt.
- `updateRunStatus` writes run-level fields and can target a specific run record id (`run_record_id`) so monitor/webhook updates only mutate the intended run row. If no run row exists yet, it creates one from the supplied fields (using the entry status when `status` is omitted) so metadata like `error`, `session_link`, and PR fields are not silently dropped.
- `recomputeEntryStatus(ticketKey)` derives `dispatch_entries.status` from run history so entry-level status remains consistent with the latest active/terminal run state.
- `claimRevisionSlot` atomically flips the entry to `running` only when no running run exists and the latest run is terminal, so concurrent revision triggers cannot both claim.
- `releaseRevisionSlot` recomputes entry status and can optionally delete a failed revision run record, making the ticket re-claimable after spawn/create failures.

## Retention
`revision_events` rows are written for every processed revision webhook delivery and are **never auto-deleted** (a successful revision's event key is kept permanently so a later redelivery of the same review/comment stays de-duplicated). The table grows roughly with the number of revision triggers, so operators should periodically purge old rows, e.g.:
```sql
DELETE FROM revision_events WHERE created_at < NOW() - INTERVAL '90 days';
```
The `idx_revision_events_created_at` index keeps this range delete cheap. A 90-day window is far longer than GitHub's webhook redelivery horizon, so purging beyond it cannot reintroduce duplicate revision runs.
## Migrations

The schema is applied on startup by `runMigrations()` (`src/db/migrate.ts`): it executes `src/db/schema.sql` (idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`) followed by additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements. Legacy single-table state (`dispatch_runs` as ticket-level row) is migrated into the split model inside one transaction (rename legacy table → apply schema → backfill `dispatch_entries` + per-run `dispatch_runs` → drop legacy table), so a crash cannot leave a half-migrated database.
