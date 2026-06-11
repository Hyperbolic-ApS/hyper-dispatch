# Dashboard & Config UI

Both the dashboard and configuration UI are server-rendered HTML pages served by the same Hono instance.
Both pages now share the HyperDispatch brand icon (header logo) and include the same favicon for browser tabs.

## Dashboard

**Route**: `GET /dashboard`

Displays all tracked dispatch runs in a table with:
- Ticket key (linked to Jira)
- Project key
- Summary
- Ticket status (live Jira workflow status, e.g. To Do / In Progress / Done)
- Agent status badge (color-coded: green=succeeded, blue=running, yellow=queued, orange=blocked, red=failed)
- Spawned-at timestamp in the viewer's local timezone, rendered as `dd/MM/YY HH:MM`
- Agent runtime (for running/completed entries)
- Branch (`agent/{ticket-key}`) with an inline clipboard icon button that copies the branch name to clipboard (shows a checkmark on success)
- Oz task link labeled `Open` (opens the run task/session in Oz when available)
- PR mergeability badge (`Merge conflicts`, `No conflicts`, or `Unknown` once a PR exists)
- Production deployment badge from Coolify (`Deployed`, `Not deployed`, or `Unknown`) is currently hidden from the dashboard table while feature wiring is retained in code for quick re-enablement
- Session link (clickable, for live runs — opens Oz session)
- PR link with PR number (for completed runs, e.g. `PR #123` when parseable)
  - Non-open PRs include a status suffix in the link text: `(Merged)`, `(Draft)`, or `(Closed)`
- Compact row action menu (`⋮`) on the right side with `Delete` (and a conditional `Force delete` action stacked beneath it)
  - The action popover is allowed to extend beyond table bounds so the actions remain fully visible on the last row, including at non-default browser zoom levels
  - `Delete` is blocked when the run has an open GitHub PR, with an inline error prompting to close the PR first or use `Force delete`
  - `Delete` is allowed when no PR exists or the linked PR is already closed
  - When the PR status cannot be verified (for example a GitHub API error or rate limiting), `Delete` is declined with an accurate inline error that points to `Force delete`; the underlying error is logged server-side. It no longer incorrectly claims the PR is still open.
  - `Force delete` (POST body `force=1`) skips the GitHub PR check entirely and removes the run regardless of PR state, after a browser confirmation prompt. It only deletes the local `dispatch_runs` record; it does not touch the PR or GitHub.
    - It is shown (stacked beneath `Delete`) only for a row whose normal `Delete` was just declined: the failed attempt redirects back with `deleteFailed=<ticket>`, which gates the button. A successful delete or any other navigation clears it.
- Blocked-by info (for blocked entries)
- Header filter toggle to hide/show rows whose Jira ticket status category is `Done`
- Header project dropdown to filter rows by project key (shows `All Projects` by default)
- Clickable status stat tags (`Running`, `Queued`, `Blocked`, `Succeeded`, `Failed`, `Stale`) that apply a status filter to the current dashboard view
  - Clicking a stat tag filters rows by that status
  - Clicking the selected tag again clears the status filter
  - Selected tags use an outline/highlight state so selection is visible independently of each tag color
  - Project filtering is applied first, then status-tag filtering
  - When a selected status has no matching rows, the table shows `no {status} tasks available` (for example, `no stale tasks available`)

Summary stats bar at the top: counts of running / queued / blocked / succeeded / failed / stale.

Auto-refreshes every 15 seconds, and also triggers an immediate refresh when the browser tab becomes active again.

**Data source**: Primarily the `dispatch_runs` table (fast), enriched with live Jira issue status per ticket and Oz run data (runtime, session link) when available.
When Coolify env vars are configured, dashboard rows are further enriched by resolving the PR merge commit and checking whether that commit appears in successful production deployments in Coolify.

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
- Configure optional per-project **Oz API Key** override in the project form
  - Used for all Oz SDK calls for that project (spawn + monitor)
  - Leave blank to use global `WARP_API_KEY`
- Configure optional **MCP Servers JSON** in the project form
  - Must be a valid JSON object
  - Save is blocked for invalid JSON
  - Validation errors include the JSON line number
- New project create validates required fields server-side and re-renders the form with an inline missing-fields error when required values are blank
- Validate Jira board setup

## JSON API

`GET /api/status` provides the same data as the dashboard in JSON format for programmatic access. Supports `project` and `status` query parameter filters.
