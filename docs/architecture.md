# Architecture

HyperDispatch is a deterministic orchestration service. It receives Jira webhook events, resolves ticket dependencies, and spawns Oz cloud agents to implement work. No LLM is involved in orchestration decisions.

## High-Level Flow

```
Jira Automation (webhook) → HyperDispatch → Oz Cloud Agents → PRs
```

1. A Jira issue transitions to "To Do" (or is discovered in periodic polling if webhook is missed).
2. HyperDispatch checks dependencies — if all blockers are resolved, the ticket is eligible.
3. The scheduler reconciles To Do/backfill + deleted tickets, then checks concurrency limits and queues or dispatches.
4. The agent spawner creates an Oz cloud agent run with the configured skill, model, and environment.
5. The run monitor polls Oz for completion, then updates the state store and transitions the Jira ticket.

## Components

| Component | Responsibility |
|---|---|
| Webhook Receiver | Ingests Jira transition events, filters by configured projects |
| Dependency Resolver | Checks `issuelinks` for blocking relationships, detects cycles |
| Scheduler | Enforces concurrency cap, priority ordering, dedup |
| Agent Spawner | Constructs prompt, selects model/skill/environment, calls Oz SDK |
| Run Monitor | Polls Oz run status, updates state store, transitions Jira tickets |
| State Store | PostgreSQL — `project_configs` and `dispatch_runs` tables |
| Dashboard | Server-rendered HTML status page at `/dashboard` |
| Config UI | Server-rendered HTML for managing project configurations at `/config` |
| Jira Validator | Validates board columns, custom fields, and workflow statuses |

## Key Design Decisions

- **Deterministic orchestration**: All dispatch logic is plain TypeScript. Oz is used only for code execution.
- **Stateful**: PostgreSQL state store enables fast dashboard reads, dedup, and survives restarts.
- **Multi-project**: One HyperDispatch instance serves multiple Jira projects via a single global webhook rule.
- **Skill-driven workers**: The agent's workflow is defined by skills selected per-project, not hardcoded in HyperDispatch.
