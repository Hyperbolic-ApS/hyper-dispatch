import { Octokit } from "@octokit/rest";
import type { McpServerConfig } from "oz-agent-sdk/resources/agent/agent";
import { resolveProjectTokens } from "../config/env.js";
import {
  claimRevisionSlot,
  createRun,
  deleteRevisionEvent,
  getProjectConfig,
  getRunsByPrUrl,
  releaseRevisionSlot,
  tryRecordRevisionEvent,
} from "../db/queries.js";
import type { ProjectConfig } from "../db/queries.js";
import * as jira from "../jira/client.js";
import { getOzClient } from "./oz-client.js";
import { resolveModel } from "./spawner.js";

const TICKET_KEY_REGEX = /^agents?\/([A-Z][A-Z0-9]+-\d+)(?:-[a-z0-9-]+)?$/;
const REVISE_COMMAND_REGEX = /\/revise\b/i;

type RevisionMode = "auto_review_submitted" | "manual_comment";

interface PullRequestRef {
  htmlUrl: string;
  branch: string;
  owner: string;
  repo: string;
  pullNumber: number;
}

interface TrackedRevisionContext {
  pr: PullRequestRef;
  ticketKey: string;
  projectKey: string;
  projectConfig: ProjectConfig;
  githubToken: string;
}

type RevisionDecision =
  | { action: "ignored"; reason: string }
  | {
      action: "spawned";
      mode: RevisionMode;
      ticketKey: string;
      runId: string;
      actionItemCount: number;
    };

function parsePrNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractTicketKeyFromBranch(branch: string): string | null {
  const match = branch.match(TICKET_KEY_REGEX);
  return match?.[1] ?? null;
}

function normalizeRevId(raw: string): string {
  return raw.trim().toUpperCase();
}

export function extractActionItemIds(texts: string[]): string[] {
  const ids = new Set<string>();

  for (const text of texts) {
    if (!text) continue;

    for (const match of text.matchAll(/\[(REV-\d+)\]/gi)) {
      ids.add(normalizeRevId(match[1]));
    }
    for (const match of text.matchAll(/\bid:\s*(REV-\d+)\b/gi)) {
      ids.add(normalizeRevId(match[1]));
    }
  }

  return [...ids].sort();
}

function parseTicketKeyFromText(text: string): string | null {
  const match = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return match?.[1] ?? null;
}

async function listReviewComments(
  githubToken: string,
  pr: PullRequestRef,
  reviewId: number
): Promise<Array<{ path: string; line: number | null; body: string }>> {
  const octokit = new Octokit({ auth: githubToken });
  const comments = await octokit.paginate(
    octokit.rest.pulls.listCommentsForReview,
    {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.pullNumber,
      review_id: reviewId,
      per_page: 100,
    }
  );
  return comments.map((comment) => ({
    path: comment.path,
    line: comment.line ?? comment.original_line ?? null,
    body: comment.body ?? "",
  }));
}

function buildAutoFeedback(
  reviewBody: string,
  reviewComments: Array<{ path: string; line: number | null; body: string }>
): string {
  const lines: string[] = [];
  if (reviewBody.trim()) {
    lines.push("## Automated Review Summary", reviewBody.trim(), "");
  }
  if (reviewComments.length > 0) {
    lines.push("## Automated Review Inline Comments");
    for (const comment of reviewComments) {
      lines.push(`### ${comment.path}:${comment.line ?? "?"}`);
      lines.push(comment.body.trim() || "(empty comment)");
      lines.push("");
    }
  }
  if (lines.length === 0) {
    lines.push("No feedback available.");
  }
  return lines.join("\n").trim();
}

