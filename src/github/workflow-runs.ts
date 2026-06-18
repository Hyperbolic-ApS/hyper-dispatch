import type { Octokit } from "@octokit/rest";

/** Minimal shape of a GitHub workflow run we depend on. */
export type WorkflowRunLite = {
  name?: string | null;
  status?: string | null;
  head_branch?: string | null;
  pull_requests?: Array<{ number?: number }> | null;
};

// Workflow display names that drive the dashboard's PR action-state badges.
export const REVIEW_WORKFLOW_NAME = "Oz PR Review Commenting";
export const REVISION_WORKFLOW_NAME = "Agent Revision on Review Feedback";

// GitHub workflow-run statuses that mean "not finished yet".
const IN_FLIGHT_WORKFLOW_STATUSES = new Set([
  "queued",
  "in_progress",
  "pending",
  "waiting",
  "requested",
  // Intentionally included: surface the badge proactively while a run is pending
  // maintainer approval (e.g. fork PRs), even though it has not started executing.
  "action_required",
]);

export type PrActionState = {
  reviewRunning: boolean;
  revisionRunning: boolean;
};

// Bound the work (P1 fix). Workflow runs are returned newest-first, and only
// *in-flight* runs matter for the badges. In-flight runs are by definition among
// the most recently created, so the newest few hundred always contain them.
// Capping the page count turns a previously unbounded full-history walk (one
// round trip per 100 runs of all time — observed reaching page 11+ in prod) into
// at most MAX_WORKFLOW_RUN_PAGES round trips.
const MAX_WORKFLOW_RUN_PAGES = 3;
const WORKFLOW_RUNS_PER_PAGE = 100;

// Cache TTL must exceed every caller's polling cadence or the cache never hits
// (P2 fix). The previous 10s TTL was shorter than the dashboard's 15s poll, so
// every poll re-paginated from scratch. 60s comfortably covers the 15s dashboard
// refresh and the 30s monitor loop.
const WORKFLOW_RUNS_CACHE_TTL_MS = 60_000;

const workflowRunsCache = new Map<
  string,
  { expiresAt: number; runs: WorkflowRunLite[] }
>();

/**
 * Reset the module-level cache between cases.
 * @internal Exported for tests only — do not call from production code.
 */
export function __clearWorkflowRunsCache(): void {
  workflowRunsCache.clear();
}

/**
 * Fetch a repo's most recent workflow runs, bounded (P1) and cached (P2).
 * `cacheKey` must incorporate the credential boundary (e.g. `owner/repo::token`)
 * so runs fetched with one token are never served to another.
 */
export async function getRepoWorkflowRuns(
  client: Octokit,
  owner: string,
  repo: string,
  cacheKey: string
): Promise<WorkflowRunLite[]> {
  const now = Date.now();
  const cached = workflowRunsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.runs;
  }

  const runs: WorkflowRunLite[] = [];
  for (let page = 1; page <= MAX_WORKFLOW_RUN_PAGES; page += 1) {
    const { data } = await client.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: WORKFLOW_RUNS_PER_PAGE,
      page,
    });
    const pageRuns = (data.workflow_runs ?? []) as WorkflowRunLite[];
    runs.push(...pageRuns);
    if (pageRuns.length < WORKFLOW_RUNS_PER_PAGE) break;
  }

  workflowRunsCache.set(cacheKey, {
    expiresAt: now + WORKFLOW_RUNS_CACHE_TTL_MS,
    runs,
  });
  // Prune expired entries so the cache stays bounded across token rotations and
  // project churn over a long-lived server process.
  for (const [key, entry] of workflowRunsCache) {
    if (entry.expiresAt <= now) workflowRunsCache.delete(key);
  }
  return runs;
}

/**
 * Determine whether the review and/or revision workflows are currently in-flight
 * for a specific PR, matched by PR number or by the conventional
 * `agent/<ticket>` head branch.
 */
export function computePrActionState(
  workflowRuns: WorkflowRunLite[],
  target: { pullNumber: number; branchName: string }
): PrActionState {
  const matchesPr = (run: WorkflowRunLite): boolean =>
    (run.pull_requests ?? []).some((pr) => pr.number === target.pullNumber) ||
    run.head_branch === target.branchName;

  const isInFlight = (run: WorkflowRunLite, name: string): boolean =>
    run.name === name &&
    IN_FLIGHT_WORKFLOW_STATUSES.has(run.status ?? "") &&
    matchesPr(run);

  return {
    reviewRunning: workflowRuns.some((run) => isInFlight(run, REVIEW_WORKFLOW_NAME)),
    revisionRunning: workflowRuns.some((run) =>
      isInFlight(run, REVISION_WORKFLOW_NAME)
    ),
  };
}
