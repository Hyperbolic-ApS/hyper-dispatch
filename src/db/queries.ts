import { sql } from "./connection.js";
import type { ProjectConfig } from "./config-queries.js";
export type { ProjectConfig };

// ─── Types ─────────────────────────────────────────────────────────────────

export interface DispatchRun {
  ticket_key: string;
  project_key: string;
  summary: string | null;
  run_id: string | null;
  status: "blocked" | "queued" | "running" | "succeeded" | "failed" | "stale" | "blocked_cycle";
  blocked_by: string[] | null;
  model: string | null;
  priority: number;
  spawned_at: Date | null;
  completed_at: Date | null;
  pr_url: string | null;
  pr_has_conflicts: boolean | null;
  pr_display_state: "open" | "draft" | "merged" | "closed" | null;
  pr_review_running: boolean | null;
  pr_revision_running: boolean | null;
  session_link: string | null;
  error: string | null;
  ticket_status_name: string | null;
  ticket_status_category: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertDispatchRunInput {
  ticketKey: string;
  projectKey: string;
  summary?: string;
  status: DispatchRun["status"];
  blockedBy?: string[];
  priority?: number;
}

// ─── Queries ───────────────────────────────────────────────────────────────

/**
 * Look up a project config by project key.
 * Returns null if not found or not active.
 */
export async function getProjectConfig(
  projectKey: string
): Promise<ProjectConfig | null> {
  const rows = await sql<ProjectConfig[]>`
    SELECT *
    FROM project_configs
    WHERE project_key = ${projectKey}
      AND active = true
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Return all active project configs.
 */
export async function listActiveProjectConfigs(): Promise<ProjectConfig[]> {
  return sql<ProjectConfig[]>`
    SELECT *
    FROM project_configs
    WHERE active = true
    ORDER BY project_key ASC
  `;
}

/**
 * Return all runs for a given PR URL.
 */
export async function getRunsByPrUrl(prUrl: string): Promise<DispatchRun[]> {
  return sql<DispatchRun[]>`
    SELECT *
    FROM dispatch_runs
    WHERE pr_url = ${prUrl}
    ORDER BY created_at DESC
  `;
}

/**
 * Runs that have a PR whose display state is still active (open/draft) or not yet
 * known. Used by the monitor to resolve review/revision action-state out-of-band
 * so the dashboard never makes live GitHub calls on its render path. Merged/closed
 * PRs are excluded because their CI workflows are no longer in-flight.
 */
export async function getRunsWithActivePr(): Promise<DispatchRun[]> {
  return sql<DispatchRun[]>`
    SELECT *
    FROM dispatch_runs
    WHERE pr_url IS NOT NULL
      AND (pr_display_state IS NULL OR pr_display_state IN ('open', 'draft'))
    ORDER BY created_at DESC
  `;
}

/**
 * Insert or update a dispatch run.
 * On conflict (ticket_key), updates mutable fields but preserves run_id and spawned_at
 * if already set (so running/succeeded runs are not inadvertently reset).
 */
export async function upsertDispatchRun(
  run: UpsertDispatchRunInput
): Promise<DispatchRun> {
  const rows = await sql<DispatchRun[]>`
    INSERT INTO dispatch_runs (
      ticket_key,
      project_key,
      summary,
      status,
      blocked_by,
      priority,
      updated_at
    ) VALUES (
      ${run.ticketKey},
      ${run.projectKey},
      ${run.summary ?? null},
      ${run.status},
      ${run.blockedBy ?? null},
      ${run.priority ?? 0},
      NOW()
    )
    ON CONFLICT (ticket_key) DO UPDATE SET
      project_key = EXCLUDED.project_key,
      summary     = COALESCE(EXCLUDED.summary, dispatch_runs.summary),
      status      = CASE
                      WHEN dispatch_runs.status IN ('running', 'succeeded')
                        AND EXCLUDED.status = 'queued'
                      THEN dispatch_runs.status
                      ELSE EXCLUDED.status
                    END,
      blocked_by  = EXCLUDED.blocked_by,
      priority    = EXCLUDED.priority,
      updated_at  = NOW()
    RETURNING *
  `;
  return rows[0]!;
}

/**
 * Atomically claim a queued run for spawning by transitioning it to running.
 * Returns true when claim succeeds, false when another scheduler cycle already claimed it.
 */
export async function claimRunForSpawn(ticketKey: string): Promise<boolean> {
  const rows = await sql<Array<{ ticket_key: string }>>`
    UPDATE dispatch_runs
    SET
      status = 'running',
      spawned_at = COALESCE(spawned_at, NOW()),
      updated_at = NOW()
    WHERE ticket_key = ${ticketKey}
      AND status = 'queued'
    RETURNING ticket_key
  `;
  return rows.length > 0;
}

/**
 * Release a scheduler claim only if the run is still unbound to an Oz run_id.
 */
export async function releaseSpawnClaim(ticketKey: string): Promise<void> {
  await sql`
    UPDATE dispatch_runs
    SET
      status = 'queued',
      spawned_at = NULL,
      updated_at = NOW()
    WHERE ticket_key = ${ticketKey}
      AND status = 'running'
      AND run_id IS NULL
  `;
}

// ─── Revision idempotency & concurrency ──────────────────────────────────────

/**
 * Record a revision-triggering webhook event for idempotency.
 * `eventKey` is a stable per-delivery key (e.g. `review:<reviewId>` or
 * `comment:<commentId>`). Returns true when the event is newly recorded and the
 * caller may proceed, or false when the same event was already processed — which
 * happens on GitHub webhook redeliveries/retries — so a duplicate run is skipped.
 */
export async function tryRecordRevisionEvent(params: {
  eventKey: string;
  ticketKey: string;
  prUrl: string;
}): Promise<boolean> {
  const rows = await sql<Array<{ event_key: string }>>`
    INSERT INTO revision_events (event_key, ticket_key, pr_url)
    VALUES (${params.eventKey}, ${params.ticketKey}, ${params.prUrl})
    ON CONFLICT (event_key) DO NOTHING
    RETURNING event_key
  `;
  return rows.length > 0;
}

/**
 * Remove a previously recorded revision event so a genuine retry can proceed.
 * Called when spawning fails after the event was recorded.
 */
export async function deleteRevisionEvent(eventKey: string): Promise<void> {
  await sql`
    DELETE FROM revision_events
    WHERE event_key = ${eventKey}
  `;
}

/**
 * Atomically claim the revision slot for a tracked run. Transitions the run to
 * 'running' and clears `run_id`, but only when it is currently in a terminal
 * state (`succeeded` | `failed` | `stale`); returns the prior status. Returns
 * `claimed: false` when the run is already `running` (a revision is in flight,
 * which prevents overlapping agents on the same branch) or is owned by the
 * scheduler (`queued` / `blocked` / `blocked_cycle`), so a revision never steals
 * a row mid-dispatch. Clearing `run_id` makes the run monitor skip the row (via
 * its `!run.run_id` guard) during the window before `spawnRevisionRun` binds the
 * new run id, avoiding a race where the monitor reconciles the stale prior run.
 * The monitor releases the slot when the spawned run terminates;
 * `releaseRevisionSlot` restores the prior status if the spawn itself fails.
 */
export async function claimRevisionSlot(
  ticketKey: string
): Promise<{
  claimed: boolean;
  previousStatus: DispatchRun["status"] | null;
  previousRunId: string | null;
}> {
  const rows = await sql<
    Array<{ previous_status: DispatchRun["status"]; previous_run_id: string | null }>
  >`
    UPDATE dispatch_runs AS dr
    SET status = 'running', run_id = NULL, updated_at = NOW()
    FROM (
      SELECT status, run_id FROM dispatch_runs WHERE ticket_key = ${ticketKey}
    ) AS prev
    WHERE dr.ticket_key = ${ticketKey}
      AND dr.status IN ('succeeded', 'failed', 'stale')
    RETURNING prev.status AS previous_status, prev.run_id AS previous_run_id
  `;
  if (rows.length === 0) {
    return { claimed: false, previousStatus: null, previousRunId: null };
  }
  return {
    claimed: true,
    previousStatus: rows[0]!.previous_status,
    previousRunId: rows[0]!.previous_run_id,
  };
}

/**
 * Restore a run's status and run_id after a failed revision spawn (or DB write),
 * reverting the `claimRevisionSlot` transition so a later review can retry and no
 * orphaned row is left in 'running' with a NULL run_id. No-ops when there is no
 * prior status or the run is no longer in the claimed 'running' state.
 */
export async function releaseRevisionSlot(
  ticketKey: string,
  previousStatus: DispatchRun["status"] | null,
  previousRunId: string | null = null
): Promise<void> {
  if (!previousStatus) return;
  await sql`
    UPDATE dispatch_runs
    SET status = ${previousStatus}, run_id = ${previousRunId}, updated_at = NOW()
    WHERE ticket_key = ${ticketKey}
      AND status = 'running'
  `;
}

/**
 * Return all runs with a given status.
 */
export async function getRunsByStatus(status: string): Promise<DispatchRun[]> {
  return sql<DispatchRun[]>`
    SELECT *
    FROM dispatch_runs
    WHERE status = ${status}
    ORDER BY priority DESC, created_at ASC
  `;
}

/**
 * Return all runs whose blocked_by array contains the given ticket key.
 */
export async function getRunsBlockedBy(ticketKey: string): Promise<DispatchRun[]> {
  return sql<DispatchRun[]>`
    SELECT *
    FROM dispatch_runs
    WHERE ${ticketKey} = ANY(blocked_by)
  `;
}

/**
 * Partial update a dispatch run by ticket key.
 * Only updates fields explicitly provided in `updates`.
 */
export async function updateRunStatus(
  ticketKey: string,
  updates: Partial<Pick<DispatchRun, "status" | "blocked_by" | "run_id" | "model" | "spawned_at" | "completed_at" | "pr_url" | "pr_has_conflicts" | "pr_display_state" | "pr_review_running" | "pr_revision_running" | "session_link" | "error">>
): Promise<DispatchRun | null> {
  const rows = await sql<DispatchRun[]>`
    UPDATE dispatch_runs
    SET
      status       = ${updates.status        != null ? updates.status        : sql`status`},
      run_id       = ${updates.run_id        != null ? updates.run_id        : sql`run_id`},
      model        = ${updates.model         != null ? updates.model         : sql`model`},
      spawned_at   = ${updates.spawned_at    != null ? updates.spawned_at    : sql`spawned_at`},
      completed_at = ${updates.completed_at  != null ? updates.completed_at  : sql`completed_at`},
      pr_url       = ${updates.pr_url        != null ? updates.pr_url        : sql`pr_url`},
      pr_has_conflicts = ${updates.pr_has_conflicts !== undefined ? updates.pr_has_conflicts : sql`pr_has_conflicts`},
      pr_display_state = ${updates.pr_display_state !== undefined ? updates.pr_display_state : sql`pr_display_state`},
      pr_review_running = ${updates.pr_review_running !== undefined ? updates.pr_review_running : sql`pr_review_running`},
      pr_revision_running = ${updates.pr_revision_running !== undefined ? updates.pr_revision_running : sql`pr_revision_running`},
      session_link = ${updates.session_link  != null ? updates.session_link  : sql`session_link`},
      error        = ${updates.error         != null ? updates.error         : sql`error`},
      blocked_by   = ${updates.blocked_by !== undefined ? updates.blocked_by : sql`blocked_by`},
      updated_at   = NOW()
    WHERE ticket_key = ${ticketKey}
    RETURNING *
  `;
  return rows[0] ?? null;
}

/**
 * Atomically remove a blocker key from a run's blocked_by array.
 * If blocked_by becomes empty after removal, the run is moved to "queued".
 * Returns the updated run, or null if the run was not found.
 */
export async function removeBlocker(
  ticketKey: string,
  blockerKey: string
): Promise<DispatchRun | null> {
  const rows = await sql<DispatchRun[]>`
    UPDATE dispatch_runs
    SET
      blocked_by = array_remove(blocked_by, ${blockerKey}),
      status     = CASE
                     WHEN status = 'blocked'
                      AND array_length(array_remove(blocked_by, ${blockerKey}), 1) IS NULL
                     THEN 'queued'
                     ELSE status
                   END,
      updated_at = NOW()
    WHERE ticket_key = ${ticketKey}
    RETURNING *
  `;
  return rows[0] ?? null;
}

export interface TicketStatusUpdate {
  ticketKey: string;
  statusName: string | null;
  statusCategory: string | null;
}

/**
 * Batch-persist the latest Jira ticket status for a set of runs in a single query.
 * Captured out-of-band (e.g. by the scheduler's reconcile poll) so the dashboard can
 * render ticket status from the DB instead of calling Jira on every page render.
 * Only writes when a value actually changed, to avoid churn on every poll cycle.
 */
export async function setTicketStatuses(
  updates: TicketStatusUpdate[]
): Promise<void> {
  if (updates.length === 0) return;
  const ticketKeys = updates.map((u) => u.ticketKey);
  const statusNames = updates.map((u) => u.statusName);
  const statusCategories = updates.map((u) => u.statusCategory);
  await sql`
    UPDATE dispatch_runs AS dr
    SET
      ticket_status_name = u.status_name,
      ticket_status_category = u.status_category,
      updated_at = NOW()
    FROM unnest(
      ${ticketKeys}::text[],
      ${statusNames}::text[],
      ${statusCategories}::text[]
    ) AS u(ticket_key, status_name, status_category)
    WHERE dr.ticket_key = u.ticket_key
      AND (
        dr.ticket_status_name IS DISTINCT FROM u.status_name
        OR dr.ticket_status_category IS DISTINCT FROM u.status_category
      )
  `;
}

/**
 * Count the number of currently running dispatch runs.
 */
export async function getActiveRunCount(): Promise<number> {
  const rows = await sql<Array<{ count: string }>>`
    SELECT COUNT(*) AS count
    FROM dispatch_runs
    WHERE status = 'running'
  `;
  return parseInt(rows[0]?.count ?? "0", 10);
}

/**
 * Return all dispatch runs ordered by status and creation time.
 */
export async function getAllRuns(): Promise<DispatchRun[]> {
  return sql<DispatchRun[]>`
    SELECT *
    FROM dispatch_runs
    ORDER BY created_at DESC
  `;
}

/**
 * Return all runs for a given project.
 */
export async function getRunsByProject(projectKey: string): Promise<DispatchRun[]> {
  return sql<DispatchRun[]>`
    SELECT *
    FROM dispatch_runs
    WHERE project_key = ${projectKey}
    ORDER BY created_at DESC
  `;
}

/**
 * Delete a run from the dispatch table by ticket key.
 */
export async function deleteRun(ticketKey: string): Promise<void> {
  await sql`
    DELETE FROM dispatch_runs
    WHERE ticket_key = ${ticketKey}
  `;
}
