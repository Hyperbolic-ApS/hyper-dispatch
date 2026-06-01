import { Hono } from "hono";
import { getAllDispatchRuns } from "../db/config-queries.js";
import { env } from "../config/env.js";
import { brandIconSvg, faviconDataUri } from "./branding.js";
import * as jira from "../jira/client.js";

export const dashboardRouter = new Hono();
const dashboardDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
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

function formatDate(d: Date | null): string {
  if (!d) return "-";
  return dashboardDateTimeFormatter.format(d);
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
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
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
`;

dashboardRouter.get("/", async (c) => {
  const hideDone = c.req.query("hideDone") === "1";
  const selectedProject = c.req.query("project") ?? "";
  const selectedStatusQuery = c.req.query("status") ?? "";
  const selectedStatus = dashboardStatusFilterKeys.has(selectedStatusQuery as DashboardStatusFilterKey)
    ? (selectedStatusQuery as DashboardStatusFilterKey)
    : "";
  const runs = await getAllDispatchRuns();
  const projects = Array.from(new Set(runs.map((run) => run.project_key))).sort((a, b) =>
    a.localeCompare(b)
  );
  const ticketStatusByKey = new Map<string, { name: string; categoryKey: string }>();
  await Promise.all(
    runs.map(async (run) => {
      try {
        const issue = await jira.getIssue(run.ticket_key, ["status"]);
        const status = issue.fields.status;
        if (status?.name && status?.statusCategory?.key) {
          ticketStatusByKey.set(run.ticket_key, {
            name: status.name,
            categoryKey: status.statusCategory.key,
          });
        }
      } catch {
        // Best effort only — dashboard should still render if Jira is unavailable.
      }
    })
  );
  const projectFilteredRuns = selectedProject
    ? runs.filter((run) => run.project_key === selectedProject)
    : runs;
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
        `<option value="${project}"${selectedProject === project ? " selected" : ""}>${project}</option>`
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
      ? `<a href="${run.session_link}" target="_blank">Open task</a>`
      : "-";
    const blockedByHtml =
      run.blocked_by && run.blocked_by.length > 0
        ? `<div class="blocked-by">Blocked by: ${run.blocked_by.join(", ")}</div>`
        : "";
    const actionLink =
      run.status === "running" && run.session_link
        ? `<a href="${run.session_link}" target="_blank">Session</a>`
        : run.status === "succeeded" && run.pr_url
          ? `<a href="${run.pr_url}" target="_blank">PR</a>`
          : "-";

    return `<tr>
      <td><a href="${ticketUrl}" target="_blank">${run.ticket_key}</a></td>
      <td>${run.project_key}</td>
      <td>${run.summary ? run.summary.slice(0, 80) : "-"}</td>
      <td>${ticketStatusBadge(
        ticketStatusByKey.get(run.ticket_key)?.name ?? null,
        ticketStatusByKey.get(run.ticket_key)?.categoryKey ?? null
      )}</td>
      <td>${statusBadge(run.status)}</td>
      <td>${formatDate(run.spawned_at)}</td>
      <td>${runtime}</td>
      <td>
        <span class="branch-cell">
          <code>${branchName}</code>
          <button class="copy-branch-btn" type="button" data-copy-branch="${branchName}" aria-label="Copy ${branchName} to clipboard"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        </span>
      </td>
      <td>${ozTaskLink}</td>
      <td>${prConflictBadge(run.pr_has_conflicts, Boolean(run.pr_url))}</td>
      <td>${actionLink}${blockedByHtml}</td>
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
        ${selectedStatus ? `<input type="hidden" name="status" value="${selectedStatus}">` : ""}
      </form>
      <a href="${hideDoneToggleHref}" class="btn btn-secondary">${hideDone ? "Show Done" : "Hide Done"}</a>
      <a href="/config" class="btn btn-secondary">⚙ Configure Projects</a>
    </div>
  </div>
  <div class="stats">
    ${statsHtml}
  </div>
  <table>
    <thead>
      <tr>
        <th>Ticket</th>
        <th>Project</th>
        <th>Summary</th>
        <th>Ticket Status</th>
        <th>Status</th>
        <th>Spawned At</th>
        <th>Runtime</th>
        <th>Branch</th>
        <th>Oz Task</th>
        <th>PR Mergeability</th>
        <th>Links</th>
      </tr>
    </thead>
    <tbody>
      ${
        statusFilteredRuns.length === 0
          ? `<tr><td colspan="11" style="text-align:center;color:#6b7280">${
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
  </script>
</body>
</html>`;

  return c.html(html);
});
