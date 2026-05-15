# API Reference
## Authentication Model
- Protected routes require a session cookie after login:
  - `/dashboard/*`
  - `/config/*`
  - `/api/*`
  - `/auth/account`
  - `/auth/change-password`
- Webhook routes are intentionally unauthenticated so Jira Automation can call them without user credentials.
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
**Auth:** Required.

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
List all configured projects (HTML page). Auth required.
### `GET /config/new`
Form to add a new project (HTML page). Auth required.
### `GET /config/:projectKey`
View/edit form for a project (HTML page). Auth required.
### `POST /config`
Create a new project configuration. Auth required.
If required fields are missing (`project_key`, `jira_cloud_id`, `board_id`, `oz_env_id`, `github_repo`), the server responds with `400` and re-renders the form HTML with an inline error message.

### `PUT /config/:projectKey`
Update an existing project configuration. Auth required.

### `DELETE /config/:projectKey`
Deactivate a project configuration. Auth required.

### `GET /config/:projectKey/validate`
Run Jira board validation for a project. Auth required. Returns pass/fail per check.

### `GET /config/users`
Admin-only user management page.
### `POST /config/users/invite`
Admin-only invite-link creation endpoint. Invite links are one-time use.
### `POST /config/users/:userId/role`
Admin-only endpoint to set role to `admin` or `member`.
### `POST /config/users/:userId/delete`
Admin-only endpoint to remove a user.
## Auth Routes
### `GET /auth/login`
Sign-in page.
### `POST /auth/login`
Authenticates email/password and sets the session cookie.
### `POST /auth/logout`
Clears the session cookie.
### `GET /auth/invite/:token`
Invite-only signup page; returns `410` when invite is invalid or already used.
### `POST /auth/invite/:token`
Creates a member account from invite and consumes invite immediately.
### `GET /auth/account`
Authenticated account page with password change form.
### `POST /auth/change-password`
Authenticated password update action.
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
