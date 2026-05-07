import { Hono } from "hono";
import * as jira from "../jira/client.js";
import {
  getProjectConfig,
  getRunsBlockedBy,
  removeBlocker,
} from "../db/queries.js";
import {
  resolveJiraColumnMappings,
  jiraNamesEqual,
} from "../jira/columns.js";
import { syncTicketInToDo } from "../orchestration/ticket-sync.js";

export const webhookRouter = new Hono();

interface WebhookBody {
  issueKey: string;
  projectKey: string;
  transitionTarget: string;
}

webhookRouter.post("/jira", async (c) => {
  let body: WebhookBody;
  try {
    body = await c.req.json<WebhookBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { issueKey, projectKey, transitionTarget } = body;

  if (!issueKey || !projectKey || !transitionTarget) {
    return c.json({ error: "Missing required fields: issueKey, projectKey, transitionTarget" }, 400);
  }

  // Look up project config — ignore if not tracked
  const config = await getProjectConfig(projectKey);
  if (!config) {
    return c.json({ action: "ignored", reason: "project not configured" });
  }
  const columnMappings = resolveJiraColumnMappings({
    backlog: config.backlog_column_name,
    toDo: config.to_do_column_name,
    inProgress: config.in_progress_column_name,
    inReview: config.in_review_column_name,
    done: config.done_column_name,
  });

  // ── Transition: To Do ──────────────────────────────────────────────────
  if (jiraNamesEqual(transitionTarget, columnMappings.toDo)) {
    const result = await syncTicketInToDo(issueKey, projectKey);
    return c.json(result);
  }

  // ── Transition: Done ───────────────────────────────────────────────────
  if (jiraNamesEqual(transitionTarget, columnMappings.done)) {
    const blockedRuns = await getRunsBlockedBy(issueKey);

    let unblockedCount = 0;
    for (const run of blockedRuns) {
      const updated = await removeBlocker(run.ticket_key, issueKey);
      if (updated) {
        unblockedCount++;
      }
    }

    return c.json({ action: "unblocked", count: unblockedCount });
  }

  // ── Any other transition ────────────────────────────────────────────────
  return c.json({ action: "ignored" });
});
