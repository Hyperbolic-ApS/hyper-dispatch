# Architecture

HyperDispatch is a deterministic orchestration service. It receives Jira webhook events, resolves ticket dependencies, and spawns Oz cloud agents to implement work. No LLM is involved in orchestration decisions.

## High-Level Flow

```
Jira Automation (webhook) → HyperDispatch → Oz Cloud Agents → PRs
```

1. A Jira issue transitions to "To Do" (or is discovered in periodic polling if webhook is missed).
2. HyperDispatch checks dependencies — if all blockers are resolved, the ticket is eligible.
3. The scheduler reconciles To Do/backfill + deleted tickets, then checks concurrency limits and atomically claims queued entries before dispatching.
4. The agent spawner creates a new run record for the ticket, then spawns an Oz cloud agent run with the configured skill, model, and environment.
5. The run monitor polls running run records for completion, updates the specific run row, then recomputes ticket-level entry status and transitions the Jira ticket.

## Components

| Component | Responsibility |
|---|---|
| Webhook Receiver | Ingests Jira transition events plus signed GitHub `pull_request`, `pull_request_review`, and `issue_comment` events, then applies configured automation (including in-app PR revision triggering) |
| Dependency Resolver | Checks `issuelinks` for blocking relationships, detects cycles |
| Scheduler | Enforces concurrency cap, priority ordering, non-overlapping cycles, and atomic dispatch claims on `dispatch_entries`; also persists `ticket_status_name` / `ticket_status_category` for each live issue during reconcile so the dashboard can render ticket status without calling Jira |
| Agent Spawner | Constructs prompt, selects model/skill/environment, creates a per-run `dispatch_runs` row (`run_type` aware), then calls Oz SDK |
| Run Monitor | Polls Oz run status from `dispatch_runs` rows where status is `running`, updates run-level state, recomputes entry-level status in `dispatch_entries`, transitions Jira tickets, backfills `session_link` for in-flight runs as soon as Oz exposes it, reconciles succeeded-run PR metadata (`pr_has_conflicts`, `pr_display_state`) including merged-PR Done backfills (skipping runs already in a terminal `merged`/`closed` PR display state to bound GitHub calls), marks still-draft PRs of tracked succeeded runs ready-for-review via GraphQL (the authoritative draft→open path), and resolves PR review/revision workflow action-state (`pr_review_running`, `pr_revision_running`) for active PRs so the dashboard renders those badges from the DB instead of calling GitHub on the render path |
| State Store | PostgreSQL — `project_configs`, `dispatch_entries`, `dispatch_runs`, and `revision_events` tables |
| Dashboard | Server-rendered HTML status page at `/dashboard` with SQL-side filtering and pagination (50 rows/page); each ticket row shows latest run status with run-history popover from `dispatch_runs`; auto-refresh is a client-side fetch of `/dashboard/fragment` that swaps the inner content block, leaving the door open for a future websocket push |
| Config UI | Server-rendered HTML for managing project configurations at `/config` |
| Jira Validator | Validates board columns, custom fields, and workflow statuses |

## Key Design Decisions

- **Deterministic orchestration**: All dispatch logic is plain TypeScript. Oz is used only for code execution.
- **Stateful**: PostgreSQL state store enables fast dashboard reads, dedup, and survives restarts.
- **Multi-project**: One HyperDispatch instance serves multiple Jira projects via a single global webhook rule.
- **Skill-driven workers**: The agent's workflow is defined by skills selected per-project, not hardcoded in HyperDispatch.
- **Race-safe scheduling**: The scheduler loop self-schedules with awaited `setTimeout` (no overlapping cycles), and each queued ticket must be atomically claimed in Postgres before spawn.
