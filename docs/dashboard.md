# Dashboard & Config UI

Both the dashboard and configuration UI are server-rendered HTML pages served by the same Hono instance.
Both pages now share the HyperDispatch brand icon (header logo) and include the same favicon for browser tabs.

## Dashboard

**Route**: `GET /dashboard`

Displays one row per tracked ticket entry (latest run shown by default) in a table with:
- Ticket key (linked to Jira)
  - Ticket key text and related dashboard accessibility labels are HTML-escaped before rendering, so malformed persisted keys (for example `HYDI'<img>`) are displayed literally and cannot inject markup into link text or `aria-label` attributes
- Project key
  - Project key text is HTML-escaped before rendering, matching the same Jira-data hardening applied to summary/status/blocked-by fields
- Summary
  - Summary text is HTML-escaped before rendering in the table cell, so Jira-provided markup characters are displayed literally (for example `<img src=x onerror=alert(1)>` becomes text, not executable HTML)
- Ticket status (Jira workflow status, e.g. To Do / In Progress / Done) read from persisted `dispatch_entries.ticket_status_name` / `ticket_status_category` — the dashboard render performs zero live Jira calls regardless of how many runs are tracked
  - Ticket status tokens are rendered as no-wrap badges, so multi-word Jira statuses (for example `In Progress`) stay on one line
  - Ticket status text is HTML-escaped before rendering so Jira-provided names containing markup characters (for example `<Draft>` or `R&amp;D`) are shown as literal text, not interpreted as HTML
- Agent status badge (color-coded: green=succeeded, blue=running, yellow=queued, orange=blocked, red=failed)
  - Agent status tokens are rendered as no-wrap badges, so labels stay on one line in the table
  - Shows the latest run status for that ticket
  - Hovering the status opens a run-history popover listing the most recent run rows for the ticket (newest first, capped per ticket)
  - Clicking a run status badge pins the popover open; outside-click dismisses it
  - Each run-history row has a per-run open-in-new-tab icon when `session_link` is present
  - When a run includes persisted `dispatch_runs.error` text, the Agent Status cell shows a red `!` error token next to the status badge
  - Hovering the token (desktop) or tapping/clicking it (touch/mouse) reveals the escaped error text in an inline tooltip; `Esc` or outside-click closes tapped tooltips
- Spawned-at timestamp in the viewer's local timezone
  - Shows `Now` when the run was spawned within the last minute
  - Shows `Today at HH:MM` for runs spawned earlier on the current day
  - Shows `Yesterday at HH:MM` for runs spawned on the previous day
  - Falls back to `dd/MM/YY HH:MM` for older runs
- Agent runtime (for running/completed entries)
- Branch (`agent/{ticket-key}-{short-descriptor}`) with an inline clipboard icon button that copies the branch name to clipboard (shows a checkmark on success). The descriptor is derived from the ticket summary slug (first three normalized words), matching worker branch creation behavior. When slug normalization yields empty output, branch falls back to `agent/{ticket-key}`.
  - Run-history open links are rendered only for safe protocols (`http://`, `https://`, or root-relative paths). Unsafe protocols (for example `javascript:` / `data:`) are dropped.
  - Safe run-history `href` values are HTML-escaped before rendering, so URLs with query-string separators (for example `?a=1&b=2`) render as well-formed HTML attributes (`&amp;`)
- PR status badge (`Review running`, `Revision running`, or `Review + revision running` when those actions are active; otherwise `Merge conflicts`, `No conflicts`, or `Unknown` once a PR exists) — read from the persisted `pr_review_running` / `pr_revision_running` columns, never from a live GitHub call on render
  - PR status tokens are rendered as no-wrap badges, so long labels (for example `Review + revision running`) do not word-wrap
- Production deployment badge from Coolify (`Deployed`, `Not deployed`, or `Unknown`) is currently hidden from the dashboard table while feature wiring is retained in code for quick re-enablement
  - Production deployment tokens are rendered as no-wrap badges (matching the other status columns) when the column is enabled
- Session link (clickable, for live runs — opens Oz session)
- PR link with PR number (for completed runs, e.g. `PR #123` when parseable)
  - Non-open PRs include a status suffix in the link text: `(Merged)`, `(Draft)`, or `(Closed)` based on persisted `dispatch_runs.pr_display_state`
  - Dashboard render does not poll GitHub for PR display state; it uses DB state captured by the monitor pipeline
  - PR links are rendered only for safe protocols (`http://`, `https://`, or root-relative paths). Unsafe protocols are dropped and the links cell shows `-`.
  - Safe PR-link `href` values are HTML-escaped before rendering to keep attribute escaping consistent with the rest of the dashboard row
- Compact row action menu (`⋮`) on the right side with `Delete` (and a conditional `Force delete` action stacked beneath it)
  - The action popover is allowed to extend beyond table bounds so the actions remain fully visible on the last row, including at non-default browser zoom levels
  - `Delete` is blocked when the run has an open GitHub PR, with an inline error prompting to close the PR first or use `Force delete`
  - `Delete` is allowed when no PR exists or the linked PR is already closed
  - When the PR status cannot be verified (for example a GitHub API error or rate limiting), `Delete` is declined with an accurate inline error that points to `Force delete`; the underlying error is logged server-side. It no longer incorrectly claims the PR is still open.
  - Delete success/error notices render with a dismiss (`×`) control so operators can clear them without navigating away
  - `Force delete` (POST body `force=1`) skips the GitHub PR check entirely and removes the local ticket entry regardless of PR state, after a browser confirmation prompt. Cascading delete removes associated `dispatch_runs` history; no GitHub state is changed.
    - The confirmation prompt message is carried via a `data-confirm-message` attribute and handled by delegated client-side submit logic scoped to row-action menu forms (no inline `onclick` string interpolation with ticket data).
    - Delete-form `action` values use URL-encoded ticket keys.
    - It is shown (stacked beneath `Delete`) only for a row whose normal `Delete` was just declined: the failed attempt redirects back with `deleteFailed=<ticket>`, which gates the button. A successful delete or any other navigation clears it.
