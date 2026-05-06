# HyperDispatch

A deterministic orchestration service that receives Jira webhook events, spawns Oz cloud agents for eligible tickets (respecting dependencies), tracks progress, and produces PRs. Deployed on Coolify.

## Architecture

```
[Jira Automation webhook] → [HyperDispatch Service]
                                ├── POST /webhook/jira (receives status changes)
                                ├── Dependency Resolver (checks issue links)
                                ├── Scheduler (concurrency cap, dedup)
                                ├── Agent Spawner → Oz SDK → cloud agents
                                ├── Run Monitor (polls Oz, updates Jira + state)
                                ├── State Store → PostgreSQL
                                ├── GET /api/status (JSON)
                                └── GET /dashboard (server-rendered HTML)
```

Oz is used purely for execution (autonomous coding). All orchestration logic is deterministic TypeScript — no LLM involved in dispatch decisions.

## Components

### 1. Jira Webhook Receiver

Endpoint: `POST /webhook/jira`

A **single global Jira Automation rule** covers all projects: "When any issue transitions → send webhook to HyperDispatch." HyperDispatch filters by project key against configured projects.

On receipt:
1. Look up project config by project key. If not configured or not active → ignore.
2. If transition target is "To Do" → fetch full issue details (including `issuelinks`), run dependency resolution, hand to scheduler or record as `blocked`.
3. If transition target is "Done" → check state store for any tickets `blocked` by this issue, re-evaluate their eligibility, dispatch any that are now unblocked.

Jira Automation setup (one-time, global):
- Trigger: "Issue transitioned" (all projects)
- Action: "Send web request" → POST to `https://<hyperdispatch-host>/webhook/jira`
- Body: `{{issue.key}}`, `{{issue.fields.project.key}}`, `{{transition.to_status.name}}`

This means one automation rule serves all projects. HyperDispatch decides what to do based on its project config table.

### 2. Dependency Resolver

Before a ticket is eligible for agent dispatch:
- Read the ticket's `issuelinks` from the Jira REST API response.
- Filter for blocking relationships (link type "is blocked by").
- For each blocker, check if its status category is "Done".
- A ticket is **eligible** only if ALL its blockers are resolved.
- **Cycle detection**: walk the dependency graph; if a cycle is found, mark all tickets in the cycle as `blocked_cycle` in the state store (requires manual intervention).

Pseudocode:
```typescript
async function isEligible(issueKey: string): Promise<{ eligible: boolean; blockedBy?: string[] }> {
  const issue = await jira.getIssue(issueKey, ['issuelinks', 'status']);
  const blockers: string[] = [];
  for (const link of issue.fields.issuelinks) {
    if (link.type.inward === 'is blocked by' && link.inwardIssue) {
      const blocker = await jira.getIssue(link.inwardIssue.key, ['status']);
      if (blocker.fields.status.statusCategory.key !== 'done') {
        blockers.push(link.inwardIssue.key);
      }
    }
  }
  return { eligible: blockers.length === 0, blockedBy: blockers };
}
```

### 3. Scheduler

Enforces dispatch policies:
- **Concurrency cap**: `MAX_CONCURRENT_AGENTS` env var, default `4`. Before spawning, count active runs in state store. If at cap, queue the ticket (status = `queued`).
- **Priority**: Jira priority field. Higher priority tickets are dispatched first from the queue.
- **Dedup**: if a ticket already has an active or queued entry in the state store, skip.
- **No retries in v1**: if an agent fails, the ticket is marked `failed` in the state store and left for manual review. Alerting to be added later.

A background loop (e.g., every 30s) processes the queue: checks if concurrency has freed up, dispatches next eligible queued ticket.

### 4. Agent Spawner

Uses the `oz-agent-sdk` TypeScript SDK to create a run:
- `name`: Jira ticket key (e.g., `PROJ-123`) — enables lookup via `client.agent.runs.list({ config_name: 'PROJ-123' })`.
- `environment_id`: from the project config.
- `model_id`: **per-ticket model override** takes precedence. The spawner reads the Jira custom field (configured as `model_field_id` in project config). If the field has a value, use it. Otherwise fall back to the project's `default_model`. If neither is set, omit (Oz default).
- `skill`: from the project config `skills` array. If multiple skills are configured, they are all passed.
- `prompt`: constructed from the Jira ticket — key, summary, description, acceptance criteria.

