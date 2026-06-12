import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import * as jira from "../jira/client.js";
import {
  getRunsByPrUrl,
  getProjectConfig,
  getRunsBlockedBy,
  removeBlocker,
  updateRunStatus,
} from "../db/queries.js";
import {
  resolveJiraColumnMappings,
  jiraNamesEqual,
} from "../jira/columns.js";
import { syncTicketInToDo } from "../orchestration/ticket-sync.js";
import { env } from "../config/env.js";
export { priorityNameToNumber } from "../orchestration/ticket-sync.js";

export const webhookRouter = new Hono();

interface WebhookBody {
  issueKey: string;
  projectKey: string;
  transitionTarget: string;
}

type PullRequestDisplayState = "open" | "draft" | "merged" | "closed";

function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const receivedSignature = signatureHeader.slice("sha256=".length);
  const expectedSignature = createHmac("sha256", secret).update(rawBody).digest("hex");
  const receivedBuffer = Buffer.from(receivedSignature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(receivedBuffer, expectedBuffer);
}

function derivePullRequestDisplayState(payload: {
  pull_request?: { merged_at?: string | null; state?: string; draft?: boolean };
}): PullRequestDisplayState {
  const pullRequest = payload.pull_request;

  if (pullRequest?.merged_at) return "merged";
  if (pullRequest?.state === "open" && pullRequest.draft) return "draft";
  if (pullRequest?.state === "open") return "open";
  return "closed";
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

webhookRouter.post("/github", async (c) => {
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("GitHub webhook received but GITHUB_WEBHOOK_SECRET is not configured");
    return c.json({ error: "GitHub webhook is not configured" }, 503);
  }

  const rawBody = await c.req.text();
  const signatureHeader = c.req.header("X-Hub-Signature-256");
  const signatureValid = verifyGithubSignature(rawBody, signatureHeader, webhookSecret);
  if (!signatureValid) {
    return c.json({ error: "Invalid webhook signature" }, 401);
  }

  let payload: {
    pull_request?: {
      html_url?: string;
      merged_at?: string | null;
      state?: string;
      draft?: boolean;
    };
  };
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const event = c.req.header("X-GitHub-Event");
  if (event === "ping") {
    return c.json({ action: "pong" });
  }

  if (event !== "pull_request") {
    return c.json({ action: "ignored" });
  }

  const prUrl = payload.pull_request?.html_url;
  if (!prUrl) {
    return c.json({ action: "ignored", reason: "missing pull_request.html_url" });
  }

  const runs = await getRunsByPrUrl(prUrl);
  if (runs.length === 0) {
    return c.json({ action: "ignored", reason: "pr not tracked" });
  }

  const prDisplayState = derivePullRequestDisplayState(payload);
  await Promise.all(
    runs.map((run) => updateRunStatus(run.ticket_key, { pr_display_state: prDisplayState }))
  );

  return c.json({
    action: "updated",
    pr_url: prUrl,
    pr_display_state: prDisplayState,
    run_count: runs.length,
  });
});
