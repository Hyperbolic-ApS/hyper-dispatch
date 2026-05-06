import OzAPI from "oz-agent-sdk";
import type { ArtifactItem } from "oz-agent-sdk/resources/agent/runs.js";
import { env } from "../config/env.js";
import * as jira from "../jira/client.js";
import { getRunsByStatus, updateRunStatus } from "../db/queries.js";

const MONITOR_INTERVAL_MS = 30_000;

// Terminal run states from the Oz SDK
const TERMINAL_STATES = new Set([
  "SUCCEEDED",
  "FAILED",
  "ERROR",
  "CANCELLED",
  "BLOCKED",
]);

// Non-terminal (in-flight) states
const INPROGRESS_STATES = new Set([
  "QUEUED",
  "PENDING",
  "CLAIMED",
  "INPROGRESS",
]);

// Lazy singleton
let _ozClient: OzAPI | null = null;

function getOzClient(): OzAPI {
  if (!_ozClient) {
    _ozClient = new OzAPI({ apiKey: env.WARP_API_KEY });
  }
  return _ozClient;
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

/**
 * Check all currently-running dispatch runs against the Oz SDK.
 * Updates DB status for completed/failed/stale runs.
 */
export async function checkRuns(): Promise<void> {
  const runningRuns = await getRunsByStatus("running");
  if (runningRuns.length === 0) return;

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
            (t) => t.name === "In Review"
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
          ozRun.status_message?.message ??
          `Run ended with state: ${state}`;

        await updateRunStatus(run.ticket_key, {
          status: "failed",
          completed_at: now,
          error: errorMsg,
          session_link: ozRun.session_link ?? null,
        });

        console.error(
          `[monitor] ${run.ticket_key} failed: ${errorMsg}`
        );
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
