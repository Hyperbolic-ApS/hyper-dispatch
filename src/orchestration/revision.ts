import { Octokit } from "@octokit/rest";
import type { McpServerConfig } from "oz-agent-sdk/resources/agent/agent";
import { resolveProjectTokens } from "../config/env.js";
import {
  claimRevisionSlot,
  deleteRevisionEvent,
  getOpenFindings,
  getProjectConfig,
  getRevisionState,
  getRunsByPrUrl,
  releaseRevisionSlot,
  setNeedsHuman,
  tryRecordRevisionEvent,
  updateRunStatus,
  upsertFindings,
} from "../db/queries.js";
import type { DispatchRun, ProjectConfig } from "../db/queries.js";
import * as jira from "../jira/client.js";
import { dismissSupersededReviews } from "../github/reviews.js";
import { actionableFindings, parseFindings } from "./findings.js";
import { projectLedger } from "./ledger.js";
import { getOzClient } from "./oz-client.js";
import { decideReviewAction } from "./review-gate.js";
import { resolveRevisionModel } from "./spawner.js";

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
  prDisplayState: DispatchRun["pr_display_state"];
}

type RevisionDecision =
  | { action: "ignored"; reason: string }
  | { action: "approve_terminal" }
  | { action: "escalated_human"; reason: string }
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
  return `You are triaging PR review feedback for ${params.ticketKey}.

PR: ${params.prUrl}
Branch: ${params.branch}
Trigger: ${params.mode}
Review state: ${params.reviewState}

Review feedback (only Blocking/Major items are actionable):

${params.feedback}

This is the binding contract: docs/contract/review-revise-contract.md.
External review feedback is a set of SUGGESTIONS TO EVALUATE, not orders. For
EACH finding, decide and act:
  - FIX: correct, in-scope, and Blocking/Major → implement it.
  - DEFER: out-of-scope or speculative ("do it properly", future hardening) →
    do NOT write code. Reply on the thread: "out of scope for this slice."
  - REJECT: technically wrong for this codebase/stack → reply with the technical
    reason. Verify against the code before rejecting; if a thing is unused, say
    so (YAGNI) rather than building it.
Procedure:
1. Read all feedback first. If any item is unclear, do not guess — note it.
2. Verify each item against the actual code before changing anything.
3. Implement in order: Blocking → simple → complex. Test after EACH change.
4. Do not add features/abstractions beyond the ticket's scope to satisfy a
   suggestion. Match the existing code's conventions.
5. No performative agreement in replies — state the fix or the pushback.
6. Commit: "${params.ticketKey}: Address review feedback

Co-Authored-By: Oz <oz-agent@warp.dev>"
7. Push to the existing branch (do NOT open a new PR).`;
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
    prDisplayState: trackedRun.pr_display_state,
  };
}

/**
 * Spawn an Oz revision run for the given PR/branch and return the new run id, its
 * run-record id. The run record is claimed atomically by claimRevisionSlot before
 * this function executes, so there is no claim→create gap. The resolved `config`
 * is passed in by the caller (which already loaded it) to avoid a redundant
 * `getProjectConfig` round-trip.
 */
