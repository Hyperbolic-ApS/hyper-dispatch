import type { Octokit } from "@octokit/rest";
import type { ArtifactItem } from "oz-agent-sdk/resources/agent/runs.js";
import { env, resolveProjectTokens } from "../config/env.js";
import * as jira from "../jira/client.js";
import {
  getRunsByStatus,
  getRunsWithActivePr,
  updateRunStatus,
  getProjectConfig,
} from "../db/queries.js";
import { resolveJiraColumnMappings } from "../jira/columns.js";
import { getOzClient } from "./oz-client.js";
import { transitionMergedPrToDone } from "./pr-merge.js";
import { derivePullRequestDisplayState } from "../github/pull-requests.js";
import { createGithubClient } from "../github/octokit.js";
import {
  getRepoWorkflowRuns,
  computePrActionState,
} from "../github/workflow-runs.js";

const MONITOR_INTERVAL_MS = 30_000;

// Non-terminal (in-flight) states
const INPROGRESS_STATES = new Set([
  "QUEUED",
  "PENDING",
  "CLAIMED",
  "INPROGRESS",
]);

// Hardened GitHub clients, memoized per token (global + per-project overrides)
// so rate-limit/retry/timeout handling is shared across calls with the same
// credential boundary.
const githubClientByToken = new Map<string, Octokit>();

function getGithubClient(token: string = env.GITHUB_TOKEN): Octokit {
  let client = githubClientByToken.get(token);
  if (!client) {
    client = createGithubClient(token);
    githubClientByToken.set(token, client);
  }
  return client;
}

/**
 * Extract a GitHub pull-request URL from a run status message.
 */
export function extractPrUrlFromStatusMessage(
  statusMessage: string | null | undefined
): string | null {
  if (!statusMessage) return null;

  const candidates = statusMessage.match(/https:\/\/github\.com\/[^\s)]+/gi) ?? [];
  for (const candidate of candidates) {
    const normalized = candidate.replace(/[.,);]+$/, "");
    if (parseGithubPullRequestUrl(normalized)) {
      return normalized;
    }
  }
  return null;
}

/**
 * Extract the GitHub PR URL from run artifacts, falling back to status text.
 */
export function extractPrUrl(
  artifacts: ArtifactItem[] | undefined,
  statusMessage?: string | null
): string | null {
  if (artifacts) {
    for (const artifact of artifacts) {
      if (artifact.artifact_type !== "PULL_REQUEST") continue;
      const artifactUrl = artifact.data.url;
      if (typeof artifactUrl === "string" && parseGithubPullRequestUrl(artifactUrl)) {
        return artifactUrl;
      }
    }
  }
  return extractPrUrlFromStatusMessage(statusMessage);
}

export function parseGithubPullRequestUrl(
  prUrl: string
): { owner: string; repo: string; pullNumber: number } | null {
  try {
    const parsedUrl = new URL(prUrl);
    const parts = parsedUrl.pathname.split("/").filter(Boolean);
    if (parts.length < 4) return null;

    const [owner, repo, type, pullNumberRaw] = parts;
    if (!owner || !repo || type !== "pull" || !pullNumberRaw) return null;

    const pullNumber = Number.parseInt(pullNumberRaw, 10);
    if (!Number.isFinite(pullNumber)) return null;

    return { owner, repo, pullNumber };
  } catch {
    return null;
  }
}

async function transitionMergedPrsToDone(): Promise<void> {
  const succeededRuns = await getRunsByStatus("succeeded");
  if (succeededRuns.length === 0) return;

  const githubClient = getGithubClient();

  for (const run of succeededRuns) {
    if (!run.pr_url) continue;

    // Once a PR reaches a terminal display state (merged/closed), its conflict and
    // display-state metadata no longer change, and the merged→Done transition has already
    // been attempted in the same cycle/path that first observed the terminal state (here,
    // the GitHub webhook, or pr-merge — all idempotent). Skipping these avoids re-fetching
    // every historical PR from GitHub on each 30s sweep as succeeded runs accumulate.
    if (run.pr_display_state === "merged" || run.pr_display_state === "closed") {
      continue;
    }

    const parsed = parseGithubPullRequestUrl(run.pr_url);
    if (!parsed) {
      console.warn(
        `[monitor] Could not parse GitHub PR URL for ${run.ticket_key}: ${run.pr_url}`
      );
      continue;
    }

    try {
      const { data: pullRequest } = await githubClient.pulls.get({
        owner: parsed.owner,
        repo: parsed.repo,
        pull_number: parsed.pullNumber,
      });
      const hasMergeConflicts =
        pullRequest.mergeable_state === "dirty" || pullRequest.mergeable === false;
      const prDisplayState = derivePullRequestDisplayState({
        merged_at: pullRequest.merged_at,
        state: pullRequest.state,
        draft: pullRequest.draft,
      });
      // Reconcile PR conflict/display-state metadata for every succeeded run,
      // regardless of Jira status, so historical runs (including those already
      // in Done) get backfilled.
      await updateRunStatus(run.ticket_key, {
        pr_has_conflicts: hasMergeConflicts,
        pr_display_state: prDisplayState,
      });

      if (!pullRequest.merged_at) continue;

      // Gate only the Jira transition on the Done check to avoid repeated
      // transition attempts once the issue is already done.
      try {
        const issue = await jira.getIssue(run.ticket_key, ["status"]);
        if (issue.fields.status.statusCategory.key === "done") {
          continue;
        }
      } catch (err) {
        console.warn(
          `[monitor] Failed to load Jira status for ${run.ticket_key}:`,
          err
        );
        continue;
      }

      await transitionMergedPrToDone(run, { logPrefix: "[monitor]" });
    } catch (err) {
      console.warn(
        `[monitor] Failed to process merged PR for ${run.ticket_key}:`,
        err
      );
    }
  }
}