function buildPrompt(params: {
  mode: RevisionMode;
  ticketKey: string;
  prUrl: string;
  branch: string;
  reviewState: string;
  feedback: string;
}): string {
  return `You are addressing PR review feedback for ${params.ticketKey}.

PR: ${params.prUrl}
Branch: ${params.branch}
Trigger: ${params.mode}
Review state: ${params.reviewState}

Address ALL of the following feedback:

${params.feedback}

Instructions:
1. Read the review comments carefully
2. Make the requested changes
3. Run tests to verify nothing is broken
4. Commit with message: "${params.ticketKey}: Address review feedback

Co-Authored-By: Oz <oz-agent@warp.dev>"
5. Push to the existing branch (do NOT create a new PR)`;
}

async function resolveTrackedRevisionContext(pr: PullRequestRef): Promise<TrackedRevisionContext | null> {
  const runs = await getRunsByPrUrl(pr.htmlUrl);
  if (runs.length === 0) return null;

  const trackedRun = runs[0]!;
  const projectConfig = await getProjectConfig(trackedRun.project_key);
  if (!projectConfig) return null;

  const ticketKey = extractTicketKeyFromBranch(pr.branch);
  if (!ticketKey) return null;

  const { githubToken } = resolveProjectTokens(projectConfig);
  return {
    pr,
    ticketKey,
    projectKey: projectConfig.project_key,
    projectConfig,
    githubToken,
  };
}

/**
 * Spawn an Oz revision run for the given PR/branch and return the new run id, its
 * run-record id. The run record is inserted only after the Oz spawn succeeds so a
 * spawn failure cannot leave an orphaned `status='running'` row. The resolved
 * `config` is passed in by the caller (which already loaded it) to avoid a
 * redundant `getProjectConfig` round-trip.
 */
async function spawnRevisionRun(params: {
  ticketKey: string;
  config: ProjectConfig;
  branch: string;
  prUrl: string;
  mode: RevisionMode;
  reviewState: string;
  feedback: string;
}): Promise<{ runRecordId: string; runId: string }> {
  const { config } = params;
  const { ozApiKey } = resolveProjectTokens(config);
  const issue = await jira.getIssue(params.ticketKey);
  const model = resolveModel(issue, config);
  const mcpServers = config.mcp_servers as Record<string, McpServerConfig> | null;
  const agentIdentityUid = config.oz_agent_identity_uid?.trim() || undefined;
  const client = getOzClient(ozApiKey);
  const spawnedAt = new Date();

  const runResponse = await client.agent.run({
    prompt: buildPrompt({
      mode: params.mode,
      ticketKey: params.ticketKey,
      prUrl: params.prUrl,
      branch: params.branch,
      reviewState: params.reviewState,
      feedback: params.feedback,
    }),
    ...(agentIdentityUid ? { agent_identity_uid: agentIdentityUid } : {}),
    config: {
      name: params.ticketKey,
      environment_id: config.oz_env_id,
      ...(model ? { model_id: model } : {}),
      ...(mcpServers ? { mcp_servers: mcpServers } : {}),
    },
  });

  let sessionLink: string | null = null;
  try {
    const runDetails = await client.agent.runs.retrieve(runResponse.run_id);
    sessionLink = runDetails.session_link ?? null;
  } catch (err) {
    console.warn(
      `[revision] Failed to fetch session link for ${params.ticketKey} (${runResponse.run_id}):`,
      err
    );
  }
  const runRecord = await createRun({
    ticketKey: params.ticketKey,
    runType: "revision",
    status: "running",
    runId: runResponse.run_id,
    model: model ?? null,
    spawnedAt,
    sessionLink,
  });

  return { runRecordId: runRecord.id, runId: runResponse.run_id };
}

async function getPullRequestHeadBranch(
  githubToken: string,
  pr: Pick<PullRequestRef, "owner" | "repo" | "pullNumber">
): Promise<string> {
  const octokit = new Octokit({ auth: githubToken });
  const { data } = await octokit.rest.pulls.get({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pullNumber,
  });
  return data.head.ref;
}

function extractManualInstructions(commentBody: string): string {
  return commentBody.replace(/\/revise\b/gi, "").trim();
}

