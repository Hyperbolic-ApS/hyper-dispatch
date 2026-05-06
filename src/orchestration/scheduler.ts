import { env } from "../config/env.js";
import * as jira from "../jira/client.js";
import {
  getActiveRunCount,
  getRunsByStatus,
  getProjectConfig,
} from "../db/queries.js";
import { spawnAgent } from "./spawner.js";

const SCHEDULER_INTERVAL_MS = 30_000;

/**
 * Process the queue: spawn agents for queued runs up to the concurrency cap.
 * Returns the number of agents spawned in this cycle.
 */
export async function processQueue(): Promise<number> {
  const activeCount = await getActiveRunCount();
  if (activeCount >= env.MAX_CONCURRENT_AGENTS) {
    console.log(
      `[scheduler] At capacity (${activeCount}/${env.MAX_CONCURRENT_AGENTS} running). Skipping.`
    );
    return 0;
  }

  const slots = env.MAX_CONCURRENT_AGENTS - activeCount;
  const queued = await getRunsByStatus("queued");

  let spawned = 0;

  for (const run of queued) {
    if (spawned >= slots) break;

    // Dedup: skip if a running entry exists for this ticket
    // (can happen if the DB is slightly stale between polling cycles)
    try {
      const config = await getProjectConfig(run.project_key);
      if (!config) {
        console.warn(
          `[scheduler] No config for project ${run.project_key}, skipping ${run.ticket_key}`
        );
        continue;
      }

      const issue = await jira.getIssue(run.ticket_key);
      await spawnAgent(run.ticket_key, config, issue);
      spawned++;
    } catch (err) {
      console.error(
        `[scheduler] Failed to spawn agent for ${run.ticket_key}:`,
        err
      );
      // Continue processing remaining queued runs
    }
  }

  if (spawned > 0) {
    console.log(`[scheduler] Spawned ${spawned} agent(s) this cycle.`);
  }

  return spawned;
}

/**
 * Start the scheduler background loop.
 * Returns a cleanup function that stops the interval.
 */
export function startSchedulerLoop(): () => void {
  console.log(
    `[scheduler] Starting loop (interval: ${SCHEDULER_INTERVAL_MS}ms, max concurrent: ${env.MAX_CONCURRENT_AGENTS})`
  );

  const handle = setInterval(async () => {
    try {
      await processQueue();
    } catch (err) {
      console.error("[scheduler] Unhandled error in processQueue:", err);
    }
  }, SCHEDULER_INTERVAL_MS);

  return () => {
    clearInterval(handle);
    console.log("[scheduler] Loop stopped.");
  };
}
