# Worker Agents

Worker agents are Oz cloud agent runs that perform the actual coding work. HyperDispatch spawns them and monitors their lifecycle, but does not control their implementation approach — that is defined by the skill.

## Spawning

The Agent Spawner creates a run via the `oz-agent-sdk` with:
- **name**: Jira ticket key (e.g., `PROJ-123`).
- **environment_id**: from the project config.
- **agent_identity_uid**: optional Oz agent identity from the project config (`oz_agent_identity_uid`). When set, it becomes the run's execution principal so all of the project's runs are tracked under one Oz agent. Only valid for team-owned runs (the default for single-team API keys); omitted when unset.
- **model_id**: per-ticket custom field → project default → Oz default (cascade).
- **skill**: from the project config (one or more skill specs).
- **mcp_servers**: optional map from project config (`mcp_servers`) when set.
- **prompt**: constructed from the Jira ticket (key, summary, description, acceptance criteria).

## Skill Contract

HyperDispatch is not opinionated about what the skill does internally. It expects two things:

1. **A PR is created** — the agent must create a pull request and output the URL via `report_pr`. HyperDispatch extracts the PR URL from run artifacts to update the state store and Jira ticket.
2. **Branch naming**: `agent/{ticket-key}-{short-descriptor}` (e.g., `agent/PROJ-123-github-webhooks`). The descriptor should be very short (2-3 words, 4 max) so branch names remain manageable. This convention enables the PR review feedback loop GitHub Action to extract the ticket key while still giving quick context.

Everything else — planning, implementation strategy, testing, commit style — is the skill's responsibility.

## Model Selection

The model used for a worker agent is determined by (in order of precedence):
1. Per-ticket Jira custom field (configured as `model_field_id` in project config).
2. Project default model (`default_model` in project config).
3. Oz platform default (if neither is set).
When reading the per-ticket Jira custom field, HyperDispatch accepts either a direct string value or an object-shaped Jira value like `{ value: "..." }` (common for select-list custom fields).

## Lifecycle

1. HyperDispatch spawns the agent → status becomes `running`.
2. The run monitor polls Oz every 30s.
3. On `SUCCEEDED` → HyperDispatch transitions the Jira ticket to "In Review" and records the PR URL.
4. While the run remains `succeeded`, HyperDispatch polls the PR; once GitHub reports it as merged, HyperDispatch transitions the Jira ticket to "Done".
5. On `FAILED` → status becomes `failed`, ticket stays in "In Progress" for manual triage.
6. On stale (running > `MAX_RUN_DURATION_HOURS`) → cancelled and marked `stale`.

## PR Review Feedback Loop

When actionable feedback is available on an agent-created PR, a GitHub Actions workflow can spawn a new Oz agent to address that feedback.

Workflow file: `.github/workflows/agent-revision.yml`

### Trigger conditions

- **Automatic loop trigger**: a `workflow_run` event for `Oz PR Review Commenting` completes successfully.
- **Manual trigger**: an `issue_comment` event is created on the PR containing `/revise`.
- The PR branch name starts with `agent/` and includes a Jira key (`agent/{ticket-key}` with optional `-{short-descriptor}` suffix).

### Behavior

1. Extracts the Jira ticket key from the branch name (`agent/{ticket-key}` or `agent/{ticket-key}-{short-descriptor}` → `{ticket-key}`).
2. For automatic triggers, resolves the PR from the completed review workflow run and collects the latest automated review summary and inline comments.
3. Applies a severity gate for automatic triggers: only runs revision when detected severity is at or above `REVISION_MIN_SEVERITY` (default `important`).
4. For manual `/revise` triggers, bypasses the severity gate and includes the manual instruction plus latest automated review feedback (if present).
5. Spawns an Oz agent via `warpdotdev/oz-agent-action@v1` with PR URL, branch, trigger metadata, and aggregated feedback.
6. The agent commits its changes directly to the existing PR branch and does **not** open a new PR.

### Setup