type SpawnRevisionParams = Parameters<typeof spawnRevisionRun>[0];

type GuardedRevisionOutcome =
  | { status: "spawned"; runId: string }
  | { status: "duplicate" }
  | { status: "in_progress" };

/**
 * Guarded revision spawn. Two safeguards run before the (expensive) Oz spawn:
 *  1. Idempotency — a stable per-delivery `eventKey` is recorded so a redelivered
 *     webhook (GitHub retries) does not spawn a duplicate run.
 *  2. Concurrency — an atomic running-run claim ensures rapid successive reviews
 *     cannot start overlapping revision agents on the same branch.
 * On success a new `dispatch_runs` row is inserted for the revision attempt. If
 * either spawn or run-record creation fails, the claim and idempotency entry are
 * released so a genuine retry can proceed.
 */
async function recordAndSpawnRevision(params: {
  eventKey: string;
  spawn: SpawnRevisionParams;
}): Promise<GuardedRevisionOutcome> {
  const { ticketKey, prUrl } = params.spawn;

  const recorded = await tryRecordRevisionEvent({
    eventKey: params.eventKey,
    ticketKey,
    prUrl,
  });
  if (!recorded) return { status: "duplicate" };

  const claim = await claimRevisionSlot(ticketKey);
  if (!claim.claimed) {
    // The idempotency event key recorded above is intentionally NOT cleaned up
    // here. A review that arrives while a revision is already running for this PR
    // is dropped (not queued), and keeping the event-key record prevents a later
    // redelivery of the same review from spawning a duplicate. To force-reprocess
    // a dropped review, an operator must delete its row from `revision_events`.
    return { status: "in_progress" };
  }
  let spawnedRunRecordId: string | null = null;

  try {
    const run = await spawnRevisionRun(params.spawn);
    spawnedRunRecordId = run.runRecordId;
    return { status: "spawned", runId: run.runId };
  } catch (err) {
    await releaseRevisionSlot(
      ticketKey,
      claim.previousStatus,
      claim.previousRunId,
      spawnedRunRecordId
    ).catch(() => {});
    await deleteRevisionEvent(params.eventKey).catch(() => {});
    throw err;
  }
}

