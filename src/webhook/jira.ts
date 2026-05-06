import { Hono } from "hono";
import * as jira from "../jira/client.js";
import {
  getProjectConfig,
  upsertDispatchRun,
  getRunsBlockedBy,
  removeBlocker,
} from "../db/queries.js";
import {
  resolveEligibility,
  detectCycles,
} from "../orchestration/dependency-resolver.js";

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

  // ── Transition: To Do ──────────────────────────────────────────────────
  if (transitionTarget === "To Do") {
    const issue = await jira.getIssueLinks(issueKey);

    const priorityValue =
      issue.fields.priority?.name != null
        ? priorityNameToNumber(issue.fields.priority.name)
        : 0;

    // Cycle detection — must run before eligibility to avoid infinite recursion
    const cycleResult = await detectCycles(issueKey);
    if (cycleResult.hasCycle) {
      await upsertDispatchRun({
        ticketKey: issueKey,
        projectKey,
        summary: issue.fields.summary,
        status: "blocked_cycle",
        blockedBy: cycleResult.cycleKeys,
        priority: priorityValue,
      });
      return c.json({
        action: "blocked_cycle",
        ticketKey: issueKey,
        cycle: cycleResult.cycleKeys,
      });
    }

    // Dependency resolution — check if all blockers are done
    const eligibility = await resolveEligibility(issueKey);
    if (!eligibility.eligible) {
      await upsertDispatchRun({
        ticketKey: issueKey,
        projectKey,
        summary: issue.fields.summary,
        status: "blocked",
        blockedBy: eligibility.blockedBy,
        priority: priorityValue,
      });
      return c.json({
        action: "blocked",
        ticketKey: issueKey,
        blockedBy: eligibility.blockedBy,
      });
    }

    await upsertDispatchRun({
      ticketKey: issueKey,
      projectKey,
      summary: issue.fields.summary,
      status: "queued",
      blockedBy: [],
      priority: priorityValue,
    });

    return c.json({ action: "queued", ticketKey: issueKey });
  }

  // ── Transition: Done ───────────────────────────────────────────────────
  if (transitionTarget === "Done") {
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

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Map Jira priority names to a numeric priority for queue ordering.
 * Higher number = higher priority.
 */
function priorityNameToNumber(name: string): number {
  const map: Record<string, number> = {
    Highest: 5,
    High: 4,
    Medium: 3,
    Low: 2,
    Lowest: 1,
  };
  return map[name] ?? 3;
}
