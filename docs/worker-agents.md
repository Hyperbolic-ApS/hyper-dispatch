# Worker Agents

Worker agents are Oz cloud agent runs that perform the actual coding work. HyperDispatch spawns them and monitors their lifecycle, but does not control their implementation approach — that is defined by the skill.

## Spawning

The Agent Spawner creates a run via the `oz-agent-sdk` with:
- **name**: Jira ticket key (e.g., `PROJ-123`).
- **environment_id**: from the project config.
- **model_id**: per-ticket custom field → project default → Oz default (cascade).
- **skill**: from the project config (one or more skill specs).
- **prompt**: constructed from the Jira ticket (key, summary, description, acceptance criteria).

## Skill Contract

HyperDispatch is not opinionated about what the skill does internally. It expects two things:

1. **A PR is created** — the agent must create a pull request and output the URL via `report_pr`. HyperDispatch extracts the PR URL from run artifacts to update the state store and Jira ticket.
2. **Branch naming**: `agent/{ticket-key}` (e.g., `agent/PROJ-123`). This convention enables the PR review feedback loop GitHub Action to extract the ticket key.

Everything else — planning, implementation strategy, testing, commit style — is the skill's responsibility.

## Model Selection

The model used for a worker agent is determined by (in order of precedence):
1. Per-ticket Jira custom field (configured as `model_field_id` in project config).
2. Project default model (`default_model` in project config).
3. Oz platform default (if neither is set).

## Lifecycle

1. HyperDispatch spawns the agent → status becomes `running`.
2. The run monitor polls Oz every 30s.
3. On `SUCCEEDED` → HyperDispatch transitions the Jira ticket to "In Review" and records the PR URL.
4. On `FAILED` → status becomes `failed`, ticket stays in "In Progress" for manual triage.
5. On stale (running > `MAX_RUN_DURATION_HOURS`) → cancelled and marked `stale`.

## Default Worker Skill

The default skill (`.warp/skills/hyperdispatch-worker/SKILL.md`) implements a standard workflow. See the PLAN.md for the full step-by-step. Projects are expected to customize or replace this skill.
