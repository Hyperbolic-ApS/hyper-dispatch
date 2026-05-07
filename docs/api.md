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
- `transitionTarget = "To Do"` → dependency check → schedule or block.
- `transitionTarget = "Done"` → re-evaluate any tickets blocked by this issue.
**Response:** `200 OK` (acknowledgement, processing is async).
## Status API
### `GET /api/status`
Returns all tracked dispatch runs as JSON.
**Auth:** Required.
## Configuration API
### `GET /config`
List all configured projects (HTML page). Auth required.
### `GET /config/new`
Form to add a new project (HTML page). Auth required.
### `GET /config/:projectKey`
View/edit form for a project (HTML page). Auth required.
### `POST /config`
Create a new project configuration. Auth required.
### `POST /config/:projectKey`
Update an existing project configuration. Auth required.
### `POST /config/:projectKey/delete`
Deactivate a project configuration. Auth required.
### `GET /config/:projectKey/validate`
Run Jira board validation for a project. Auth required.
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
Discovers skills from current config form values without requiring a saved project.
### `GET /config/:projectKey/skills?repo=owner/repo`
Legacy/project-scoped discovery endpoint retained for compatibility.
