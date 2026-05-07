import { Octokit } from "@octokit/rest";
import OzAPI from "oz-agent-sdk";
import type { ArtifactItem } from "oz-agent-sdk/resources/agent/runs.js";
import { env } from "../config/env.js";
import { getProjectConfig } from "../db/config-queries.js";
import { getRunsByStatus, updateRunStatus } from "../db/queries.js";
import * as jira from "../jira/client.js";
import { buildPreviewUrl, parseGitHubPrUrl } from "../preview/url.js";

const MONITOR_INTERVAL_MS = 30_000;

// Non-terminal (in-flight) states
const INPROGRESS_STATES = new Set([
  "QUEUED",
  "PENDING",
  "CLAIMED",
  "INPROGRESS",
]);

// Lazy singletons
let _ozClient: OzAPI | null = null;
let _githubClient: Octokit | null = null;

function getOzClient(): OzAPI {
  if (!_ozClient) {
    _ozClient = new OzAPI({ apiKey: env.WARP_API_KEY });
  }
  return _ozClient;
}

function getGithubClient(): Octokit {
  if (!_githubClient) {
    _githubClient = new Octokit({ auth: env.GITHUB_TOKEN });
  }
  return _githubClient;
}

async function postPreviewComment(
  prUrl: string,
  deploymentUrl: string,
  authToken: string,
  ticketKey: string
): Promise<void> {
  const previewUrl = buildPreviewUrl(prUrl, deploymentUrl);
  const parsed = parseGitHubPrUrl(prUrl);
  if (!previewUrl || !parsed) return;

  const octokit = new Octokit({ auth: authToken });
  const body = `**Preview deployment**: ${previewUrl}\n\nThis environment was deployed automatically for PR #${parsed.prNumber}.`;

  try {
    await octokit.issues.createComment({
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.prNumber,
      body,
    });
    console.log(
      `[monitor] Posted preview link to PR for ${ticketKey}: ${previewUrl}`
    );
  } catch (err) {
    console.warn(`[monitor] Failed to post preview comment for ${ticketKey}:`, err);
  }
}

/**
 * Extract the GitHub PR URL from a run's artifact list, if present.
 */
function extractPrUrl(artifacts: ArtifactItem[] | undefined): string | null {
  if (!artifacts) return null;
  for (const artifact of artifacts) {
    if (artifact.artifact_type === "PULL_REQUEST") {
      return artifact.data.url ?? null;
    }
  }
  return null;
}


async function transitionMergedPrsToDone(): Promise<void> {
  const succeededRuns = await getRunsByStatus("succeeded");
  if (succeededRuns.length === 0) return;

  const githubClient = getGithubClient();

  for (const run of succeededRuns) {
    if (!run.pr_url) continue;

    // Avoid repeated transition attempts once issue is already done.
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

    const parsed = parseGitHubPrUrl(run.pr_url);
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
        pull_number: parsed.prNumber,
      });

      if (!pullRequest.merged_at) continue;

      const transitions = await jira.getTransitions(run.ticket_key);
      const doneTransition = transitions.transitions.find(
        (transition) => transition.name === "Done"
      );
      if (!doneTransition) {
        console.warn(`[monitor] No Done transition found for ${run.ticket_key}`);
        continue;
      }

      await jira.transitionIssue(run.ticket_key, doneTransition.id);
      console.log(
        `[monitor] ${run.ticket_key} moved to Done after PR merge: ${run.pr_url}`
      );
    } catch (err) {
      console.warn(
        `[monitor] Failed to process merged PR for ${run.ticket_key}:`,
        err
      );
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
    const client = getOzClient();
    const maxDurationMs = env.MAX_RUN_DURATION_HOURS * 60 * 60 * 1000;
    const now = new Date();

    for (const run of runningRuns) {
      if (!run.run_id) {
        console.warn(`[monitor] Run for ${run.ticket_key} has no run_id, skipping.`);
        continue;
      }

      try {
        const ozRun = await client.agent.runs.retrieve(run.run_id);
        const state = ozRun.state;

        if (state === "SUCCEEDED") {
          const prUrl = extractPrUrl(ozRun.artifacts);
          const sessionLink = ozRun.session_link ?? null;

          await updateRunStatus(run.ticket_key, {
            status: "succeeded",
            completed_at: now,
            pr_url: prUrl,
            session_link: sessionLink,
          });

          // Transition Jira to "In Review" (best-effort)
          try {
            const transitions = await jira.getTransitions(run.ticket_key);
            const inReview = transitions.transitions.find(
              (transition) => transition.name === "In Review"
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

          if (prUrl) {
            try {
              const cfg = await getProjectConfig(run.project_key);
              const deploymentUrl = cfg?.deployment_url ?? null;
              const authToken = cfg?.github_pat ?? env.GITHUB_TOKEN;
              if (deploymentUrl && authToken) {
                await postPreviewComment(
                  prUrl,
                  deploymentUrl,
                  authToken,
                  run.ticket_key
                );
              } else {
                console.log(
                  `[monitor] Skipping preview comment for ${run.ticket_key}: missing deployment_url or auth token`
                );
              }
            } catch (err) {
              console.warn(
                `[monitor] Preview-comment step failed for ${run.ticket_key}:`,
                err
              );
            }
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