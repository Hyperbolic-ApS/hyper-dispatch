import { Hono } from "hono";
import {
  getAllDispatchRuns,
  getDispatchRunsPage,
  countDispatchRuns,
  getStatusCounts,
  getDistinctRunProjectKeys,
  listProjectConfigs,
  DEFAULT_DASHBOARD_PAGE_SIZE,
  type DispatchRunFilter,
} from "../db/config-queries.js";
import { deleteRun } from "../db/queries.js";
import { env } from "../config/env.js";
import { resolveProjectTokens } from "../config/env.js";
import { brandIconSvg, faviconDataUri } from "./branding.js";
import {
  annotateRunsWithProdDeploymentStatus,
  type RunWithProdDeployment,
} from "../coolify/prod-deployment.js";
import {
  getPullRequestState,
  parseGithubPullRequestUrl,
} from "../github/pull-requests.js";
import { buildAgentBranchName } from "../orchestration/branch-name.js";

export const dashboardRouter = new Hono();
const spawnedAtDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const spawnedAtTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatDuration(start: Date | null, end: Date | null): string {
  if (!start) return "-";
  const endTime = end ?? new Date();
  const ms = endTime.getTime() - start.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatSpawnedAtDate(d: Date | null): string {
  if (!d) return "-";
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs >= 0 && diffMs < 60_000) {
    return "Now";
  }
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const spawnedAtMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round(
    (nowMidnight.getTime() - spawnedAtMidnight.getTime()) / 86_400_000
  );
  if (dayDiff === 0) {
    return `Today at ${spawnedAtTimeFormatter.format(d)}`;
  }
  if (dayDiff === 1) {
    return `Yesterday at ${spawnedAtTimeFormatter.format(d)}`;
  }
  const parts = spawnedAtDateTimeFormatter.formatToParts(d);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("day")}/${values.get("month")}/${values.get("year")} ${values.get("hour")}:${values.get("minute")}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const dashboardStatusFilterOptions = [
  { key: "running", label: "Running", style: "background:#3b82f6;color:#fff", statuses: ["running"] },
  { key: "queued", label: "Queued", style: "background:#eab308;color:#000", statuses: ["queued"] },
  {
    key: "blocked",
    label: "Blocked",
    style: "background:#f97316;color:#fff",
    statuses: ["blocked", "blocked_cycle"],
  },
  { key: "succeeded", label: "Succeeded", style: "background:#22c55e;color:#fff", statuses: ["succeeded"] },
  { key: "failed", label: "Failed", style: "background:#ef4444;color:#fff", statuses: ["failed"] },
  { key: "stale", label: "Stale", style: "background:#6b7280;color:#fff", statuses: ["stale"] },
] as const;
type DashboardStatusFilterKey = (typeof dashboardStatusFilterOptions)[number]["key"];

const dashboardStatusFilterKeys = new Set<DashboardStatusFilterKey>(
  dashboardStatusFilterOptions.map((option) => option.key)
);
const dashboardStatusesByFilterKey = new Map<DashboardStatusFilterKey, Set<string>>(
  dashboardStatusFilterOptions.map((option) => [option.key, new Set<string>(option.statuses)])
);

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    running: "background:#3b82f6;color:#fff",
    queued: "background:#eab308;color:#000",
    blocked: "background:#f97316;color:#fff",
    blocked_cycle: "background:#dc2626;color:#fff",
    succeeded: "background:#22c55e;color:#fff",
    failed: "background:#ef4444;color:#fff",
    stale: "background:#6b7280;color:#fff",
  };
  const style = colors[status] ?? "background:#e5e7eb;color:#000";
  return `<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;display:inline-flex;align-items:center;white-space:nowrap;${style}">${status}</span>`;
}
function ticketStatusBadge(statusName: string | null, categoryKey: string | null): string {
  if (!statusName) return "-";
  const colors: Record<string, string> = {
    done: "background:#22c55e;color:#fff",
    "in-flight": "background:#3b82f6;color:#fff",
    "new": "background:#eab308;color:#000",
  };
  const style = colors[categoryKey ?? ""] ?? "background:#e5e7eb;color:#000";
  return `<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;${style}">${statusName}</span>`;
}
function prConflictBadge(hasConflicts: boolean | null, hasPr: boolean): string {
  if (!hasPr) return "-";
  if (hasConflicts === true) {
    return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;display:inline-flex;align-items:center;white-space:nowrap;background:#ef4444;color:#fff">Merge conflicts</span>';
  }
  if (hasConflicts === false) {
    return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;display:inline-flex;align-items:center;white-space:nowrap;background:#22c55e;color:#fff">No conflicts</span>';
  }
  return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;display:inline-flex;align-items:center;white-space:nowrap;background:#e5e7eb;color:#111">Unknown</span>';
}
type PrActionState = {
  reviewRunning: boolean;
  revisionRunning: boolean;
};

