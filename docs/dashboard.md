# Dashboard, Auth & Config UI
Dashboard, auth pages, and config pages are server-rendered HTML routes in the same Hono app.
## Authentication
- `GET /dashboard`, all `/config/*` pages, and `/api/*` require login.
- Sessions are cookie-based.
- User account actions are available from:
  - `GET /auth/login`
  - `GET /auth/invite/:token` (invite-only signup)
  - `GET /auth/account` (password changes)
## Dashboard
**Route**: `GET /dashboard`
Displays all tracked dispatch runs in a table with:
- Ticket key (linked to Jira)
- Summary
- Status badge (color-coded by state)
- Agent runtime
- Session link (running)
- PR link (succeeded)
- Blocked-by info (blocked)
Header actions:
- Account page
- Configure Projects
- Sign out
Summary stats show running / queued / blocked / succeeded / failed / stale.
Auto-refreshes every 15 seconds.
## Config UI
**Routes**: see [api.md](./api.md) for all config endpoints.
Features:
- Add/edit/deactivate project configs
- Skill discovery from current in-form repo/token values
- Jira board validation
- Admin-only user management on `GET /config/users`:
  - Create one-time invite links
  - Change user role between `member` and `admin`
  - Remove users
## JSON API
`GET /api/status` provides dashboard run data as JSON for authenticated clients.