export async function handleGithubRevisionWebhook(params: {
  event: string;
  payload: unknown;
}): Promise<RevisionDecision> {
  const payload = params.payload as Record<string, any>;

  if (params.event === "pull_request_review_comment") {
    const isReply = payload.comment?.in_reply_to_id != null;
    return {
      action: "ignored",
      reason: isReply
        ? "review comment reply does not trigger revision"
        : "review comment events are ignored; wait for submitted review",
    };
  }

  if (params.event === "pull_request_review") {
    if (payload.action !== "submitted") {
      return { action: "ignored", reason: "review action is not submitted" };
    }

    const prUrl = payload.pull_request?.html_url;
    const branch = payload.pull_request?.head?.ref;
    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    const pullNumber = parsePrNumber(payload.pull_request?.number);
    const reviewId = parsePrNumber(payload.review?.id);
    const reviewState = String(payload.review?.state ?? "unknown").toLowerCase();
    const reviewBody = String(payload.review?.body ?? "");
    if (!prUrl || !branch || !owner || !repo || pullNumber == null || reviewId == null) {
      return { action: "ignored", reason: "review payload missing PR metadata" };
    }

    const context = await resolveTrackedRevisionContext({
      htmlUrl: prUrl,
      branch,
      owner,
      repo,
      pullNumber,
    });
    if (!context) {
      return { action: "ignored", reason: "PR is not tracked or branch has no ticket key" };
    }

    const inlineReviewComments = await listReviewComments(
      context.githubToken,
      context.pr,
      reviewId
    );
    const actionItems = extractActionItemIds([
      reviewBody,
      ...inlineReviewComments.map((comment) => comment.body),
    ]);
    if (actionItems.length === 0) {
      return { action: "ignored", reason: "review has no action items" };
    }

    const feedback = buildAutoFeedback(reviewBody, inlineReviewComments);
    const outcome = await recordAndSpawnRevision({
      eventKey: `review:${reviewId}`,
      spawn: {
        ticketKey: context.ticketKey,
        config: context.projectConfig,
        branch: context.pr.branch,
        prUrl: context.pr.htmlUrl,
        mode: "auto_review_submitted",
        reviewState,
        feedback,
      },
    });
    if (outcome.status === "duplicate") {
      return { action: "ignored", reason: "duplicate review delivery already processed" };
    }
    if (outcome.status === "in_progress") {
      return { action: "ignored", reason: "revision already in progress for this PR" };
    }
    return {
      action: "spawned",
      mode: "auto_review_submitted",
      ticketKey: context.ticketKey,
      runId: outcome.runId,
      actionItemCount: actionItems.length,
    };
  }

  if (params.event === "issue_comment") {
    if (payload.action !== "created") {
      return { action: "ignored", reason: "issue comment action is not created" };
    }
    const commentBody = String(payload.comment?.body ?? "");
    if (!REVISE_COMMAND_REGEX.test(commentBody)) {
      return { action: "ignored", reason: "issue comment has no /revise command" };
    }
    if (!payload.issue?.pull_request) {
      return { action: "ignored", reason: "issue comment is not on a pull request" };
    }
    const prUrl = payload.issue?.pull_request?.html_url ?? payload.issue?.html_url ?? null;
    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    const pullNumber = parsePrNumber(payload.issue?.number);
    if (!prUrl) {
      return { action: "ignored", reason: "missing pull request URL on comment event" };
    }
    if (!owner || !repo || pullNumber == null) {
      return { action: "ignored", reason: "issue comment payload missing PR metadata" };
    }
    // GitHub always sends a comment id; require it so the idempotency ledger is
    // never silently bypassed (a missing id would otherwise skip dedup entirely).
    const commentId = parsePrNumber(payload.comment?.id);
    if (commentId == null) {
      return { action: "ignored", reason: "issue comment missing id" };
    }

    const runs = await getRunsByPrUrl(prUrl);
    if (runs.length === 0) {
      return { action: "ignored", reason: "PR is not tracked" };
    }
    const projectConfig = await getProjectConfig(runs[0]!.project_key);
    if (!projectConfig) {
      return { action: "ignored", reason: "project is not configured" };
    }

    const { githubToken } = resolveProjectTokens(projectConfig);
    const effectiveBranch = await getPullRequestHeadBranch(githubToken, {
      owner,
      repo,
      pullNumber,
    });
    const ticketFromBranch = extractTicketKeyFromBranch(effectiveBranch);
    const ticketFromComment = parseTicketKeyFromText(commentBody);
    const fallbackTicket = runs[0]!.ticket_key;
    const ticketKey = ticketFromBranch ?? ticketFromComment ?? fallbackTicket;

    const instructions = extractManualInstructions(commentBody);
    const feedback = instructions || "No additional instruction provided after /revise.";

    const outcome = await recordAndSpawnRevision({
      eventKey: `comment:${commentId}`,
      spawn: {
        ticketKey,
        config: projectConfig,
        branch: effectiveBranch,
        prUrl,
        mode: "manual_comment",
        reviewState: "manual",
        feedback,
      },
    });
    if (outcome.status === "duplicate") {
      return { action: "ignored", reason: "duplicate comment delivery already processed" };
    }
    if (outcome.status === "in_progress") {
      return { action: "ignored", reason: "revision already in progress for this PR" };
    }

    return {
      action: "spawned",
      mode: "manual_comment",
      ticketKey,
      runId: outcome.runId,
      actionItemCount: 1,
    };
  }

  return { action: "ignored", reason: "event is not handled for revisions" };
}
