# Worker Agents

Worker agents are Oz cloud agent runs that perform the actual coding work. HyperDispatch spawns them and monitors their lifecycle, but does not control their implementation approach — that is defined by the skill.

## Spawning

The Agent Spawner creates a run via the `oz-agent-sdk` with:
- **name**: Jira ticket key (e.g., `PROJ-123`).
- **environment_id**: from the project config.
- **model_id**: per-ticket custom field → project default → Oz default (cascade).
- **skill**: from the project config (one or more skill specs).
- **mcp_servers**: optional map from project config (`mcp_servers`) when set.
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
4. While the run remains `succeeded`, HyperDispatch polls the PR; once GitHub reports it as merged, HyperDispatch transitions the Jira ticket to "Done".
5. On `FAILED` → status becomes `failed`, ticket stays in "In Progress" for manual triage.
6. On stale (running > `MAX_RUN_DURATION_HOURS`) → cancelled and marked `stale`.

## PR Review Feedback Loop

When a reviewer requests changes on an agent-created PR, a GitHub Actions workflow automatically spawns a new Oz agent to address the feedback.

Workflow file: `.github/workflows/agent-revision.yml`

### Trigger conditions

- A `pull_request_review` event is submitted with state `changes_requested`.
- The PR branch name starts with `agent/` (i.e., it was created by a HyperDispatch worker agent).

### Behavior

1. Extracts the Jira ticket key from the branch name (`agent/{ticket-key}` → `{ticket-key}`).
2. Collects the review summary and all inline comments from the latest "changes requested" review.
3. Spawns an Oz agent via `warpdotdev/oz-agent-action@main` with a prompt containing the PR URL, branch, and all review feedback.
4. The agent commits its changes directly to the existing PR branch and does **not** open a new PR.

### Setup

To use this workflow in a target repo, copy `.github/workflows/agent-revision.yml` into the repo and configure:

- **Required secret**: `WARP_API_KEY` — Warp API key for spawning agents.
- **Optional var**: `WARP_AGENT_PROFILE` — Oz agent profile (uses the Oz platform default if unset).

## Default Worker Skill

The default skill (`.warp/skills/hyperdispatch-worker/SKILL.md`) implements a standard workflow:

1. Parse ticket details from prompt (key, summary, description)
2. Create branch `agent/{ticket-key}`
3. Investigate the codebase
4. Plan the implementation
5. Implement (scoped tightly to minimize parallel merge conflicts)
6. Run tests, iterate on failures
7. Run lint/type checks
8. Commit with `{ticket-key}: {summary}` format + co-author line
9. Create PR via `gh pr create` with Jira link in body
10. Report PR URL via `report_pr` artifact

Projects are expected to customize or replace this skill as needed.
