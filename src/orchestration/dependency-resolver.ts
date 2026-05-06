import { getIssueLinks } from "../jira/client.js";

export interface EligibilityResult {
  eligible: boolean;
  blockedBy: string[];
}

export interface CycleResult {
  hasCycle: boolean;
  cycleKeys: string[];
}

/**
 * Check whether an issue is eligible to be queued for dispatch.
 * An issue is eligible if all of its blocking issues are in a "done" status category.
 */
export async function resolveEligibility(
  issueKey: string
): Promise<EligibilityResult> {
  const issue = await getIssueLinks(issueKey);
  const links = issue.fields.issuelinks ?? [];

  const blockedBy: string[] = [];

  for (const link of links) {
    if (link.type.inward === "is blocked by" && link.inwardIssue) {
      const blocker = link.inwardIssue;
      const isDone = blocker.fields?.status?.statusCategory?.key === "done";
      if (!isDone) {
        blockedBy.push(blocker.key);
      }
    }
  }

  return {
    eligible: blockedBy.length === 0,
    blockedBy,
  };
}

/**
 * Detect circular blocking dependencies starting from the given issue key.
 * Uses DFS with path tracking — if we encounter a key already on the current
 * path, a cycle exists.
 */
export async function detectCycles(
  issueKey: string,
  path: Set<string> = new Set()
): Promise<CycleResult> {
  if (path.has(issueKey)) {
    return { hasCycle: true, cycleKeys: [...path, issueKey] };
  }

  const newPath = new Set(path);
  newPath.add(issueKey);

  try {
    const issue = await getIssueLinks(issueKey);
    const links = issue.fields.issuelinks ?? [];

    for (const link of links) {
      if (link.type.inward === "is blocked by" && link.inwardIssue) {
        const blockerKey = link.inwardIssue.key;
        const result = await detectCycles(blockerKey, newPath);
        if (result.hasCycle) {
          return result;
        }
      }
    }
  } catch {
    // If we cannot fetch the issue, we cannot detect a cycle through this path
  }

  return { hasCycle: false, cycleKeys: [] };
}
