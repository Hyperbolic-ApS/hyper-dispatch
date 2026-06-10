import { sql } from "./connection.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ProjectConfig {
  project_key: string;
  jira_cloud_id: string;
  board_id: number;
  oz_env_id: string;
  oz_agent_identity_uid: string | null;
  github_repo: string;
  default_model: string | null;
  model_field_id: string | null;
  backlog_column_name: string;
  to_do_column_name: string;
  in_progress_column_name: string;
  in_review_column_name: string;
  done_column_name: string;
  skills: string[];
  mcp_servers: Record<string, unknown> | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

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
  session_link: string | null;
  error: string | null;
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
  updates: Partial<Pick<DispatchRun, "status" | "blocked_by" | "run_id" | "model" | "spawned_at" | "completed_at" | "pr_url" | "pr_has_conflicts" | "session_link" | "error">>
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