async function spawnRevisionRun(params: {
  ticketKey: string;
  runRecordId: string;
  config: ProjectConfig;
  branch: string;
  prUrl: string;
  mode: RevisionMode;
  reviewState: string;
  feedback: string;
  floorTier?: string | null;
  escalate?: boolean;
}): Promise<{ runRecordId: string; runId: string }> {
  const { config } = params;
  const { ozApiKey } = resolveProjectTokens(config);
  const issue = await jira.getIssue(params.ticketKey);
  const model = resolveRevisionModel(issue, config, {
    floorTier: params.floorTier ?? null,
    escalate: params.escalate ?? false,
  });
  const mcpServers = config.mcp_servers as Record<string, McpServerConfig> | null;
  const agentIdentityUid = config.oz_agent_identity_uid?.trim() || undefined;
  const client = getOzClient(ozApiKey);
  const spawnedAt = new Date();

  const runResponse = await client.agent
    .run({
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
    })
    .catch((err: unknown) => {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      (wrapped as SpawnRevisionError).runRecordId = params.runRecordId;
      throw wrapped;
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
  await updateRunStatus(params.ticketKey, {
    run_record_id: params.runRecordId,
    run_type: "revision",
    run_id: runResponse.run_id,
    model: model ?? null,
    spawned_at: spawnedAt,
    session_link: sessionLink,
  });
  return { runRecordId: params.runRecordId, runId: runResponse.run_id };
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

type SpawnRevisionParams = Omit<
  Parameters<typeof spawnRevisionRun>[0],
  "runRecordId"
>;
type SpawnRevisionError = Error & { runRecordId?: string };

type GuardedRevisionOutcome =
  | { status: "spawned"; runId: string }
  | { status: "duplicate" }
  | { status: "in_progress" };

/**
 * Guarded revision spawn. Two safeguards run before the (expensive) Oz spawn:
 *  1. Idempotency — a stable per-delivery `eventKey` is recorded so a redelivered
 *     webhook (GitHub retries) does not spawn a duplicate run.
 *  2. Concurrency — an atomic running-run claim ensures rapid successive reviews
 *     cannot start overlapping revision agents on the same branch, and it inserts
 *     the claimed running revision row in the same statement.
 * If spawn fails, the claim and idempotency entry are released so a genuine retry
 * can proceed.
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
  let spawnedRunRecordId: string | null = claim.runRecordId;

  try {
    if (!claim.runRecordId) {
      throw new Error("Claimed revision slot is missing run record id");
    }
    const run = await spawnRevisionRun({
      ...params.spawn,
      runRecordId: claim.runRecordId,
    });
    spawnedRunRecordId = run.runRecordId;
    return { status: "spawned", runId: run.runId };
  } catch (err) {
    const failedRunRecordId =
      spawnedRunRecordId ??
      ((err as SpawnRevisionError)?.runRecordId ?? null);
    await releaseRevisionSlot(
      ticketKey,
      claim.previousStatus,
      claim.previousRunId,
      failedRunRecordId
    ).catch(() => {});
    await deleteRevisionEvent(params.eventKey).catch(() => {});
    throw err;
  }
}

async function escalateToHuman(
  ctx: TrackedRevisionContext,
  reason: string,
  findings: { title: string; severity?: string }[]
): Promise<void> {
  await setNeedsHuman(ctx.ticketKey, true);
  const octokit = new Octokit({ auth: ctx.githubToken });
  const open = findings.map((f) => `- [${f.severity ?? "?"}] ${f.title}`).join("\n");
  await octokit.rest.issues.createComment({
    owner: ctx.pr.owner,
    repo: ctx.pr.repo,
    issue_number: ctx.pr.pullNumber,
    body: `⚠️ **Auto-revision stopped — needs human review**\n\nReason: ${reason}\n\nRemaining findings:\n${open}\n\nReply with \`/revise\` to resume auto-revision after triaging.`,
  });
  try {
    const transitions = await jira.getTransitions(ctx.ticketKey);
    const target = transitions.transitions.find(
      (t) => t.name.trim().toLowerCase() === ctx.projectConfig.in_review_column_name.toLowerCase()
    );
    if (target) await jira.transitionIssue(ctx.ticketKey, target.id);
  } catch (err) {
    console.warn(
      `[revision] Failed to transition ${ctx.ticketKey} to In Review during escalation:`,
      err
    );
  }
  await projectLedger(octokit, ctx.pr, ctx.pr.htmlUrl).catch((err) => {
    console.warn(`[revision] Failed to project ledger during escalation for ${ctx.ticketKey}:`, err);
  });
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
    const findings = parseFindings([
      reviewBody,
      ...inlineReviewComments.map((comment) => comment.body),
    ]);
    const actionable = actionableFindings(findings);
    const state = await getRevisionState(context.ticketKey);

    const decision = decideReviewAction({
      reviewState,
      actionableCount: actionable.length,
      round: state?.round ?? 0,
      budget: state?.budget ?? 2,
      prState: context.prDisplayState,
      needsHuman: state?.needsHuman ?? false,
    });

    if (decision.action === "approve_terminal") {
      return { action: "approve_terminal" };
    }
    if (decision.action === "ignore") {
      return { action: "ignored", reason: decision.reason };
    }
    if (decision.action === "escalate_human") {
      await escalateToHuman(context, decision.reason, actionable);
      return { action: "escalated_human", reason: decision.reason };
    }

    // decision.action === "revise"
    // Read-only repeat check: detect whether any actionable finding was already
    // seen in a prior round. This is a SELECT — no upsert before spawn — so a
    // deduped/dropped delivery cannot burn a budget round or corrupt the ledger.
    const existingFindings = await getOpenFindings(context.pr.htmlUrl);
    const existingKeys = new Set(existingFindings.map((f) => f.finding_key));
    const escalate = actionable.some((f) => existingKeys.has(f.key));

    // Spawn FIRST: the idempotency (tryRecordRevisionEvent) and concurrency
    // (claimRevisionSlot) guards live inside recordAndSpawnRevision. Writing the
    // round/findings before those guards would burn a budget round whenever a
    // redelivered or concurrent webhook is deduped/dropped without ever running a
    // revision. The round/findings writes therefore happen only after the slot is
    // actually claimed and the run is spawned.
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
        floorTier: state?.reviewTier ?? null,
        escalate,
      },
    });
    if (outcome.status === "duplicate") {
      return { action: "ignored", reason: "duplicate review delivery already processed" };
    }
    if (outcome.status === "in_progress") {
      return { action: "ignored", reason: "revision already in progress for this PR" };
    }
    await upsertFindings(
      context.pr.htmlUrl,
      context.ticketKey,
      (state?.round ?? 0) + 1,
      actionable
    );
    const reviewOctokit = new Octokit({ auth: context.githubToken });
    await dismissSupersededReviews(reviewOctokit, context.pr, reviewId).catch((err) =>
      console.warn("[revision] dismissSupersededReviews failed:", err)
    );
    await projectLedger(reviewOctokit, context.pr, context.pr.htmlUrl).catch((err) =>
      console.warn("[revision] projectLedger failed:", err)
    );
    return {
      action: "spawned",
      mode: "auto_review_submitted",
      ticketKey: context.ticketKey,
      runId: outcome.runId,
      actionItemCount: actionable.length,
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