After spawning:
- Record `{ ticketKey, runId, status: 'running', spawnedAt, model }` in state store.
- Transition Jira ticket to "In Progress" via Jira REST API.

### 5. Run Monitor

Background loop (every 30s) that polls Oz for all active runs:
- `SUCCEEDED` → update state store (`status: 'succeeded'`, `completedAt`, `prUrl` from run artifacts). Transition Jira ticket to "In Review".
- `FAILED` → update state store (`status: 'failed'`, `error` from run details). Leave Jira ticket in "In Progress" (manual triage). Alerting placeholder for later.
- `INPROGRESS` → check for staleness. If running > `MAX_RUN_DURATION_HOURS` env var (default 2), mark as `stale` and cancel the run.

### 6. State Store (PostgreSQL)

```sql
CREATE TABLE project_configs (
  project_key    TEXT PRIMARY KEY,       -- e.g., "PROJ"
  jira_cloud_id  TEXT NOT NULL,          -- Jira cloud site ID (for API calls)
  board_id       INTEGER NOT NULL,       -- for board validation
  oz_env_id      TEXT NOT NULL,          -- Oz environment ID
  github_repo    TEXT NOT NULL,          -- e.g., "org/mono-repo"
  default_model  TEXT,                   -- default LLM model ID (null = Oz default)
  model_field_id TEXT,                   -- Jira custom field ID for per-ticket model override (e.g., "customfield_10050")
  skills         TEXT[] NOT NULL,        -- skill specs (e.g., ["org/repo:hyperdispatch-worker"])
  active         BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE dispatch_runs (
  ticket_key     TEXT PRIMARY KEY,       -- e.g., "PROJ-123"
  project_key    TEXT NOT NULL REFERENCES project_configs(project_key),
  summary        TEXT,
  run_id         TEXT,                   -- Oz run ID (null if blocked/queued)
  status         TEXT NOT NULL,          -- blocked | queued | running | succeeded | failed | stale
  blocked_by     TEXT[],                 -- blocking ticket keys
  model          TEXT,                   -- model used for this run
  priority       INTEGER DEFAULT 0,
  spawned_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  pr_url         TEXT,
  session_link   TEXT,
  error          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_status ON dispatch_runs(status);
CREATE INDEX idx_project ON dispatch_runs(project_key);
```

`project_configs` stores per-project configuration (managed via the config UI). `dispatch_runs` tracks ticket→agent state (managed by the orchestration loop). Both serve the dashboard.

### 7. Dashboard

Minimal server-rendered HTML page at `GET /dashboard`.

Data source: primarily the state store (fast), enriched with live Oz run data for `running` entries only.

Displays:
- Table of all tracked tickets with: ticket key (linked to Jira), summary, status badge, agent runtime, session link (for live runs), PR link (for completed runs), blocked-by info.
- Summary stats: running / queued / blocked / succeeded / failed counts.
- Auto-refreshes every 15s.

JSON API at `GET /api/status` for programmatic access.

### 8. Configuration UI

Server-rendered HTML pages for managing project configurations.

Routes:
- `GET /config` — list all configured projects (table with status badges, edit/validate links)
- `GET /config/new` — form to add a new project
- `GET /config/:projectKey` — view/edit form for a project
- `POST /config` — create a project config
- `PUT /config/:projectKey` — update a project config
- `DELETE /config/:projectKey` — deactivate a project

Form fields:
- Jira project key, cloud ID, board ID
- Oz environment ID
- GitHub repo (owner/repo)
- Default model (dropdown, populated from `warp model list` or hardcoded known models)
- Model override field (Jira custom field ID — user enters the field ID, e.g., `customfield_10050`)
- Skills (multi-select dropdown, populated dynamically — see below)
- Active toggle

**Skill selection**: when the user enters/changes the GitHub repo field, HyperDispatch calls the GitHub API (`GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`) to find all `SKILL.md` files under `.warp/skills/`, `.agents/skills/`, `.claude/skills/`, `.codex/skills/`. The skill name is derived from the parent directory name. Displayed as a multi-select dropdown. Stored as skill specs (e.g., `org/repo:skill-name`).

### 9. Jira Project Validator

Endpoint: `POST /config/:projectKey/validate`

Called from the config UI ("Validate" button). Checks:

**Board columns** — calls `GET /rest/agile/1.0/board/{boardId}/configuration` and verifies that `columnConfig.columns` contains at least: Backlog, To Do, In Progress, In Review, Done. Additional columns are allowed and ignored. Reports missing columns.