/**
 * Resolve the review/revision workflow action-state for every run with an active
 * PR and persist it to `dispatch_runs`. Doing this here (out-of-band, every 30s)
 * is what keeps the dashboard render path free of live GitHub calls — the render
 * just reads `pr_review_running` / `pr_revision_running` from the DB.
 *
 * Work is grouped by repo + token so each repo's (bounded, cached) workflow runs
 * are fetched once, and writes only happen when a flag actually changed.
 */
export async function reconcilePrActionStates(): Promise<void> {
  const runs = await getRunsWithActivePr();
  if (runs.length === 0) return;

  // Resolve the effective GitHub token per project once.
  const projectKeys = [...new Set(runs.map((run) => run.project_key))];
  const configMap = new Map(
    await Promise.all(
      projectKeys.map(async (key) => [key, await getProjectConfig(key)] as const)
    )
  );

  type RepoGroup = {
    owner: string;
    repo: string;
    token: string;
    prs: { ticketKey: string; pullNumber: number; branchName: string }[];
  };
  const repoGroups = new Map<string, RepoGroup>();
  for (const run of runs) {
    if (!run.pr_url) continue;
    const parsed = parseGithubPullRequestUrl(run.pr_url);
    if (!parsed) continue;
    const config = configMap.get(run.project_key) ?? null;
    const token = config
      ? resolveProjectTokens(config).githubToken
      : env.GITHUB_TOKEN;
    const repoKey = `${parsed.owner}/${parsed.repo}::${token}`;
    let group = repoGroups.get(repoKey);
    if (!group) {
      group = { owner: parsed.owner, repo: parsed.repo, token, prs: [] };
      repoGroups.set(repoKey, group);
    }
    group.prs.push({
      ticketKey: run.ticket_key,
      pullNumber: parsed.pullNumber,
      branchName: `agent/${run.ticket_key}`,
    });
  }

  const runByTicket = new Map(runs.map((run) => [run.ticket_key, run]));

  for (const [repoKey, group] of repoGroups) {
    let workflowRuns;
    try {
      workflowRuns = await getRepoWorkflowRuns(
        getGithubClient(group.token),
        group.owner,
        group.repo,
        repoKey
      );
    } catch (err) {
      console.warn(
        `[monitor] Failed to fetch workflow runs for ${group.owner}/${group.repo}:`,
        err
      );
      continue;
    }
    for (const pr of group.prs) {
      const { reviewRunning, revisionRunning } = computePrActionState(
        workflowRuns,
        { pullNumber: pr.pullNumber, branchName: pr.branchName }
      );
      const current = runByTicket.get(pr.ticketKey);
      // Avoid write churn on every 30s sweep: only persist on an actual change.
      if (
        current &&
        Boolean(current.pr_review_running) === reviewRunning &&
        Boolean(current.pr_revision_running) === revisionRunning
      ) {
        continue;
      }
      await updateRunStatus(pr.ticketKey, {
        pr_review_running: reviewRunning,
        pr_revision_running: revisionRunning,
      });
    }
  }
}

/**
 * Check all currently-running dispatch runs against the Oz SDK.
 * Updates DB status for completed/failed/stale runs.
 * Also advances succeeded tickets to Done when their PR has been merged.
 */
