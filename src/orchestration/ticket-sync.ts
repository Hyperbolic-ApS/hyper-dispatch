import * as jira from "../jira/client.js";
import { upsertDispatchRun } from "../db/queries.js";
import {
  resolveEligibility,
  detectCycles,
} from "./dependency-resolver.js";

export type ToDoSyncResult =
  | { action: "queued"; ticketKey: string }
  | { action: "blocked"; ticketKey: string; blockedBy: string[] }
  | { action: "blocked_cycle"; ticketKey: string; cycle: string[] };

/**
 * Apply the same ingestion logic used for a ticket entering "To Do":
 * - detect cycles
 * - evaluate dependency eligibility
 * - upsert run as queued/blocked/blocked_cycle
 */
export async function syncTicketInToDo(
  issueKey: string,
  projectKey: string
): Promise<ToDoSyncResult> {
  const issue = await jira.getIssueLinks(issueKey);
  const priorityValue =
    issue.fields.priority?.name != null
      ? priorityNameToNumber(issue.fields.priority.name)
      : 0;

  const cycleResult = await detectCycles(issueKey);
  if (cycleResult.hasCycle) {
    await upsertDispatchRun({
      ticketKey: issueKey,
      projectKey,
      summary: issue.fields.summary,
      status: "blocked_cycle",
      blockedBy: cycleResult.cycleKeys,
      priority: priorityValue,
    });
    return {
      action: "blocked_cycle",
      ticketKey: issueKey,
      cycle: cycleResult.cycleKeys,
    };
  }

  const eligibility = await resolveEligibility(issueKey);
  if (!eligibility.eligible) {
    await upsertDispatchRun({
      ticketKey: issueKey,
      projectKey,
      summary: issue.fields.summary,
      status: "blocked",
      blockedBy: eligibility.blockedBy,
      priority: priorityValue,
    });
    return {
      action: "blocked",
      ticketKey: issueKey,
      blockedBy: eligibility.blockedBy,
    };
  }

  await upsertDispatchRun({
    ticketKey: issueKey,
    projectKey,
    summary: issue.fields.summary,
    status: "queued",
    blockedBy: [],
    priority: priorityValue,
  });

  return { action: "queued", ticketKey: issueKey };
}

/**
 * Map Jira priority names to a numeric priority for queue ordering.
 * Higher number = higher priority.
 */
function priorityNameToNumber(name: string): number {
  const map: Record<string, number> = {
    Highest: 5,
    High: 4,
    Medium: 3,
    Low: 2,
    Lowest: 1,
  };
  return map[name] ?? 3;
}
