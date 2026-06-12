import { Hono } from "hono";
import { Octokit } from "@octokit/rest";
import { getAllDispatchRuns, listProjectConfigs } from "../db/config-queries.js";
import { deleteRun } from "../db/queries.js";
import { env } from "../config/env.js";
import { resolveProjectTokens } from "../config/env.js";
import { brandIconSvg, faviconDataUri } from "./branding.js";
import * as jira from "../jira/client.js";
import { annotateRunsWithProdDeploymentStatus } from "../coolify/prod-deployment.js";
import {
  getPullRequestDisplayState,
  getPullRequestState,
  parseGithubPullRequestUrl,
} from "../github/pull-requests.js";

export const dashboardRouter = new Hono();
const spawnedAtDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
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
  return `<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;${style}">${status}</span>`;
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
    return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;background:#ef4444;color:#fff">Merge conflicts</span>';
  }
  if (hasConflicts === false) {
    return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;background:#22c55e;color:#fff">No conflicts</span>';
  }
  return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;background:#e5e7eb;color:#111">Unknown</span>';
}
type PrActionState = {
  reviewRunning: boolean;
  revisionRunning: boolean;
};

const REVIEW_WORKFLOW_NAME = "Oz PR Review Commenting";
const REVISION_WORKFLOW_NAME = "Agent Revision on Review Feedback";
const IN_FLIGHT_WORKFLOW_STATUSES = new Set([
  "queued",
  "in_progress",
  "pending",
  "waiting",
  "requested",
  "action_required",
]);