function prStatusBadge(
  hasConflicts: boolean | null,
  hasPr: boolean,
  actionState: PrActionState | null
): string {
  if (!hasPr) return "-";
  if (actionState?.reviewRunning && actionState?.revisionRunning) {
    return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;display:inline-flex;align-items:center;white-space:nowrap;background:#7c3aed;color:#fff">Review + revision running</span>';
  }
  if (actionState?.reviewRunning) {
    return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;display:inline-flex;align-items:center;white-space:nowrap;background:#2563eb;color:#fff">Review running</span>';
  }
  if (actionState?.revisionRunning) {
    return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;display:inline-flex;align-items:center;white-space:nowrap;background:#ea580c;color:#fff">Revision running</span>';
  }
  return prConflictBadge(hasConflicts, hasPr);
}

function prodDeploymentBadge(deployedToProd: boolean | null): string {
  if (deployedToProd === true) {
    return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;background:#22c55e;color:#fff">Deployed</span>';
  }
  if (deployedToProd === false) {
    return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;background:#f97316;color:#fff">Not deployed</span>';
  }
  return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;background:#e5e7eb;color:#111">Unknown</span>';
}

const showProdDeploymentColumn = false;

// Build the `?…` suffix for a URL that will be interpolated into an HTML
// `href` attribute. Escapes `&` to `&amp;` so the resulting markup is
// well-formed (no entity-reference ambiguity for strict parsers / SAX flows).
function buildHrefSuffix(params: URLSearchParams): string {
  if (params.size === 0) return "";
  return `?${params.toString().replace(/&/g, "&amp;")}`;
}

function buildDashboardRedirect(
  filters: { project?: string | null; hideDone?: string | null; status?: string | null },
  notice: { type: "success" | "error"; message: string },
  options?: { deleteFailed?: string | null }
): string {
  const params = new URLSearchParams();
  if (filters.project) params.set("project", filters.project);
  if (filters.hideDone === "1") params.set("hideDone", "1");
  if (filters.status) params.set("status", filters.status);
  params.set("noticeType", notice.type);
  params.set("notice", notice.message);
  // Marks which run's normal delete was just declined, so the dashboard can
  // surface a Force delete affordance for that row only.
  if (options?.deleteFailed) params.set("deleteFailed", options.deleteFailed);
  return `/dashboard?${params.toString()}`;
}

