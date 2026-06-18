import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Octokit } from "@octokit/rest";
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
import { transitionMergedPrToDone } from "../orchestration/pr-merge.js";
import { getPullRequestDisplayState } from "../github/pull-requests.js";
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

// GitHub's REST "Update a pull request" endpoint does not support changing the
// `draft` field, so a draft PR can only be marked ready for review through the
// GraphQL `markPullRequestReadyForReview` mutation (the same capability used by
// `gh pr ready`). It takes the PR's GraphQL node ID, which GitHub includes on
// the webhook payload as `pull_request.node_id`.
const MARK_READY_FOR_REVIEW_MUTATION = `
  mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      pullRequest {
        id
        isDraft
      }
    }
  }
`;

// Marks a draft PR ready for review and returns the resulting display state, or
// `null` when the state could not be determined (so the caller keeps the
// payload-derived state). The mutation throws when the PR is no longer a draft
// — e.g. an at-least-once webhook redelivery of the same `opened` event after
// we already transitioned it. In that case we re-read the authoritative state
// instead of regressing an already-open PR back to `draft`.
async function transitionDraftPullRequestToReady(
  prUrl: string,
  pullRequestNodeId: string,
  projectKey: string
): Promise<PullRequestDisplayState | null> {
  const projectConfig = await getProjectConfig(projectKey);
  const githubToken = projectConfig?.github_pat ?? env.GITHUB_TOKEN;
  const github = new Octokit({ auth: githubToken });

  try {
    await github.graphql(MARK_READY_FOR_REVIEW_MUTATION, {
      pullRequestId: pullRequestNodeId,
    });
    return "open";
  } catch (err) {
    console.warn(
      `[webhook] markPullRequestReadyForReview failed; reconciling authoritative PR state: ${prUrl}`,
      err
    );
    try {
      return await getPullRequestDisplayState(prUrl, githubToken);
    } catch (stateErr) {
      console.warn(
        `[webhook] Failed to read authoritative PR state after ready transition failure: ${prUrl}`,
        stateErr
      );
      return null;
    }
  }
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
    action?: string;
    pull_request?: {
      html_url?: string;
      node_id?: string;
      merged_at?: string | null;
      merged?: boolean;
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

  let prDisplayState = derivePullRequestDisplayState(payload);
  let transitionedToReady = false;
  if (payload.action === "opened" && payload.pull_request?.draft === true) {
    const pullRequestNodeId = payload.pull_request?.node_id;
    if (pullRequestNodeId) {
      const resolvedState = await transitionDraftPullRequestToReady(
        prUrl,
        pullRequestNodeId,
        runs[0]!.project_key
      );
      if (resolvedState) {
        prDisplayState = resolvedState;
        // A resolved `open` state means the PR is ready for review — whether we
        // just transitioned it or a redelivery found it already open.
        transitionedToReady = resolvedState === "open";
      }
    } else {
      console.warn(
        `[webhook] Missing pull_request.node_id; cannot transition draft PR to ready for review: ${prUrl}`
      );
    }
  }
  await Promise.all(
    runs.map((run) => updateRunStatus(run.ticket_key, { pr_display_state: prDisplayState }))
  );

  if (payload.action === "closed" && payload.pull_request?.merged === true) {
    await Promise.all(
      runs.map((run) =>
        transitionMergedPrToDone(run, {
          logPrefix: "[webhook]",
        })
      )
    );
  }

  return c.json({
    action: "updated",
    pr_url: prUrl,
    pr_display_state: prDisplayState,
    transitioned_to_ready: transitionedToReady,
    run_count: runs.length,
  });
});
