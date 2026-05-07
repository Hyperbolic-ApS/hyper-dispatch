# Dashboard & Config UI

Both the dashboard and configuration UI are server-rendered HTML pages served by the same Hono instance.
Both pages now share the HyperDispatch brand icon (header logo) and include the same favicon for browser tabs.

## Dashboard

**Route**: `GET /dashboard`

Displays all tracked dispatch runs in a table with:
- Ticket key (linked to Jira)
- Summary
- Ticket status (live Jira workflow status, e.g. To Do / In Progress / Done)
- Status badge (color-coded: green=succeeded, blue=running, yellow=queued, orange=blocked, red=failed)
- Agent runtime (for running/completed entries)
- Branch (`agent/{ticket-key}`)
- Oz task link (opens the run task/session in Oz when available)
- Session link (clickable, for live runs — opens Oz session)
- PR link (for completed runs)
- Blocked-by info (for blocked entries)

Summary stats bar at the top: counts of running / queued / blocked / succeeded / failed.

Auto-refreshes every 15 seconds.

**Data source**: Primarily the `dispatch_runs` table (fast), enriched with live Jira issue status per ticket and Oz run data (runtime, session link) when available.

## Config UI

**Routes**: See [api.md](./api.md) for the full route list under Configuration API.

The config UI allows managing project configurations:
- Add/edit/deactivate projects
- Projects overview (`/config`) shows the **+ New Project** button below the project list table
- Projects overview (`/config`) omits the `Projects` nav link/button since users are already on that page
- Projects overview row actions (Edit/Validate) are rendered as button-style controls with filled backgrounds and borders for clearer affordance
- Select skills from the GitHub repo (dynamic dropdown)
  - Discovery uses the current in-form `GitHub Repo` value immediately (no save required)
  - If entered, the current in-form `GitHub PAT` is used for discovery before save
- Set default model and model override field
- Validate Jira board setup

## JSON API

`GET /api/status` provides the same data as the dashboard in JSON format for programmatic access. Supports `project` and `status` query parameter filters.