const CSS = `
  body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #f9fafb; color: #111; }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; gap: 16px; }
  .header-left { display: flex; align-items: center; gap: 12px; }
  .header-actions { display: flex; align-items: center; gap: 8px; }
  .header-filter-form { display: inline-flex; align-items: center; gap: 8px; margin: 0; }
  .filter-label { font-size: 0.875rem; color: #374151; font-weight: 500; }
  .filter-select { border: 1px solid #d1d5db; border-radius: 6px; padding: 6px 8px; font-size: 0.875rem; background: #fff; color: #111827; min-width: 160px; }
  .brand-logo { width: 34px; height: 34px; flex: 0 0 auto; display: inline-flex; }
  .header h1 { margin: 0; }
  h1 { margin: 0 0 16px; font-size: 1.4rem; }
  .btn { display: inline-block; padding: 8px 18px; border-radius: 6px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; text-decoration: none; }
  .btn-secondary { background: #e5e7eb; color: #111; }
  .btn-secondary:hover { background: #d1d5db; }
  .stats { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat { padding: 10px 16px; border-radius: 6px; font-weight: 600; font-size: 0.9rem; }
  .stat-link { border: none; text-decoration: none; display: inline-flex; align-items: center; }
  .stat-link:hover { text-decoration: none; filter: brightness(0.95); }
  .stat-selected { box-shadow: inset 0 0 0 2px #fff; outline: 2px solid #111827; outline-offset: 2px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th { background: #f3f4f6; text-align: left; padding: 10px 12px; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; }
  td { padding: 10px 12px; border-bottom: 1px solid #f3f4f6; font-size: 0.875rem; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  a { color: #3b82f6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .blocked-by { font-size: 0.75rem; color: #6b7280; }
  .branch-cell { display: inline-flex; align-items: center; gap: 8px; }
  .copy-branch-btn { border: 1px solid #d1d5db; background: #fff; color: #374151; border-radius: 6px; padding: 3px 5px; line-height: 0; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .copy-branch-btn:hover { background: #f9fafb; }
  .copy-branch-btn.copied { background: #dcfce7; border-color: #86efac; color: #166534; }
  .notice { margin-bottom: 12px; padding: 10px 12px; border-radius: 6px; font-size: 0.875rem; font-weight: 500; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .notice-message { flex: 1 1 auto; }
  .notice-dismiss { border: none; background: transparent; color: inherit; width: 20px; height: 20px; border-radius: 999px; font-size: 16px; line-height: 1; cursor: pointer; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
  .notice-dismiss:hover { background: rgba(0, 0, 0, 0.08); }
  .notice-success { background: #dcfce7; color: #166534; border: 1px solid #86efac; }
  .notice-error { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
  .row-actions-cell { text-align: right; white-space: nowrap; position: relative; width: 1%; }
  .row-menu { position: relative; display: inline-flex; }
  .row-menu-btn { width: 22px; height: 22px; border: 1px solid #d1d5db; border-radius: 999px; background: #fff; color: #111827; font-size: 14px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; }
  .row-menu-btn:hover { background: #f9fafb; }
  .row-menu-list { display: none; position: absolute; right: 0; top: calc(100% + 4px); min-width: 90px; background: #fff; border: 1px solid #d1d5db; border-radius: 6px; box-shadow: 0 8px 20px rgba(0,0,0,0.08); z-index: 20; padding: 4px; }
  .row-menu.open .row-menu-list { display: block; }
  .row-menu-delete { display: block; width: 100%; border: none; background: transparent; color: #b91c1c; text-align: left; border-radius: 4px; font-size: 0.8rem; padding: 6px 8px; cursor: pointer; }
  .row-menu-delete:hover { background: #fee2e2; }
  .pagination { display: flex; align-items: center; gap: 12px; margin-top: 16px; font-size: 0.875rem; color: #374151; }
  .pagination a { padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; color: #111827; }
  .pagination a:hover { background: #f9fafb; text-decoration: none; }
  .pagination .disabled { padding: 6px 12px; border: 1px solid #e5e7eb; border-radius: 6px; color: #9ca3af; background: #f9fafb; }
  .page-info { font-weight: 500; }
  .agent-status-cell { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .pr-status-cell { display: inline-flex; align-items: center; white-space: nowrap; }
  .error-token-wrap { position: relative; display: inline-flex; align-items: center; }
  .error-token { width: 16px; height: 16px; border: 0; border-radius: 999px; background: #dc2626; color: #fff; font-size: 0.68rem; font-weight: 700; line-height: 1; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; }
  .error-token:focus-visible { outline: 2px solid #111827; outline-offset: 2px; }
  .error-tooltip { display: none; position: absolute; top: 50%; left: calc(100% + 8px); transform: translateY(-50%); background: #111827; color: #fff; border-radius: 6px; padding: 6px 8px; font-size: 0.75rem; line-height: 1.3; box-shadow: 0 8px 20px rgba(0,0,0,0.18); width: max-content; max-width: 320px; z-index: 40; white-space: normal; }
  .error-token-wrap:hover .error-tooltip,
  .error-token-wrap:focus-within .error-tooltip,
  .error-token-wrap[data-open="true"] .error-tooltip { display: block; }
`;