function prStatusBadge(
  hasConflicts: boolean | null,
  hasPr: boolean,
  actionState: PrActionState | null
): string {
  if (!hasPr) return "-";
  if (actionState?.reviewRunning && actionState?.revisionRunning) {
    return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;background:#7c3aed;color:#fff">Review + revision running</span>';
  }
  if (actionState?.reviewRunning) {
    return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;background:#2563eb;color:#fff">Review running</span>';
  }
  if (actionState?.revisionRunning) {
    return '<span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;background:#ea580c;color:#fff">Revision running</span>';
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
  .notice { margin-bottom: 12px; padding: 10px 12px; border-radius: 6px; font-size: 0.875rem; font-weight: 500; }
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

dashboardRouter.get("/", async (c) => {
  const hideDone = c.req.query("hideDone") === "1";
  const selectedProject = c.req.query("project") ?? "";
  const selectedStatusQuery = c.req.query("status") ?? "";
  const notice = c.req.query("notice") ?? "";
  const noticeType = c.req.query("noticeType") === "error" ? "error" : "success";
  const deleteFailedKey = c.req.query("deleteFailed") ?? "";
  const escapedSelectedProject = escapeHtml(selectedProject);
  const escapedSelectedStatus = escapeHtml(selectedStatusQuery);
  const escapedNotice = escapeHtml(notice);
  const selectedStatus = dashboardStatusFilterKeys.has(selectedStatusQuery as DashboardStatusFilterKey)
    ? (selectedStatusQuery as DashboardStatusFilterKey)
    : "";
  const [runs, configs] = await Promise.all([getAllDispatchRuns(), listProjectConfigs()]);
  const runsWithProdDeployment = await annotateRunsWithProdDeploymentStatus(runs);
  const prDisplayStateByKey = new Map<string, "open" | "draft" | "merged" | "closed">();
  const projects = Array.from(
    new Set([
      ...configs.filter((c) => c.active).map((c) => c.project_key),
      ...runs.map((run) => run.project_key),
    ])
  ).sort((a, b) => a.localeCompare(b));
  const ticketStatusByKey = new Map<string, { name: string; categoryKey: string }>();
  await Promise.all(
    runsWithProdDeployment.map(async (run) => {
      try {
        const issue = await jira.getIssue(run.ticket_key, ["status"]);
        const status = issue.fields.status;
        if (status?.name && status?.statusCategory?.key) {
          ticketStatusByKey.set(run.ticket_key, {
            name: status.name,
            categoryKey: status.statusCategory.key,
          });
        }
      } catch (err) {
        // Best effort only — dashboard should still render if Jira is unavailable.
        console.warn(`[dashboard] Failed to load Jira status for ${run.ticket_key}:`, err);
      }
    })
  );
  await Promise.all(
    runsWithProdDeployment.map(async (run) => {
      if (!run.pr_url) return;
      if (!parseGithubPullRequestUrl(run.pr_url)) return;
      try {
        const config = configs.find((item) => item.project_key === run.project_key);
        const githubToken = config ? resolveProjectTokens(config).githubToken : env.GITHUB_TOKEN;
        const prDisplayState = await getPullRequestDisplayState(run.pr_url, githubToken);
        prDisplayStateByKey.set(run.ticket_key, prDisplayState);
      } catch (err) {
        // Best effort only — dashboard should still render if GitHub is unavailable.
        console.warn(`[dashboard] Failed to load PR status for ${run.ticket_key}:`, err);
      }
    })
  );
  const projectFilteredRuns = selectedProject
    ? runsWithProdDeployment.filter((run) => run.project_key === selectedProject)
    : runsWithProdDeployment;
  const visibleRuns = hideDone
    ? projectFilteredRuns.filter(
        (run) => ticketStatusByKey.get(run.ticket_key)?.categoryKey !== "done"
      )
    : projectFilteredRuns;
  const statusFilteredRuns = selectedStatus
    ? visibleRuns.filter((run) => {
        const allowedStatuses = dashboardStatusesByFilterKey.get(selectedStatus);
        return allowedStatuses ? allowedStatuses.has(run.status) : true;
      })
    : visibleRuns;
  const configByProjectKey = new Map(configs.map((config) => [config.project_key, config]));
  const githubClientByToken = new Map<string, Octokit>();
  const actionStateByPr = new Map<string, PrActionState>();

  // Group PRs by repo + token so each configured credential boundary is respected.
  const repoGroups = new Map<
    string,
    { owner: string; repo: string; token: string; prs: { prKey: string; pullNumber: number; branchName: string }[] }
  >();
  for (const run of statusFilteredRuns) {
    if (!run.pr_url) continue;
    const parsedPr = parseGithubPullRequestUrl(run.pr_url);
    if (!parsedPr) continue;
    const prKey = `${parsedPr.owner}/${parsedPr.repo}#${parsedPr.pullNumber}`;
    const config = configByProjectKey.get(run.project_key);
    const githubToken = config ? resolveProjectTokens(config).githubToken : env.GITHUB_TOKEN;
    const repoKey = `${parsedPr.owner}/${parsedPr.repo}::${githubToken}`;
    let group = repoGroups.get(repoKey);
    if (!group) {
      group = { owner: parsedPr.owner, repo: parsedPr.repo, token: githubToken, prs: [] };
      repoGroups.set(repoKey, group);
    }
    if (!group.prs.some((p) => p.prKey === prKey)) {
      group.prs.push({ prKey, pullNumber: parsedPr.pullNumber, branchName: `agent/${run.ticket_key}` });
    }
  }

  await Promise.all(
    Array.from(repoGroups.values()).map(async ({ owner, repo, token, prs }) => {
      let githubClient = githubClientByToken.get(token);
      if (!githubClient) {
        githubClient = new Octokit({ auth: token });
        githubClientByToken.set(token, githubClient);
      }
      try {
        const workflowRuns: Array<{
          name?: string | null;
          status?: string | null;
          head_branch?: string | null;
          pull_requests?: Array<{ number?: number }> | null;
        }> = [];
        for (let page = 1; ; page += 1) {
          const { data } = await githubClient.actions.listWorkflowRunsForRepo({
            owner,
            repo,
            per_page: 100,
            page,
          });
          workflowRuns.push(...(data.workflow_runs ?? []));
          if ((data.workflow_runs ?? []).length < 100) break;
        }
        for (const pr of prs) {
          const reviewRunning = workflowRuns.some(
            (wfRun) =>
              wfRun.name === REVIEW_WORKFLOW_NAME &&
              IN_FLIGHT_WORKFLOW_STATUSES.has(wfRun.status ?? "") &&
              ((wfRun.pull_requests ?? []).some((p) => p.number === pr.pullNumber) ||
                wfRun.head_branch === pr.branchName)
          );
          const revisionRunning = workflowRuns.some(
            (wfRun) =>
              wfRun.name === REVISION_WORKFLOW_NAME &&
              IN_FLIGHT_WORKFLOW_STATUSES.has(wfRun.status ?? "") &&
              ((wfRun.pull_requests ?? []).some((p) => p.number === pr.pullNumber) ||
                wfRun.head_branch === pr.branchName)
          );
          actionStateByPr.set(pr.prKey, { reviewRunning, revisionRunning });
        }
      } catch {
        // Best effort only — dashboard should still render if GitHub is unavailable.
      }
    })
  );

  const counts: Record<string, number> = {
    running: 0,
    queued: 0,
    blocked: 0,
    succeeded: 0,
    failed: 0,
    stale: 0,
    blocked_cycle: 0,
  };
  for (const run of visibleRuns) {
    counts[run.status] = (counts[run.status] ?? 0) + 1;
  }
  const totalBlocked = (counts.blocked ?? 0) + (counts.blocked_cycle ?? 0);
  const hideDoneToggleParams = new URLSearchParams();
  if (!hideDone) hideDoneToggleParams.set("hideDone", "1");
  if (selectedProject) hideDoneToggleParams.set("project", selectedProject);
  if (selectedStatus) hideDoneToggleParams.set("status", selectedStatus);
  const hideDoneToggleHref = `/dashboard${hideDoneToggleParams.size > 0 ? `?${hideDoneToggleParams.toString()}` : ""}`;
  const projectOptionsHtml = [
    `<option value=""${selectedProject === "" ? " selected" : ""}>All Projects</option>`,
    ...projects.map(
      (project) =>
        `<option value="${escapeHtml(project)}"${selectedProject === project ? " selected" : ""}>${escapeHtml(project)}</option>`
    ),
  ].join("");

  const statsHtml = dashboardStatusFilterOptions
    .map((option) => {
      const count =
        option.key === "blocked"
          ? totalBlocked
          : (counts[option.key] ?? 0);
      const tagParams = new URLSearchParams();
      if (selectedProject) tagParams.set("project", selectedProject);
      if (hideDone) tagParams.set("hideDone", "1");
      if (selectedStatus !== option.key) tagParams.set("status", option.key);
      const href = `/dashboard${tagParams.size > 0 ? `?${tagParams.toString()}` : ""}`;
      const selectedClass = selectedStatus === option.key ? " stat-selected" : "";
      return `<a href="${href}" class="stat stat-link${selectedClass}" style="${option.style}" role="button" aria-pressed="${selectedStatus === option.key}">${count} ${option.label}</a>`;
    })
    .join("\n");
  const rows = statusFilteredRuns.map((run) => {
    const ticketUrl = `${env.JIRA_SITE_URL}/browse/${run.ticket_key}`;
    const branchName = `agent/${run.ticket_key}`;
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
              const prDisplayState = prDisplayStateByKey.get(run.ticket_key);
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
    const parsedPr = run.pr_url ? parseGithubPullRequestUrl(run.pr_url) : null;
    const prKey = parsedPr ? `${parsedPr.owner}/${parsedPr.repo}#${parsedPr.pullNumber}` : null;
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

    return `<tr>
      <td><a href="${ticketUrl}" target="_blank">${run.ticket_key}</a></td>
      <td>${run.project_key}</td>
      <td>${run.summary ? run.summary.slice(0, 80) : "-"}</td>
      <td>${ticketStatusBadge(
        ticketStatusByKey.get(run.ticket_key)?.name ?? null,
        ticketStatusByKey.get(run.ticket_key)?.categoryKey ?? null
      )}</td>
      <td>${statusBadge(run.status)}</td>
      <td>${formatSpawnedAtDate(run.spawned_at)}</td>
      <td>${runtime}</td>
      <td>
        <span class="branch-cell">
          <code>${branchName}</code>
          <button class="copy-branch-btn" type="button" data-copy-branch="${branchName}" aria-label="Copy ${branchName} to clipboard"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        </span>
      </td>
      <td>${ozTaskLink}</td>
      <td>${prStatusBadge(
        run.pr_has_conflicts,
        Boolean(run.pr_url),
        prKey ? actionStateByPr.get(prKey) ?? null : null
      )}</td>
      ${showProdDeploymentColumn ? `<td>${prodDeploymentBadge(run.deployed_to_prod)}</td>` : ""}
      <td>${actionLink}${blockedByHtml}</td>
      <td class="row-actions-cell">${rowActions}</td>
    </tr>`;
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="15">
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
  <div class="stats">
    ${statsHtml}
  </div>
  ${notice ? `<div class="notice notice-${noticeType}">${escapedNotice}</div>` : ""}
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
      ${
        statusFilteredRuns.length === 0
          ? `<tr><td colspan="${showProdDeploymentColumn ? 13 : 12}" style="text-align:center;color:#6b7280">${
              selectedStatus
                ? `no ${selectedStatus} tasks available`
                : "No runs found for the current filter"
            }</td></tr>`
          : rows.join("\n")
      }
    </tbody>
  </table>
  <script>
    let previousVisibilityState = document.visibilityState;
    document.addEventListener("visibilitychange", () => {
      const becameVisible =
        previousVisibilityState !== "visible" && document.visibilityState === "visible";
      previousVisibilityState = document.visibilityState;
      if (!becameVisible) return;
      window.location.reload();
    });
    document.addEventListener("click", async (event) => {
      const button = event.target instanceof HTMLElement ? event.target.closest("[data-copy-branch]") : null;
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
        button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      }, 1200);
    });
    document.addEventListener("click", (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) return;
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
  </script>
</body>
</html>`;

  return c.html(html);
});
