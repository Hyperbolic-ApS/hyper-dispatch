import { env } from "../config/env.js";
import * as jira from "../jira/client.js";
import {
  claimRunForSpawn,
  deleteRun,
  getActiveRunCount,
  getRunsByProject,
  getRunsByStatus,
  listActiveProjectConfigs,
  releaseSpawnClaim,
  type ProjectConfig,
} from "../db/queries.js";
import { spawnAgent } from "./spawner.js";
import { syncTicketInToDo } from "./ticket-sync.js";

async function reconcileProjectRuns(config: ProjectConfig): Promise<void> {
  const [toDoIssues, existingRuns] = await Promise.all([
    jira.searchIssuesInStatus(config.project_key, config.to_do_column_name, [
      "summary",
      "priority",
      "status",
      "issuelinks",
    ]),
    getRunsByProject(config.project_key),
  ]);

  const existingByTicket = new Set(existingRuns.map((run) => run.ticket_key));
  const missingToDoTickets = toDoIssues.filter(
    (issue) => !existingByTicket.has(issue.key)
  );

  for (const issue of missingToDoTickets) {
    try {
      const result = await syncTicketInToDo(issue.key, config.project_key);
      console.log(
        `[scheduler] Polling discovered ${issue.key} in ${config.to_do_column_name} (${result.action}).`
      );
    } catch (err) {
      console.error(
        `[scheduler] Failed to ingest polled To Do ticket ${issue.key}:`,
        err
      );
    }
  }

  for (const run of existingRuns) {
    try {
      await jira.getIssue(run.ticket_key, ["status"]);
    } catch (err) {
      const status =
        err instanceof jira.JiraApiError
          ? err.status
          : (err as { status?: number } | null)?.status;
      if (status === 404) {
        await deleteRun(run.ticket_key);
        console.log(
          `[scheduler] Removed ${run.ticket_key} from dispatch_runs because it no longer exists in Jira.`
        );
        continue;
      }
      console.warn(
        `[scheduler] Could not verify Jira existence for ${run.ticket_key}:`,
        err
      );
    }
  }
}

async function reconcilePollingState(): Promise<void> {
  const projects = await listActiveProjectConfigs();
  for (const project of projects) {
    try {
      await reconcileProjectRuns(project);
    } catch (err) {
      console.error(
        `[scheduler] Polling reconciliation failed for project ${project.project_key}:`,
        err
      );
    }
  }
}

const SCHEDULER_INTERVAL_MS = 30_000;

/**
 * Process the queue: spawn agents for queued runs up to the concurrency cap.
 * Returns the number of agents spawned in this cycle.
 */
export async function processQueue(): Promise<number> {
  await reconcilePollingState();
  const activeCount = await getActiveRunCount();
  if (activeCount >= env.MAX_CONCURRENT_AGENTS) {
    console.log(
      `[scheduler] At capacity (${activeCount}/${env.MAX_CONCURRENT_AGENTS} running). Skipping.`
    );
    return 0;
  }

  const slots = env.MAX_CONCURRENT_AGENTS - activeCount;
  const queued = await getRunsByStatus("queued");
  const activeProjects = await listActiveProjectConfigs();
  const projectsByKey = new Map(
    activeProjects.map((project) => [project.project_key, project])
  );

  let spawned = 0;

  for (const run of queued) {
    if (spawned >= slots) break;
    try {
      const claimed = await claimRunForSpawn(run.ticket_key);
      if (!claimed) {
        continue;
      }
      const config = projectsByKey.get(run.project_key);
      if (!config) {
        console.warn(
          `[scheduler] Skipping ${run.ticket_key}: project ${run.project_key} is not configured.`
        );
        await releaseSpawnClaim(run.ticket_key);
        continue;
      }

      const issue = await jira.getIssue(run.ticket_key);
      await spawnAgent(run.ticket_key, config, issue);
      spawned++;
    } catch (err) {
      await releaseSpawnClaim(run.ticket_key);
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

  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | null = null;

  const runCycle = async (): Promise<void> => {
    if (stopped) return;

    try {
      await processQueue();
    } catch (err) {
      console.error("[scheduler] Unhandled error in processQueue:", err);
    } finally {
      if (!stopped) {
        handle = setTimeout(runCycle, SCHEDULER_INTERVAL_MS);
      }
    }
  };

  handle = setTimeout(runCycle, SCHEDULER_INTERVAL_MS);

  return () => {
    stopped = true;
    if (handle) {
      clearTimeout(handle);
    }
    console.log("[scheduler] Loop stopped.");
  };
}
