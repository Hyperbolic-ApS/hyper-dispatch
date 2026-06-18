# Architecture

HyperDispatch is a deterministic orchestration service. It receives Jira webhook events, resolves ticket dependencies, and spawns Oz cloud agents to implement work. No LLM is involved in orchestration decisions.

## High-Level Flow

```
Jira Automation (webhook) → HyperDispatch → Oz Cloud Agents → PRs
```

1. A Jira issue transitions to "To Do" (or is discovered in periodic polling if webhook is missed).
2. HyperDispatch checks dependencies — if all blockers are resolved, the ticket is eligible.
3. The scheduler reconciles To Do/backfill + deleted tickets, then checks concurrency limits and atomically claims queued runs before dispatching.
4. The agent spawner creates an Oz cloud agent run with the configured skill, model, and environment.
5. The run monitor polls Oz for completion, then updates the state store and transitions the Jira ticket.

## Components

| Component | Responsibility |
|---|---|
| Webhook Receiver | Ingests Jira transition events plus signed GitHub `pull_request`, `pull_request_review`, and `issue_comment` events, then applies configured automation (including in-app PR revision triggering) |
| Dependency Resolver | Checks `issuelinks` for blocking relationships, detects cycles |
| Scheduler | Enforces concurrency cap, priority ordering, non-overlapping cycles, and atomic dispatch claims; also persists `ticket_status_name` / `ticket_status_category` for each live issue during reconcile so the dashboard can render ticket status without calling Jira |
| Agent Spawner | Constructs prompt, selects model/skill/environment, calls Oz SDK |
| Run Monitor | Polls Oz run status, updates state store, transitions Jira tickets, backfills `session_link` for in-flight runs as soon as Oz exposes it, and reconciles succeeded-run PR metadata (`pr_has_conflicts`, `pr_display_state`) including merged-PR Done backfills (skipping runs already in a terminal `merged`/`closed` PR display state to bound GitHub calls) |
| State Store | PostgreSQL — `project_configs`, `dispatch_runs`, and `revision_events` tables |
| Dashboard | Server-rendered HTML status page at `/dashboard` with SQL-side filtering and pagination (50 rows/page); auto-refresh is a client-side fetch of `/dashboard/fragment` that swaps the inner content block, leaving the door open for a future websocket push |
| Config UI | Server-rendered HTML for managing project configurations at `/config` |
| Jira Validator | Validates board columns, custom fields, and workflow statuses |

## Key Design Decisions

- **Deterministic orchestration**: All dispatch logic is plain TypeScript. Oz is used only for code execution.
- **Stateful**: PostgreSQL state store enables fast dashboard reads, dedup, and survives restarts.
- **Multi-project**: One HyperDispatch instance serves multiple Jira projects via a single global webhook rule.
- **Skill-driven workers**: The agent's workflow is defined by skills selected per-project, not hardcoded in HyperDispatch.
- **Race-safe scheduling**: The scheduler loop self-schedules with awaited `setTimeout` (no overlapping cycles), and each queued ticket must be atomically claimed in Postgres before spawn.