dashboardRouter.post("/:ticketKey/delete", async (c) => {
  const ticketKey = c.req.param("ticketKey");
  const body = await c.req.parseBody();
  const filters = {
    project: typeof body.project === "string" ? body.project : null,
    hideDone: typeof body.hideDone === "string" ? body.hideDone : null,
    status: typeof body.status === "string" ? body.status : null,
  };
  const force = body.force === "1";
  const [runs, configs] = await Promise.all([getAllDispatchRuns(), listProjectConfigs()]);
  const run = runs.find((item) => item.ticket_key === ticketKey);

  if (!run) {
    return c.redirect(
      buildDashboardRedirect(filters, {
        type: "error",
        message: `Run ${ticketKey} was not found.`,
      })
    );
  }

  if (!force && run.pr_url) {
    const parsedPr = parseGithubPullRequestUrl(run.pr_url);
    if (!parsedPr) {
      return c.redirect(
        buildDashboardRedirect(
          filters,
          {
            type: "error",
            message: `Cannot delete ${ticketKey} while PR URL is invalid. Use Force delete to remove it anyway.`,
          },
          { deleteFailed: ticketKey }
        )
      );
    }

    try {
      const config = configs.find((item) => item.project_key === run.project_key);
      const githubToken = config ? resolveProjectTokens(config).githubToken : env.GITHUB_TOKEN;
      const prState = await getPullRequestState(run.pr_url, githubToken);
      if (prState === "open") {
        return c.redirect(
          buildDashboardRedirect(
            filters,
            {
              type: "error",
              message: `Cannot delete ${ticketKey} while PR #${parsedPr.pullNumber} is open. Close it first, or use Force delete.`,
            },
            { deleteFailed: ticketKey }
          )
        );
      }
    } catch (err) {
      console.warn(
        `[dashboard] Could not verify PR status for ${ticketKey} before delete:`,
        err
      );
      return c.redirect(
        buildDashboardRedirect(
          filters,
          {
            type: "error",
            message: `Could not verify the PR status for ${ticketKey} (GitHub API error, possibly rate-limited). Use Force delete to remove it anyway.`,
          },
          { deleteFailed: ticketKey }
        )
      );
    }
  }

  await deleteRun(ticketKey);
  return c.redirect(
    buildDashboardRedirect(filters, {
      type: "success",
      message: `Deleted ${ticketKey}.`,
    })
  );
});

interface DashboardQuery {
  hideDone: boolean;
  selectedProject: string;
  selectedStatus: DashboardStatusFilterKey | "";
  page: number;
  deleteFailedKey: string;
}

