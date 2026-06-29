# API Reference

## Webhook

### `POST /webhook/jira`

Receives Jira Automation webhook payloads on issue transitions.

**Request body:**
```json
{
  "issueKey": "PROJ-123",
  "projectKey": "PROJ",
  "transitionTarget": "To Do"
}
```

**Behavior:**
- Looks up `projectKey` in `project_configs`. Ignores if not configured or inactive.
- `transitionTarget = {to_do_column_name}` for that project → dependency check → schedule or block.
- `transitionTarget = {done_column_name}` for that project → re-evaluate any tickets blocked by this issue.

**Response:** `200 OK` (acknowledgement, processing is async).

### `POST /webhook/github`
Receives signed GitHub webhook payloads for PR state updates and revision triggers.

**Headers:**
- `X-GitHub-Event` (required): event type (`ping`, `pull_request`, etc.)
- `X-Hub-Signature-256` (required): `sha256=<hex>` signature of the raw request body

**Behavior:**
- Requires `GITHUB_WEBHOOK_SECRET` to be configured; if missing, responds `503` (fail closed).
- Verifies the `X-Hub-Signature-256` HMAC-SHA256 signature against the raw request body.
- Invalid or missing signature returns `401`.
- `ping` events return `200` with `{ "action": "pong" }`.
- `pull_request` events:
  - Reads `pull_request.html_url`
  - Looks up matching runs via `pr_url`
  - Derives `pr_display_state` as:
    - `merged_at` present → `merged`
    - `state === "open"` and `draft === true` → `draft`
    - `state === "open"` → `open`
    - otherwise → `closed`
  - Persists `pr_display_state` for all matching runs.
  - If no runs are found, returns `200` ignored.
  - Draft PRs are not marked ready-for-review here; that is the monitor's job (see below). The `opened` event fires before a run's `pr_url` is persisted, so it cannot reliably match the run.
- `pull_request_review` events:
  - Only `action = submitted` is revision-eligible.
  - Resolves tracked run/project context from PR URL + branch naming (`agent/{ticket-key}[-suffix]`). If the branch does not match that convention, the PR can still opt in: when any PR comment contains the `/auto-revise` marker, the tracked run's own ticket key is used instead.
  - Collects submitted review feedback and inline comments.
  - Detects actionable review items using `REV-###` references/action-list entries.
  - Spawns a revision Oz run only when action items exist.
- `issue_comment` events:
  - Only `action = created` is considered.
  - Comment must contain `/revise`.
  - Still reads ticket context, but passes only explicit `/revise ...` instructions as revision feedback.
- `pull_request_review_comment` events:
  - Ignored for spawning (including thread replies) to avoid duplicate revision runs from inline-comment/subcomment activity.
- Revision spawns are idempotent and serialized:
  - The triggering review/comment id is recorded in `revision_events`, so redelivered webhooks (GitHub retries) do not spawn duplicate runs (returns `200` ignored).
  - A revision is skipped (`200` ignored) when one is already running for the same PR branch, preventing overlapping revision agents from rapid successive reviews.
- Webhook updates are complemented by the monitor loop fallback:
  - Every monitor cycle (30s), succeeded runs with a persisted `pr_url` refresh GitHub PR metadata.
  - The monitor persists both `pr_has_conflicts` and `pr_display_state`, which backfills historical succeeded runs and reconciles missed webhook deliveries/drift.
  - If a tracked, succeeded run's PR is still a draft, the monitor marks it ready-for-review via the GitHub GraphQL `markPullRequestReadyForReview` mutation (keyed by the PR's `node_id`) and persists `pr_display_state: "open"`. This is the authoritative draft→open path: it runs only after `pr_url` is recorded, so it does not depend on webhook timing. GitHub's REST "update a pull request" endpoint cannot change a PR's draft state, so GraphQL is required.

**Response:** `200 OK` for accepted/ignored GitHub events. For accepted tracked PR events, includes:
- `action`
- `pr_url`
- `pr_display_state`
- `run_count`

## Status API

### `GET /api/status`

Returns all tracked ticket entries as JSON, each enriched with latest-run fields and recent run history (newest first, currently capped to 25 rows per ticket), plus status counts.