export async function checkRuns(): Promise<void> {
  const runningRuns = await getRunsByStatus("running");

  if (runningRuns.length > 0) {
    const maxDurationMs = env.MAX_RUN_DURATION_HOURS * 60 * 60 * 1000;
    const now = new Date();

    // Deduplicate DB lookups — fetch each project config once regardless of
    // how many running runs share the same project key.
    const projectKeys = [...new Set(runningRuns.map(r => r.project_key))];
    const configMap = new Map(
      await Promise.all(projectKeys.map(async k => [k, await getProjectConfig(k)] as const))
    );

    for (const run of runningRuns) {
      if (!run.run_id) {
        console.warn(`[monitor] Run for ${run.ticket_key} has no run_id, skipping.`);
        continue;
      }

      try {
        const projectConfig = configMap.get(run.project_key) ?? null;
        const client = getOzClient(
          projectConfig
            ? resolveProjectTokens(projectConfig).ozApiKey
            : env.WARP_API_KEY
        );
        const ozRun = await client.agent.runs.retrieve(run.run_id);
        const state = ozRun.state;

        // The session link is usually not yet available at spawn time (the
        // shared session is created once the run bootstraps on a worker), so
        // backfill it for in-flight runs as soon as Oz exposes it. Terminal
        // branches below persist the link as part of their own updates.
        const isTerminalState =
          state === "SUCCEEDED" ||
          state === "FAILED" ||
          state === "ERROR" ||
          state === "CANCELLED";
        if (!isTerminalState && !run.session_link && ozRun.session_link) {
          await updateRunStatus(run.ticket_key, {
            session_link: ozRun.session_link,
          });
        }

        if (state === "SUCCEEDED") {
          const prUrl = extractPrUrl(ozRun.artifacts, ozRun.status_message?.message);
          const sessionLink = ozRun.session_link ?? null;

          await updateRunStatus(run.ticket_key, {
            status: "succeeded",
            completed_at: now,
            pr_url: prUrl,
            session_link: sessionLink,
          });

          // Transition Jira to "In Review" (best-effort)
          try {
            const columnMappings = resolveJiraColumnMappings({
              backlog: projectConfig?.backlog_column_name,
              toDo: projectConfig?.to_do_column_name,
              inProgress: projectConfig?.in_progress_column_name,
              inReview: projectConfig?.in_review_column_name,
              done: projectConfig?.done_column_name,
            });
            const transitions = await jira.getTransitions(run.ticket_key);
            const inReview = transitions.transitions.find(
              (t) => t.name.trim().toLowerCase() === columnMappings.inReview.toLowerCase()
            );
            if (inReview) {
              await jira.transitionIssue(run.ticket_key, inReview.id);
            }
          } catch (err) {
            console.warn(
              `[monitor] Failed to transition ${run.ticket_key} to In Review:`,
              err
            );
          }

          console.log(
            `[monitor] ${run.ticket_key} succeeded. PR: ${prUrl ?? "none"}`
          );
        } else if (state === "FAILED" || state === "ERROR") {
          const errorMsg =
            ozRun.status_message?.message ?? `Run ended with state: ${state}`;

          await updateRunStatus(run.ticket_key, {
            status: "failed",
            completed_at: now,
            error: errorMsg,
            session_link: ozRun.session_link ?? null,
          });

          console.error(`[monitor] ${run.ticket_key} failed: ${errorMsg}`);
        } else if (state === "CANCELLED") {
          // Treat external cancellation as stale
          await updateRunStatus(run.ticket_key, {
            status: "stale",
            completed_at: now,
            error: "Run was cancelled externally.",
            session_link: ozRun.session_link ?? null,
          });

          console.warn(`[monitor] ${run.ticket_key} was cancelled externally.`);
        } else if (INPROGRESS_STATES.has(state)) {
          // Check for staleness
          if (run.spawned_at) {
            const elapsed = now.getTime() - run.spawned_at.getTime();
            if (elapsed > maxDurationMs) {
              // Try to cancel the run
              try {
                await client.agent.runs.cancel(run.run_id);
              } catch {
                // Ignore cancel errors — run may have already finished
              }

              await updateRunStatus(run.ticket_key, {
                status: "stale",
                completed_at: now,
                error: `Run exceeded max duration of ${env.MAX_RUN_DURATION_HOURS}h.`,
                session_link: ozRun.session_link ?? null,
              });

              console.warn(
                `[monitor] ${run.ticket_key} marked stale (exceeded ${env.MAX_RUN_DURATION_HOURS}h).`
              );
            }
          }
        } else {
          // BLOCKED or any unknown state — log and leave as-is
          console.log(`[monitor] ${run.ticket_key} is in state ${state}, waiting.`);
        }
      } catch (err) {
        console.error(
          `[monitor] Error checking run for ${run.ticket_key}:`,
          err
        );
        // Do not crash the loop — continue with remaining runs
      }
    }
  }

  await transitionMergedPrsToDone();
  await reconcilePrActionStates();
}

/**
 * Start the monitor background loop.
 * Returns a cleanup function that stops the interval.
 */
export function startMonitorLoop(): () => void {
  console.log(
    `[monitor] Starting loop (interval: ${MONITOR_INTERVAL_MS}ms, max duration: ${env.MAX_RUN_DURATION_HOURS}h)`
  );

  const handle = setInterval(async () => {
    try {
      await checkRuns();
    } catch (err) {
      console.error("[monitor] Unhandled error in checkRuns:", err);
    }
  }, MONITOR_INTERVAL_MS);

  return () => {
    clearInterval(handle);
    console.log("[monitor] Loop stopped.");
  };
}