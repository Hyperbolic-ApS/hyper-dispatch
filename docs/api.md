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

Returns all tracked dispatch runs as JSON, plus status counts.

**Query parameters:**
- `project` (optional) — filter by project key.
- `status` (optional) — filter by run status (`blocked`, `queued`, `running`, `succeeded`, `failed`, `stale`).

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
      "spawned_at": "2025-01-01T12:00:00Z"
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