function readDashboardQuery(
  getQuery: (key: string) => string | undefined
): DashboardQuery {
  const hideDone = getQuery("hideDone") === "1";
  const selectedProject = getQuery("project") ?? "";
  const selectedStatusQuery = getQuery("status") ?? "";
  const selectedStatus = dashboardStatusFilterKeys.has(
    selectedStatusQuery as DashboardStatusFilterKey
  )
    ? (selectedStatusQuery as DashboardStatusFilterKey)
    : "";
  const pageRaw = Number.parseInt(getQuery("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const deleteFailedKey = getQuery("deleteFailed") ?? "";
  return { hideDone, selectedProject, selectedStatus, page, deleteFailedKey };
}

interface DashboardView {
  query: DashboardQuery;
  runs: RunWithProdDeployment[];
  total: number;
  limit: number;
  counts: Record<string, number>;
  totalBlocked: number;
  projects: string[];
}

// Loads exactly one page of runs plus the aggregates needed to render the view.
// Filtering, hideDone, and pagination all happen in SQL, and ticket status is read
// from persisted columns, so a render performs zero live Jira calls regardless of
// how large dispatch_runs grows.
async function loadDashboardView(query: DashboardQuery): Promise<DashboardView> {
  const { hideDone, selectedProject, selectedStatus, page } = query;
  const statuses = selectedStatus
    ? Array.from(dashboardStatusesByFilterKey.get(selectedStatus) ?? [])
    : [];
  const filter: DispatchRunFilter = {
    projectKey: selectedProject || null,
    statuses,
    hideDone,
  };
  const limit = DEFAULT_DASHBOARD_PAGE_SIZE;
  const offset = (page - 1) * limit;

  const [pageRuns, total, statusCountRows, runProjectKeys, configs] =
    await Promise.all([
      getDispatchRunsPage(filter, limit, offset),
      countDispatchRuns(filter),
      getStatusCounts({ projectKey: selectedProject || null, hideDone }),
      getDistinctRunProjectKeys(),
      listProjectConfigs(),
    ]);

  // The prod-deployment column is currently hidden (showProdDeploymentColumn === false).
  // Skip the enrichment while hidden so we never do a per-row GitHub PR lookup whose
  // output is not rendered. The call is retained behind the flag for re-enablement.
  const runs: RunWithProdDeployment[] = showProdDeploymentColumn
    ? await annotateRunsWithProdDeploymentStatus(pageRuns)
    : pageRuns.map((run) => ({ ...run, deployed_to_prod: null }));

  const projects = Array.from(
    new Set([
      ...configs.filter((config) => config.active).map((config) => config.project_key),
      ...runProjectKeys,
    ])
  ).sort((a, b) => a.localeCompare(b));

  const counts: Record<string, number> = {
    running: 0,
    queued: 0,
    blocked: 0,
    succeeded: 0,
    failed: 0,
    stale: 0,
    blocked_cycle: 0,
  };
  for (const row of statusCountRows) {
    counts[row.status] = (counts[row.status] ?? 0) + Number.parseInt(row.count, 10);
  }
  const totalBlocked = (counts.blocked ?? 0) + (counts.blocked_cycle ?? 0);

  // PR review/revision action-state is resolved out-of-band by the monitor loop
  // and persisted to dispatch_runs (pr_review_running / pr_revision_running), so
  // this render performs zero live GitHub calls regardless of how many PRs are on
  // the page.
  return { query, runs, total, limit, counts, totalBlocked, projects };
}

// Renders the dynamic dashboard section (stats bar + table + pagination). Shared by
// the full page and the /fragment endpoint so the client poll can swap it in place.
function renderDashboardContent(view: DashboardView): string {
  const { runs, counts, totalBlocked, total, limit } = view;
  const { hideDone, selectedProject, selectedStatus, page, deleteFailedKey } = view.query;
  const escapedSelectedProject = escapeHtml(selectedProject);

  const statsHtml = dashboardStatusFilterOptions
    .map((option) => {
      const count = option.key === "blocked" ? totalBlocked : (counts[option.key] ?? 0);
      const tagParams = new URLSearchParams();
      if (selectedProject) tagParams.set("project", selectedProject);
      if (hideDone) tagParams.set("hideDone", "1");
      if (selectedStatus !== option.key) tagParams.set("status", option.key);
      const href = `/dashboard${buildHrefSuffix(tagParams)}`;
      const selectedClass = selectedStatus === option.key ? " stat-selected" : "";
      return `<a href="${href}" class="stat stat-link${selectedClass}" style="${option.style}" role="button" aria-pressed="${selectedStatus === option.key}">${count} ${option.label}</a>`;
    })
    .join("\n");

  const rows = runs.map((run) => {
    const ticketUrl = `${env.JIRA_SITE_URL}/browse/${run.ticket_key}`;
    const branchName = buildAgentBranchName(run.ticket_key, run.summary);
    const runtime = formatDuration(run.spawned_at, run.completed_at);
    const ozTaskLink = run.session_link
      ? `<a href="${run.session_link}" target="_blank">Open</a>`
      : "-";
    const blockedByHtml =
      run.blocked_by && run.blocked_by.length > 0
        ? `<div class="blocked-by">Blocked by: ${run.blocked_by.join(", ")}</div>`
        : "";
    const actionLink =
      run.status === "running" && run.session_link
        ? `<a href="${run.session_link}" target="_blank">Session</a>`
        : run.status === "succeeded" && run.pr_url
          ? (() => {
              const parsedPr = parseGithubPullRequestUrl(run.pr_url ?? "");
              const prLabel = parsedPr ? `PR #${parsedPr.pullNumber}` : "PR";
              const prDisplayState = run.pr_display_state;
              const prSuffix =
                prDisplayState === "merged"
                  ? " (Merged)"
                  : prDisplayState === "draft"
                    ? " (Draft)"
                    : prDisplayState === "closed"
                      ? " (Closed)"
                      : "";
              return `<a href="${run.pr_url}" target="_blank">${prLabel}${prSuffix}</a>`;
            })()
          : "-";
    const showForceDelete = run.ticket_key === deleteFailedKey;
    const rowActions = `<div class="row-menu" data-row-menu>
      <button class="row-menu-btn" type="button" data-row-menu-button aria-label="Open actions for ${run.ticket_key}" aria-expanded="false">⋮</button>
      <div class="row-menu-list" role="menu">
        <form method="POST" action="/dashboard/${run.ticket_key}/delete" style="margin:0;">
          ${selectedProject ? `<input type="hidden" name="project" value="${escapedSelectedProject}">` : ""}
          ${hideDone ? '<input type="hidden" name="hideDone" value="1">' : ""}
          ${selectedStatus ? `<input type="hidden" name="status" value="${escapeHtml(selectedStatus)}">` : ""}
          <button class="row-menu-delete" type="submit" role="menuitem">Delete</button>
          ${showForceDelete ? `<button class="row-menu-delete" type="submit" name="force" value="1" role="menuitem" onclick="return confirm('Force delete ${run.ticket_key}? This skips the open-PR safety check and only removes the run from the dashboard.')">Force delete</button>` : ""}
        </form>
      </div>
    </div>`;

    const errorToken = run.error
      ? `<span class="error-token-wrap" data-error-token>
          <button class="error-token" type="button" data-error-token-button aria-label="Show error for ${run.ticket_key}" aria-expanded="false">!</button>
          <span class="error-tooltip" role="tooltip">${escapeHtml(run.error)}</span>
        </span>`
      : "";

    return `<tr>
      <td><a href="${ticketUrl}" target="_blank">${run.ticket_key}</a></td>
      <td>${run.project_key}</td>
      <td>${run.summary ? run.summary.slice(0, 80) : "-"}</td>
      <td>${ticketStatusBadge(run.ticket_status_name, run.ticket_status_category)}</td>
      <td><span class="agent-status-cell">${statusBadge(run.status)}${errorToken}</span></td>
      <td>${formatSpawnedAtDate(run.spawned_at)}</td>
      <td>${runtime}</td>
      <td>
        <span class="branch-cell">
          <code>${branchName}</code>
          <button class="copy-branch-btn" type="button" data-copy-branch="${branchName}" aria-label="Copy ${branchName} to clipboard"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="12" height="15" rx="2" ry="2"/><path d="M9 7V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-4"/></svg></button>
        </span>
      </td>
      <td>${ozTaskLink}</td>
      <td><span class="pr-status-cell">${prStatusBadge(
        run.pr_has_conflicts,
        Boolean(run.pr_url),
        // Running badges only apply to non-terminal PRs. The monitor stops
        // refreshing these flags once a PR is merged/closed (it leaves the
        // active-PR set), so gate on display state to avoid showing a stale
        // "Review running" on a merged PR.
        run.pr_url &&
          run.pr_display_state !== "merged" &&
          run.pr_display_state !== "closed"
          ? {
              reviewRunning: Boolean(run.pr_review_running),
              revisionRunning: Boolean(run.pr_revision_running),
            }
          : null
      )}</span></td>
      ${showProdDeploymentColumn ? `<td>${prodDeploymentBadge(run.deployed_to_prod)}</td>` : ""}
      <td>${actionLink}${blockedByHtml}</td>
      <td class="row-actions-cell">${rowActions}</td>
    </tr>`;
  });

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(page, totalPages);
  const pageHref = (p: number): string => {
    const params = new URLSearchParams();
    if (selectedProject) params.set("project", selectedProject);
    if (hideDone) params.set("hideDone", "1");
    if (selectedStatus) params.set("status", selectedStatus);
    if (p > 1) params.set("page", String(p));
    return `/dashboard${buildHrefSuffix(params)}`;
  };
  const paginationHtml =
    totalPages > 1
      ? `<div class="pagination">
      ${currentPage > 1 ? `<a href="${pageHref(currentPage - 1)}">← Prev</a>` : '<span class="disabled">← Prev</span>'}
      <span class="page-info">Page ${currentPage} of ${totalPages} (${total} total)</span>
      ${currentPage < totalPages ? `<a href="${pageHref(currentPage + 1)}">Next →</a>` : '<span class="disabled">Next →</span>'}
    </div>`
      : "";

  const colspan = showProdDeploymentColumn ? 13 : 12;
  const tableBody =
    rows.length === 0
      ? `<tr><td colspan="${colspan}" style="text-align:center;color:#6b7280">${
          selectedStatus
            ? `no ${escapeHtml(selectedStatus)} tasks available`
            : "No runs found for the current filter"
        }</td></tr>`
      : rows.join("\n");

  return `<div class="stats">
    ${statsHtml}
  </div>
  <table>
    <thead>
      <tr>
        <th>Ticket</th>
        <th>Project</th>
        <th>Summary</th>
        <th>Ticket Status</th>
        <th>Agent Status</th>
        <th>Spawned At</th>
        <th>Runtime</th>
        <th>Branch</th>
        <th>Oz Task</th>
        <th>PR Status</th>
        ${showProdDeploymentColumn ? "<th>Prod Deployment (Coolify)</th>" : ""}
        <th>Links</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      ${tableBody}
    </tbody>
  </table>
  ${paginationHtml}`;
}

dashboardRouter.get("/", async (c) => {
  const query = readDashboardQuery((key) => c.req.query(key));
  const notice = c.req.query("notice") ?? "";
  const noticeType = c.req.query("noticeType") === "error" ? "error" : "success";
  const escapedNotice = escapeHtml(notice);
  const view = await loadDashboardView(query);
  const { hideDone, selectedProject, selectedStatus } = query;
  const escapedSelectedStatus = escapeHtml(selectedStatus);

  const hideDoneToggleParams = new URLSearchParams();
  if (!hideDone) hideDoneToggleParams.set("hideDone", "1");
  if (selectedProject) hideDoneToggleParams.set("project", selectedProject);
  if (selectedStatus) hideDoneToggleParams.set("status", selectedStatus);
  const hideDoneToggleHref = `/dashboard${buildHrefSuffix(hideDoneToggleParams)}`;
  const projectOptionsHtml = [
    `<option value=""${selectedProject === "" ? " selected" : ""}>All Projects</option>`,
    ...view.projects.map(
      (project) =>
        `<option value="${escapeHtml(project)}"${selectedProject === project ? " selected" : ""}>${escapeHtml(project)}</option>`
    ),
  ].join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>HyperDispatch</title>
  <link rel="icon" href="${faviconDataUri()}">
  <style>${CSS}</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <span class="brand-logo">${brandIconSvg()}</span>
      <h1>HyperDispatch Dashboard</h1>
    </div>
    <div class="header-actions">
      <form class="header-filter-form" method="GET" action="/dashboard">
        <label class="filter-label" for="project-filter">Project</label>
        <select class="filter-select" id="project-filter" name="project" onchange="this.form.submit()">
          ${projectOptionsHtml}
        </select>
        ${hideDone ? '<input type="hidden" name="hideDone" value="1">' : ""}
        ${selectedStatus ? `<input type="hidden" name="status" value="${escapedSelectedStatus}">` : ""}
      </form>
      <a href="${hideDoneToggleHref}" class="btn btn-secondary">${hideDone ? "Show Done" : "Hide Done"}</a>
      <a href="/config" class="btn btn-secondary">⚙ Configure</a>
    </div>
  </div>
  ${notice ? `<div class="notice notice-${noticeType}" role="status"><span class="notice-message">${escapedNotice}</span><button class="notice-dismiss" type="button" data-notice-dismiss aria-label="Dismiss notification">×</button></div>` : ""}
  <div id="dashboard-content">
    ${renderDashboardContent(view)}
  </div>
  <script>
    (function clearTransientDashboardQueryParams() {
      const url = new URL(window.location.href);
      let changed = false;
      for (const key of ["notice", "noticeType", "deleteFailed"]) {
        if (!url.searchParams.has(key)) continue;
        url.searchParams.delete(key);
        changed = true;
      }
      if (!changed) return;
      const query = url.searchParams.toString();
      const nextUrl = url.pathname + (query ? "?" + query : "") + url.hash;
      window.history.replaceState(null, "", nextUrl);
    })();
    // Centralized refresh: fetch the server-rendered table fragment for the current
    // filters/page and swap it in place. Polling calls this on a timer; a future
    // websocket layer can call the same function (or push the fragment) without
    // conflicting — the timer is the fallback.
    async function refreshDashboard() {
      try {
        const res = await fetch("/dashboard/fragment" + window.location.search, {
          headers: { "X-Requested-With": "fetch" },
        });
        if (!res.ok) return;
        const html = await res.text();
        const container = document.getElementById("dashboard-content");
        if (container) container.innerHTML = html;
      } catch {
        // Best effort — keep the last rendered content on a failed refresh.
      }
    }
    setInterval(refreshDashboard, 15000);
    let previousVisibilityState = document.visibilityState;
    document.addEventListener("visibilitychange", () => {
      const becameVisible =
        previousVisibilityState !== "visible" && document.visibilityState === "visible";
      previousVisibilityState = document.visibilityState;
      if (!becameVisible) return;
      refreshDashboard();
    });
    document.addEventListener("click", async (event) => {
      const button = event.target instanceof Element ? event.target.closest("[data-copy-branch]") : null;
      if (!(button instanceof HTMLButtonElement)) return;
      const branch = button.dataset.copyBranch;
      if (!branch) return;
      try {
        await navigator.clipboard.writeText(branch);
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = branch;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      button.classList.add("copied");
      button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(() => {
        button.classList.remove("copied");
        button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="12" height="15" rx="2" ry="2"/><path d="M9 7V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-4"/></svg>';
      }, 1200);
    });
    document.addEventListener("click", (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) return;
      const noticeDismissButton = target.closest("[data-notice-dismiss]");
      if (noticeDismissButton instanceof HTMLButtonElement) {
        const noticeEl = noticeDismissButton.closest(".notice");
        if (noticeEl instanceof HTMLElement) noticeEl.remove();
        return;
      }
      const button = target.closest("[data-row-menu-button]");
      if (button instanceof HTMLButtonElement) {
        const menu = button.closest("[data-row-menu]");
        if (!(menu instanceof HTMLElement)) return;
        const isOpen = menu.classList.contains("open");
        for (const openMenu of document.querySelectorAll("[data-row-menu].open")) {
          openMenu.classList.remove("open");
          const openButton = openMenu.querySelector("[data-row-menu-button]");
          if (openButton instanceof HTMLButtonElement) {
            openButton.setAttribute("aria-expanded", "false");
          }
        }
        if (!isOpen) {
          menu.classList.add("open");
          button.setAttribute("aria-expanded", "true");
        }
        return;
      }
      for (const openMenu of document.querySelectorAll("[data-row-menu].open")) {
        if (!(openMenu instanceof HTMLElement)) continue;
        if (openMenu.contains(target)) continue;
        openMenu.classList.remove("open");
        const openButton = openMenu.querySelector("[data-row-menu-button]");
        if (openButton instanceof HTMLButtonElement) {
          openButton.setAttribute("aria-expanded", "false");
        }
      }
    });
    document.addEventListener("click", (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) return;
      const button = target.closest("[data-error-token-button]");
      if (button instanceof HTMLButtonElement) {
        const token = button.closest("[data-error-token]");
        if (!(token instanceof HTMLElement)) return;
        const isOpen = token.getAttribute("data-open") === "true";
        for (const openToken of document.querySelectorAll("[data-error-token][data-open='true']")) {
          if (!(openToken instanceof HTMLElement)) continue;
          openToken.setAttribute("data-open", "false");
          const openButton = openToken.querySelector("[data-error-token-button]");
          if (openButton instanceof HTMLButtonElement) {
            openButton.setAttribute("aria-expanded", "false");
          }
        }
        if (!isOpen) {
          token.setAttribute("data-open", "true");
          button.setAttribute("aria-expanded", "true");
        }
        return;
      }
      for (const openToken of document.querySelectorAll("[data-error-token][data-open='true']")) {
        if (!(openToken instanceof HTMLElement)) continue;
        if (openToken.contains(target)) continue;
        openToken.setAttribute("data-open", "false");
        const openButton = openToken.querySelector("[data-error-token-button]");
        if (openButton instanceof HTMLButtonElement) {
          openButton.setAttribute("aria-expanded", "false");
        }
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      for (const openToken of document.querySelectorAll("[data-error-token][data-open='true']")) {
        if (!(openToken instanceof HTMLElement)) continue;
        openToken.setAttribute("data-open", "false");
        const openButton = openToken.querySelector("[data-error-token-button]");
        if (openButton instanceof HTMLButtonElement) {
          openButton.setAttribute("aria-expanded", "false");
        }
      }
    });
  </script>
</body>
</html>`;

  return c.html(html);
});

dashboardRouter.get("/fragment", async (c) => {
  const query = readDashboardQuery((key) => c.req.query(key));
  const view = await loadDashboardView(query);
  return c.html(renderDashboardContent(view));
});
