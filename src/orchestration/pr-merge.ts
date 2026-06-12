import * as jira from "../jira/client.js";
import {
  getProjectConfig,
  getRunsBlockedBy,
  removeBlocker,
  type DispatchRun,
} from "../db/queries.js";
import { resolveJiraColumnMappings } from "../jira/columns.js";

export interface TransitionMergedPrToDoneOptions {
  logPrefix?: string;
}

/**
 * Idempotently transition a merged PR's Jira issue to Done and unblock dependents.
 */
export async function transitionMergedPrToDone(
  run: Pick<DispatchRun, "ticket_key" | "project_key" | "pr_url">,
  options: TransitionMergedPrToDoneOptions = {}
): Promise<void> {
  const logPrefix = options.logPrefix ?? "[monitor]";

  try {
    const issue = await jira.getIssue(run.ticket_key, ["status"]);
    if (issue.fields.status.statusCategory.key === "done") {
      return;
    }
  } catch (err) {
    console.warn(
      `${logPrefix} Failed to load Jira status for ${run.ticket_key}:`,
      err
    );
    return;
  }

  try {
    const config = await getProjectConfig(run.project_key);
    const columnMappings = resolveJiraColumnMappings({
      backlog: config?.backlog_column_name,
      toDo: config?.to_do_column_name,
      inProgress: config?.in_progress_column_name,
      inReview: config?.in_review_column_name,
      done: config?.done_column_name,
    });

    const transitions = await jira.getTransitions(run.ticket_key);
    const doneTransition = transitions.transitions.find(
      (t) => t.name.trim().toLowerCase() === columnMappings.done.toLowerCase()
    );
    if (!doneTransition) {
      console.warn(
        `${logPrefix} No ${columnMappings.done} transition found for ${run.ticket_key}`
      );
      return;
    }

    await jira.transitionIssue(run.ticket_key, doneTransition.id);

    let unblockedCount = 0;
    try {
      const blockedRuns = await getRunsBlockedBy(run.ticket_key);
      for (const blockedRun of blockedRuns) {
        const updated = await removeBlocker(blockedRun.ticket_key, run.ticket_key);
        if (updated) unblockedCount++;
      }
    } catch (err) {
      console.warn(
        `${logPrefix} Failed to unblock dependents for ${run.ticket_key}:`,
        err
      );
    }

    console.log(
      `${logPrefix} ${run.ticket_key} moved to Done after PR merge: ${run.pr_url ?? "unknown"} (unblocked: ${unblockedCount})`
    );
  } catch (err) {
    console.warn(
      `${logPrefix} Failed to process merged PR for ${run.ticket_key}:`,
      err
    );
  }
}
