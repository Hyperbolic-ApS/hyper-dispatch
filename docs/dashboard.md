# Dashboard & Config UI

Both the dashboard and configuration UI are server-rendered HTML pages served by the same Hono instance.

## Dashboard

**Route**: `GET /dashboard`

Displays all tracked dispatch runs in a table with:
- Ticket key (linked to Jira)
- Summary
- Status badge (color-coded: green=succeeded, blue=running, yellow=queued, orange=blocked, red=failed)
- Model used
- Agent runtime (for running/completed entries)
- Session link (clickable, for live runs — opens Oz session)
- PR link (for completed runs)
- Blocked-by info (for blocked entries)

Summary stats bar at the top: counts of running / queued / blocked / succeeded / failed.

Auto-refreshes every 15 seconds.

**Data source**: Primarily the `dispatch_runs` table (fast). For `running` entries, enriched with live Oz run data (runtime, session link) from the Oz API.

## Config UI

**Routes**: See [api.md](./api.md) for the full route list under Configuration API.

The config UI allows managing project configurations:
- Add/edit/deactivate projects
- Select skills from the GitHub repo (dynamic dropdown)
- Set default model and model override field
- Validate Jira board setup

## JSON API

`GET /api/status` provides the same data as the dashboard in JSON format for programmatic access. Supports `project` and `status` query parameter filters.