**Response:**
```json
{
  "runs": [
    {
      "ticket_key": "PROJ-123",
      "summary": "Add auth middleware",
      "status": "running",
      "model": "claude-sonnet-4-20250514",
      "run_id": "abc-123",
      "pr_has_conflicts": null,
      "deployed_to_prod": false,
      "session_link": "https://...",
      "spawned_at": "2025-01-01T12:00:00Z",
      "runs": [
        {
          "id": "2f0f13ab-0133-4756-b436-8de8f363cb36",
          "ticket_key": "PROJ-123",
          "run_type": "implementation",
          "run_id": "abc-123",
          "status": "succeeded",
          "session_link": "https://...",
          "created_at": "2025-01-01T12:00:00Z"
        },
        {
          "id": "7e4cd151-c0f5-46f4-98f5-a2f5f507f5ad",
          "ticket_key": "PROJ-123",
          "run_type": "revision",
          "run_id": "def-456",
          "status": "running",
          "session_link": "https://...",
          "created_at": "2025-01-01T14:30:00Z"
        }
      ]
    }
  ],
  "counts": {
    "running": 1,
    "queued": 0,
    "blocked": 0,
    "succeeded": 0,
    "failed": 0,
    "stale": 0
  }
}
```

`deployed_to_prod` values:
- `true`: PR merge commit is present in successful production deployments in Coolify.
- `false`: not deployed to production yet (or no PR available).
- `null`: deployment status could not be determined (for example, missing Coolify config or lookup error).

## Dashboard Actions (HTML)

### `POST /dashboard/:ticketKey/resync`

Resyncs a single dashboard row from the current Oz run state using the stored `dispatch_runs.run_id`.

**Form body (optional):**
- `project`
- `hideDone`
- `status`

These filter parameters are used only to preserve the current dashboard view in the redirect URL.

**Behavior:**
- Loads the tracked row by `ticketKey` from `dispatch_runs`.
- If the row is missing, redirects with an error notice.
- If the row has no `run_id`, redirects with an error notice (nothing to query in Oz).
- Retrieves the Oz run and maps Oz state → local status:
  - `SUCCEEDED` → `succeeded`
  - `FAILED` / `ERROR` → `failed`
  - `CANCELLED` → `stale`
  - `QUEUED` / `PENDING` / `CLAIMED` / `INPROGRESS` / `BLOCKED` (or unknown) → `running`
- When mapping to `running`, clears stale `completed_at` and `error`.
- Persists `session_link` from Oz when available.

**Response:** `302` redirect to `/dashboard?...` with `noticeType`/`notice` query params.

## Configuration API

### `GET /config`
List all configured projects (HTML page).

### `GET /config/new`
Form to add a new project (HTML page).

### `GET /config/:projectKey`
View/edit form for a project (HTML page).

### `POST /config`
Create a new project configuration.
If required fields are missing (`project_key`, `jira_cloud_id`, `board_id`, `oz_env_id`, `github_repo`), the server responds with `400` and re-renders the form HTML with an inline error message.

### `PUT /config/:projectKey`
Update an existing project configuration.

### `POST /config/:projectKey/delete`
Delete a project configuration and its associated `dispatch_entries` + `dispatch_runs` history. Both deletions run in a single transaction, so a partial failure rolls back atomically (history is never removed while the config row remains). Returns `404` (HTML) when the project does not exist; otherwise redirects (`302`) back to `/config`.

### `GET /config/:projectKey/validate`
Run Jira board validation for a project. Returns pass/fail per check.

## Skill Discovery API

### `POST /config/skills`
Discovers skills from the current config form values without requiring a saved project.

**Request body:**
```json
{
  "repo": "owner/repo",
  "projectKey": "PROJ",
  "githubPat": "ghp_xxx"
}
```

Notes:
- `repo` is required.
- `projectKey` is optional and is used to look up a saved per-project token fallback.
- `githubPat` is optional and, when present, is used immediately for discovery.
- Returns `400` for malformed JSON payloads or invalid `repo` format.
- Propagates upstream GitHub status codes when available (for example, `404` for missing repositories).

**Response:**
```json
[
  { "name": "hyperdispatch-worker", "path": ".warp/skills/hyperdispatch-worker/SKILL.md", "spec": "owner/repo:hyperdispatch-worker" },
  { "name": "tdd-worker", "path": ".warp/skills/tdd-worker/SKILL.md", "spec": "owner/repo:tdd-worker" }
]
```

### `GET /config/:projectKey/skills?repo=owner/repo`
Legacy/project-scoped discovery endpoint retained for compatibility.
