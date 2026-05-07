import { Hono } from "hono";
import { getAllDispatchRuns, getRunCountsByStatus } from "../db/config-queries.js";
import { env } from "../config/env.js";
import { brandIconSvg, faviconDataUri } from "./branding.js";
import * as jira from "../jira/client.js";

export const dashboardRouter = new Hono();

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
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

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

const CSS = `
  body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #f9fafb; color: #111; }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; gap: 16px; }
  .header-left { display: flex; align-items: center; gap: 12px; }
  .brand-logo { width: 34px; height: 34px; flex: 0 0 auto; display: inline-flex; }
  .header h1 { margin: 0; }
  h1 { margin: 0 0 16px; font-size: 1.4rem; }
  .btn { display: inline-block; padding: 8px 18px; border-radius: 6px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; text-decoration: none; }
  .btn-secondary { background: #e5e7eb; color: #111; }
  .btn-secondary:hover { background: #d1d5db; }
  .stats { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat { padding: 10px 16px; border-radius: 6px; font-weight: 600; font-size: 0.9rem; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th { background: #f3f4f6; text-align: left; padding: 10px 12px; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; }
  td { padding: 10px 12px; border-bottom: 1px solid #f3f4f6; font-size: 0.875rem; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  a { color: #3b82f6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .blocked-by { font-size: 0.75rem; color: #6b7280; }
`;

dashboardRouter.get("/", async (c) => {
  const [runs, countRows] = await Promise.all([
    getAllDispatchRuns(),
    getRunCountsByStatus(),
  ]);
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

  const counts: Record<string, number> = {
    running: 0,
    queued: 0,
    blocked: 0,
    succeeded: 0,
    failed: 0,
    stale: 0,
    blocked_cycle: 0,
  };
  for (const row of countRows) {
    counts[row.status] = parseInt(row.count, 10);
  }
  const totalBlocked = (counts.blocked ?? 0) + (counts.blocked_cycle ?? 0);

  const statsHtml = [
    `<div class="stat" style="background:#3b82f6;color:#fff">${counts.running ?? 0} Running</div>`,
    `<div class="stat" style="background:#eab308;color:#000">${counts.queued ?? 0} Queued</div>`,
    `<div class="stat" style="background:#f97316;color:#fff">${totalBlocked} Blocked</div>`,
    `<div class="stat" style="background:#22c55e;color:#fff">${counts.succeeded ?? 0} Succeeded</div>`,
    `<div class="stat" style="background:#ef4444;color:#fff">${counts.failed ?? 0} Failed</div>`,
    `<div class="stat" style="background:#6b7280;color:#fff">${counts.stale ?? 0} Stale</div>`,
  ].join("\n");

  const rows = runs.map((run) => {
    const ticketUrl = `${env.JIRA_BASE_URL}/browse/${run.ticket_key}`;
    const branchName = `agent/${run.ticket_key}`;
    const runtime = formatDuration(run.spawned_at, run.completed_at);
    const ozTaskLink = run.session_link
      ? `<a href="${run.session_link}" target="_blank">Open task</a>`
      : "-";
    const blockedByHtml =
      run.blocked_by && run.blocked_by.length > 0
        ? `<div class="blocked-by">Blocked by: ${run.blocked_by.join(", ")}</div>`
        : "";
    const links: string[] = [];
    if (run.status === "running" && run.session_link) {
      links.push(`<a href="${run.session_link}" target="_blank">Session</a>`);
    }
    if (run.status === "succeeded" && run.pr_url) {
      links.push(`<a href="${run.pr_url}" target="_blank">PR</a>`);
    }
    const actionLinks = links.length > 0 ? links.join(" · ") : "-";

    return `<tr>
      <td><a href="${ticketUrl}" target="_blank">${run.ticket_key}</a></td>
      <td>${run.summary ? run.summary.slice(0, 80) : "-"}</td>
      <td>${ticketStatusBadge(
        ticketStatusByKey.get(run.ticket_key)?.name ?? null,
        ticketStatusByKey.get(run.ticket_key)?.categoryKey ?? null
      )}</td>
      <td>${statusBadge(run.status)}</td>
      <td>${formatDate(run.spawned_at)}</td>
      <td>${runtime}</td>
      <td><code>${branchName}</code></td>
      <td>${ozTaskLink}</td>
      <td>${actionLinks}${blockedByHtml}</td>
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
    <a href="/config" class="btn btn-secondary">⚙ Configure Projects</a>
  </div>
  <div class="stats">
    ${statsHtml}
  </div>
  <table>
    <thead>
      <tr>
        <th>Ticket</th>
        <th>Summary</th>
        <th>Ticket Status</th>
        <th>Status</th>
        <th>Spawned At</th>
        <th>Runtime</th>
        <th>Branch</th>
        <th>Oz Task</th>
        <th>Links</th>
      </tr>
    </thead>
    <tbody>
      ${runs.length === 0 ? '<tr><td colspan="9" style="text-align:center;color:#6b7280">No runs yet</td></tr>' : rows.join("\n")}
    </tbody>
  </table>
</body>
</html>`;

  return c.html(html);
});