**Custom fields** — if `model_field_id` is set, calls `GET /rest/api/3/field` and verifies the field exists. Reports if missing.

**Workflow transitions** — calls `GET /rest/api/3/status` and verifies the project's workflow includes the statuses mapped to the required columns.

Returns a validation result with pass/fail per check and actionable error messages (e.g., "Missing column 'In Review' — add it in Jira board settings"). Note: the Jira API is read-only for board configuration, so HyperDispatch cannot auto-create columns.

### 10. PR Review Feedback Loop (GitHub Action)

A GitHub Action in the target mono-repo, triggered on `pull_request_review` with `changes_requested`:
1. Extract the ticket key from the PR branch name (`agent/PROJ-123`).
2. Construct a prompt that includes the review comments.
3. Spawn a new Oz agent run via the Oz SDK (or call HyperDispatch's API to do so).
4. Update the state store.

This is a separate component from HyperDispatch itself — it lives in the target repo as `.github/workflows/agent-revision.yml`.

## Worker Agent Design

Each worker agent receives a prompt constructed from the Jira ticket (key, summary, description, acceptance criteria) and the skill(s) selected in the project config.

The **skill defines the agent's workflow**. Different projects can use different skills — e.g., one project might use a strict TDD skill while another uses a simpler implement-and-PR skill. The skill is selected per-project in the config UI from skills discovered in the GitHub repo.

HyperDispatch is not opinionated about what the skill does, but it does expect two things from the agent run:
1. **A PR is created** — the agent must create a PR and output the URL (HyperDispatch extracts it from run artifacts to update state and Jira).
2. **Branch naming convention** — `agent/{ticket-key}` (e.g., `agent/PROJ-123`), so the PR review feedback loop GitHub Action can extract the ticket key.

Everything else (planning, implementation approach, testing strategy, commit style) is the skill's responsibility.

### Default Worker Skill

We provide a default skill (`.warp/skills/hyperdispatch-worker/SKILL.md`) that can be added to any target repo. It implements:
1. Read the ticket details from the prompt.
2. Create branch `agent/{ticket-key}`.
3. Investigate the codebase.
4. Plan the implementation.
5. Implement, scoping changes to the ticket's area (minimize merge conflicts with parallel agents).
6. Run tests. If tests fail, iterate.
7. Run linting/type checks.
8. Commit: `{ticket-key}: {summary}\n\nCo-Authored-By: Oz <oz-agent@warp.dev>`
9. Create PR via `gh pr create` — title: `{ticket-key}: {summary}`, body includes Jira link.
10. Output the PR URL as a run artifact via `report_pr`.

This is a starting point. Projects are expected to fork/customize this skill or use entirely different skills as needed.

## Project Configuration

### Environment Variables

```
# Jira
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_EMAIL=service-account@example.com
JIRA_API_TOKEN=<token>

# Oz
WARP_API_KEY=<key>

# PostgreSQL
DATABASE_URL=postgresql://user:pass@host:5432/hyperdispatch

# GitHub (for skill discovery and PR feedback loop)
GITHUB_TOKEN=<token>

# Orchestration
MAX_CONCURRENT_AGENTS=4       # default concurrency cap
MAX_RUN_DURATION_HOURS=2
PORT=3000
```

All per-project settings (Oz environment, model, skills, board ID, etc.) are stored in the `project_configs` DB table and managed via the config UI. No env vars needed per project.

## Tech Stack

- **Language**: TypeScript (Node.js)
- **HTTP framework**: Hono (lightweight, fast)
- **Oz integration**: `oz-agent-sdk`
- **Jira integration**: Direct REST API v3 calls via `fetch`
- **Jira Agile**: `/rest/agile/1.0/board/{id}/configuration` for board validation
- **GitHub integration**: Octokit (`@octokit/rest`) for skill discovery from repos
- **State store**: PostgreSQL via `postgres` (porsager/postgres — lightweight, modern)
- **Dashboard + Config UI**: Server-rendered HTML (Hono JSX or html helper)
- **Deployment**: Dockerfile → Coolify
- **Worker skill**: `.warp/skills/hyperdispatch-worker/SKILL.md` in the target mono-repo

## Dockerfile

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

Build step (in CI or Coolify build command): `npm run build` to compile TypeScript → `dist/`.
