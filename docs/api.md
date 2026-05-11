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
Required fields: `project_key`, `jira_cloud_id`, `board_id`, `oz_env_id`, `github_repo`.
If any required field is blank, the server returns `400` and re-renders the form with an error message.
When `mcp_servers` is provided, it must be valid JSON object content; malformed input returns `400` with a parse error that includes a line number when available.

### `POST /config/:projectKey`
Update an existing project configuration.
Blank token inputs (`github_pat`, `jira_api_token`, `jira_email`) preserve existing saved tokens.
Column override fields are trimmed and blank values fall back to default Jira mappings.

### `POST /config/:projectKey/delete`
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
- Invalid `repo` format returns `400`.
- `projectKey` is optional and is used to look up a saved per-project token fallback.
- `githubPat` is optional and, when present, is used immediately for discovery.
- GitHub discovery errors return `500` with an `error` message payload.

**Response:**
```json
[
  { "name": "hyperdispatch-worker", "path": ".warp/skills/hyperdispatch-worker/SKILL.md", "spec": "owner/repo:hyperdispatch-worker" },
  { "name": "tdd-worker", "path": ".warp/skills/tdd-worker/SKILL.md", "spec": "owner/repo:tdd-worker" }
]
```

### `GET /config/:projectKey/skills?repo=owner/repo`
Legacy/project-scoped discovery endpoint retained for compatibility.
