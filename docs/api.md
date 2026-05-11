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

## Status API

### `GET /api/status`

Returns all tracked dispatch runs as JSON.

**Query parameters:**
- `project` (optional) — filter by project key.
- `status` (optional) — filter by run status (`blocked`, `queued`, `running`, `succeeded`, `failed`, `stale`).

**Response:**
```json
[
  {
    "ticketKey": "PROJ-123",
    "summary": "Add auth middleware",
    "status": "running",
    "model": "claude-sonnet-4-20250514",
    "runId": "abc-123",
    "prHasConflicts": null,
    "sessionLink": "https://...",
    "spawnedAt": "2025-01-01T12:00:00Z",
    "runtime": "12m"
  }
]
```

## Configuration API

### `GET /config`
List all configured projects (HTML page).

### `GET /config/new`
Form to add a new project (HTML page).

### `GET /config/:projectKey`
View/edit form for a project (HTML page).

### `POST /config`
Create a new project configuration.

Behavior:
- Requires non-empty values for `project_key`, `jira_cloud_id`, `board_id`, `oz_env_id`, and `github_repo`.
- On missing required fields, responds with `400` and re-renders the New Project form including an inline `Missing required fields: ...` error message.
- `mcp_servers` must be valid JSON object input when provided; invalid input returns `400` with a parse message that includes line information when available.

### `PUT /config/:projectKey`
Update an existing project configuration.

### `DELETE /config/:projectKey`
Deactivate a project configuration.

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

**Response:**
```json
[
  { "name": "hyperdispatch-worker", "path": ".warp/skills/hyperdispatch-worker/SKILL.md", "spec": "owner/repo:hyperdispatch-worker" },
  { "name": "tdd-worker", "path": ".warp/skills/tdd-worker/SKILL.md", "spec": "owner/repo:tdd-worker" }
]
```

### `GET /config/:projectKey/skills?repo=owner/repo`
Legacy/project-scoped discovery endpoint retained for compatibility.