- Blocked-by info (for blocked entries)
  - Blocked-by ticket values are HTML-escaped before rendering, so markup-like content is displayed as text instead of interpreted HTML
- Header filter toggle to hide/show rows whose Jira ticket status category is `Done`
- Header project dropdown to filter rows by project key (shows `All Projects` by default)
- Clickable status stat tags (`Running`, `Queued`, `Blocked`, `Succeeded`, `Failed`, `Stale`) that apply a status filter to the current dashboard view
  - Clicking a stat tag filters rows by that status
  - Clicking the selected tag again clears the status filter
  - Selected tags use an outline/highlight state so selection is visible independently of each tag color
  - Project filtering is applied first, then status-tag filtering
  - When a selected status has no matching rows, the table shows `no {status} tasks available` (for example, `no stale tasks available`)

Summary stats bar at the top: counts of running / queued / blocked / succeeded / failed / stale. Counts are computed from ticket-level status (`dispatch_entries` joined through config query helpers) via a grouped SQL query that respects active project and `hideDone` filters; the `Blocked` tile sums both `blocked` and `blocked_cycle`.

### Pagination

Rows are paginated server-side at 50 per page (`DEFAULT_DASHBOARD_PAGE_SIZE`). Filtering (project key, status, `hideDone`) and pagination (`LIMIT`/`OFFSET`) are applied in SQL via `getDispatchRunsPage` + `countDispatchRuns`; each row is a ticket entry joined to its latest run and enriched with run history from `getRunHistoryForTickets` (currently capped to the newest 25 rows per ticket for popover rendering). Latest run fields (`status`, `run_type`, runtime/session/error) come from the newest run row, while PR metadata (`pr_url`, display/action/conflict flags) falls back to the newest PR-bearing run for that ticket so revision runs without new PR artifacts do not hide the existing PR link/status. This keeps memory/render cost bounded as both entries and runs grow. Page controls (`← Prev` / `Page X of Y (N total)` / `Next →`) appear only when the total exceeds one page and preserve current filters in their hrefs. The `?page=N` query parameter is omitted on page 1 for cleaner URLs.

### Refresh model

Auto-refreshes every 15 seconds, and also triggers an immediate refresh when the browser tab becomes active again. The refresh is a client-side `fetch("/dashboard/fragment" + window.location.search)` that swaps the inner `#dashboard-content` only — there is no full-page `<meta http-equiv="refresh">` reload, which keeps scroll position, open row menus, and the filter form state intact, and keeps the door open for a future websocket push that reuses the same fragment endpoint.
After the initial render, transient query params used for one-time feedback (`notice`, `noticeType`, `deleteFailed`) are removed from the URL via `history.replaceState`, so browser refresh does not replay stale delete confirmation/error notices.

**Route**: `GET /dashboard/fragment` returns the same stats + table + pagination block as `GET /dashboard` but without the document shell, so the polling script can drop it straight into `#dashboard-content`.

**Data source**: `dispatch_entries` (ticket row) + latest `dispatch_runs` row for each ticket, plus capped run-history rows from `dispatch_runs` (newest 25 per ticket) for the popover. Ticket-level PR metadata is projected independently from the latest PR-bearing run row, so a later revision run that omits PR artifacts still shows the ticket's current PR link/status in dashboard/API views. The dashboard render (full page and `/fragment` poll) performs zero live GitHub or Jira calls regardless of how many runs or PRs are shown. Ticket status (name + category) is persisted by the scheduler's reconcile loop; PR review/revision action-state is persisted in run rows (`pr_review_running` / `pr_revision_running`) by the monitor. Action-state writes are reconciled per run record (not collapsed per ticket), so multi-run tickets sharing one PR keep the badge state aligned with the latest run row shown on the dashboard. The monitor resolves that action-state from GitHub workflow runs out-of-band, grouped by repo + token (configured project token when present, otherwise the global token), via a bounded fetch (only the newest few pages, since in-flight runs are always the most recent) cached per `owner/repo::token` with a TTL that exceeds both the 15s dashboard poll and the 30s monitor loop — so the previous failure mode of re-paginating a repo's entire workflow history on the render path is gone.
PR link display-state suffixes are read from persisted latest-run fields (`dispatch_runs.pr_display_state`), so dashboard auto-refreshes do not add per-row GitHub PR lookups.
When Coolify env vars are configured and the production-deployment column is enabled, dashboard rows are further enriched by resolving the PR merge commit and checking whether that commit appears in successful production deployments in Coolify. While that column is hidden (the current default), this enrichment is skipped entirely so the auto-refresh does not perform a per-row GitHub PR lookup whose result would not be displayed.

## Config UI

**Routes**: See [api.md](./api.md) for the full route list under Configuration API.

The config UI allows managing project configurations:
- Add/edit/delete projects
- Projects overview (`/config`) shows the **+ New Project** button below the project list table
- Projects overview (`/config`) omits the `Projects` nav link/button since users are already on that page
- Projects overview row actions (Edit/Validate) are rendered as button-style controls with filled backgrounds and borders for clearer affordance
- Project edit page includes a **Delete project** action that removes the project config, ticket entries, and associated run history after confirmation
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