To use this workflow in a target repo, copy `.github/workflows/agent-revision.yml` into the repo and configure:

- **Required secret**: `WARP_API_KEY` — Warp API key for spawning agents.
- **Optional var**: `WARP_AGENT_PROFILE` — Oz agent profile (uses the Oz platform default if unset).
- **Optional var**: `REVISION_MIN_SEVERITY` — `none|minor|important|critical` (default `important`) for automatic review-triggered revisions.
- **Optional var**: `REVISION_REVIEW_BOT_LOGIN` — GitHub login treated as the automated reviewer (default `github-actions[bot]`).

## Automated PR Review Commenting

HyperDispatch also includes a PR review workflow that runs the `pr-review-commenting` skill whenever a non-draft pull request is created or updated.

Workflow file: `.github/workflows/oz-pr-review-commenting.yml`

### Trigger conditions

- `pull_request` events: `opened`, `reopened`, `ready_for_review`, `synchronize`
- Draft PRs are skipped.

### Behavior

1. Runs `warpdotdev/oz-agent-action@v1` with `skill: pr-review-commenting`.
2. Selects the review model tier from `.github/review-tiers.yml`; changes under `.github/workflows/` and `.github/scripts/` trigger the `ci or automation changes` escalated-review signal.
3. Passes PR URL, number, base/head refs, and SHAs in the prompt context.
4. Uses per-PR concurrency (`oz-pr-review-<pr-number>`) and cancels in-progress runs when new commits are pushed.
5. Posts review feedback as a GitHub PR Review: inline comments for code-level findings whose lines are in the diff, with summary, architecture assessment, and unmapped findings in the review body.

### Setup

- **Required secrets**: `WARP_API_KEY`, `REF_API_KEY`, `EXA_API_KEY`
- **Optional var**: `WARP_AGENT_PROFILE` — Oz agent profile (uses the Oz platform default if unset).
- **Workflow permissions**: `contents: read`, `issues: write`, `pull-requests: write`
- **Conditional secrets** (only required when the PR title or branch name references a Jira ticket key, e.g. `PROJ-123`):
  - `JIRA_API_TOKEN` — Atlassian API token
  - `JIRA_CLOUD_ID` (var) — Atlassian cloud ID used by the `jira-view` helper API path

## Continuous Integration

HyperDispatch includes a standard CI workflow that validates pull requests and main branch pushes.

Workflow file: `.github/workflows/ci.yml`

### Trigger conditions

- `pull_request` events
- `push` to `main`

### Behavior

1. Checks out the repository.
2. Sets up Node.js 20 with npm dependency caching.
3. Runs `npm ci`.
4. Runs `npm run test:coverage` (single test execution with coverage output).
5. Runs `npm run typecheck`.

## Default Worker Skill

The default skill (`.agents/skills/hyperdispatch-worker/SKILL.md`) implements a standard workflow:

1. Parse ticket details from prompt (key, summary, description)
2. Create branch `agent/{ticket-key}-{short-descriptor}` (keep descriptor concise: 2-3 words, 4 max)
3. Investigate the codebase
4. Plan the implementation
5. Configure headless Playwright MCP for automated screenshots (`@playwright/mcp`, isolated Chromium profile, screenshot output directory)
6. Implement (scoped tightly to minimize parallel merge conflicts)
7. If UI files changed, run a screenshot-and-evaluate loop (desktop/mobile captures + accessibility snapshot) with a hard cap of 4 iterations
8. Read `docs/testing.md`, run `npm test` and `npm run test:coverage`, and add/update tests when required by scope
9. Run lint/type checks (including explicit `npm run typecheck`)
10. Commit with `{ticket-key}: {summary}` format + co-author line
11. Create a non-draft PR via `gh pr create` with Jira link in body, plus UI iteration trail for UI-touching tickets
12. Upload final desktop/mobile screenshots to Jira and comment with embedded images for UI-touching tickets
13. Report PR URL via `report_pr` artifact

Projects are expected to customize or replace this skill as needed.
