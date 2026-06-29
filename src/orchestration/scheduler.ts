import { env } from "../config/env.js";
import * as jira from "../jira/client.js";
import {
  claimRunForSpawn,
  deleteRun,
  getActiveRunCount,
  getEntriesByStatus,
  getRunsByProject,
  listActiveProjectConfigs,
  releaseSpawnClaim,
  setTicketStatuses,
  type ProjectConfig,
  updateRunStatus,
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

  if (existingRuns.length === 0) return;

  // Detect tickets deleted in Jira with a single batched bulk-fetch instead of one
  // getIssue per run. bulkfetch omits missing/inaccessible keys from `issues`, so any
  // existing run whose key is absent from the response no longer exists in Jira.
  let liveIssues;
  try {
    liveIssues = await jira.getIssuesByKeys(
      existingRuns.map((run) => run.ticket_key),
      ["status"]
    );
  } catch (err) {
    // If the batch request fails, skip deletions for this cycle rather than risk
    // removing runs whose tickets actually still exist.
    console.warn(
      `[scheduler] Could not verify Jira existence for project ${config.project_key}:`,
      err
    );
    return;
  }

  // Persist each live ticket's status so the dashboard can render it from the DB
  // (refreshed out-of-band here) instead of calling Jira on every page render.
  // Batched into a single UPDATE so the reconcile cost stays flat in N live issues.
  await setTicketStatuses(
    liveIssues.map((issue) => ({
      ticketKey: issue.key,
      statusName: issue.fields?.status?.name ?? null,
      statusCategory: issue.fields?.status?.statusCategory?.key ?? null,
    }))
  );

  const liveTicketKeys = new Set(liveIssues.map((issue) => issue.key));
  for (const run of existingRuns) {
    if (liveTicketKeys.has(run.ticket_key)) continue;
    await deleteRun(run.ticket_key);
    console.log(
      `[scheduler] Removed ${run.ticket_key} from dispatch_runs because it no longer exists in Jira.`
    );
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
async function rollbackClaimToQueued(
  ticketKey: string,
  context: string
): Promise<void> {
  try {
    await releaseSpawnClaim(ticketKey);
  } catch (rollbackErr) {
    console.error(
      `[scheduler] Failed to release spawn claim for ${ticketKey} (${context}):`,
      rollbackErr
    );
    try {
      await updateRunStatus(ticketKey, {
        status: "failed",
        error: `claim rollback failed (${context})`,
      });
    } catch (updateErr) {
      console.error(
        `[scheduler] Failed to persist fallback failure state for ${ticketKey}:`,
        updateErr
      );
    }
  }
}

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
  const queued = await getEntriesByStatus("queued");
  const activeProjects = await listActiveProjectConfigs();
  const projectsByKey = new Map(
    activeProjects.map((project) => [project.project_key, project])
  );

  let spawned = 0;

  for (const run of queued) {
    if (spawned >= slots) break;
    const claimed = await claimRunForSpawn(run.ticket_key);
    if (!claimed) {
      continue;
    }

    const config = projectsByKey.get(run.project_key);
    if (!config) {
      console.warn(
        `[scheduler] Skipping ${run.ticket_key}: project ${run.project_key} is not configured.`
      );
      await rollbackClaimToQueued(run.ticket_key, "missing project config");
      continue;
    }

    let issue;
    try {
      issue = await jira.getIssue(run.ticket_key);
    } catch (err) {
      await rollbackClaimToQueued(run.ticket_key, "jira issue fetch failure");
      console.error(
        `[scheduler] Failed to fetch Jira issue for ${run.ticket_key}:`,
        err
      );
      continue;
    }

    try {
      await spawnAgent(run.ticket_key, config, issue);
      spawned++;
    } catch (err) {
      try {
        await updateRunStatus(run.ticket_key, {
          status: "failed",
          error:
            err instanceof Error ? err.message : "spawnAgent failed after claim",
        });
      } catch (updateErr) {
        console.error(
          `[scheduler] Failed to mark ${run.ticket_key} as failed after spawn error:`,
          updateErr
        );
        await rollbackClaimToQueued(
          run.ticket_key,
          "post-spawn status persistence failure"
        );
      }
      console.error(
        `[scheduler] Failed to spawn agent for ${run.ticket_key}:`,
        err
      );
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
