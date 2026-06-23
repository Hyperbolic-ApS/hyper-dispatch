import { randomUUID } from "node:crypto";
import { sql } from "./connection.js";
import type { ProjectConfig } from "./config-queries.js";
import type { DispatchRun } from "./dispatch-run.js";
export type { ProjectConfig };
export type { DispatchRun } from "./dispatch-run.js";

export type DispatchStatus =
  | "blocked"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "stale"
  | "blocked_cycle";

export interface DispatchEntry {
  ticket_key: string;
  project_key: string;
  summary: string | null;
  status: DispatchStatus;
  blocked_by: string[] | null;
  priority: number;
  ticket_status_name: string | null;
  ticket_status_category: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RunRecord {
  id: string;
  ticket_key: string;
  run_type: string;
  run_id: string | null;
  status: DispatchStatus;
  model: string | null;
  spawned_at: Date | null;
  completed_at: Date | null;
  pr_url: string | null;
  pr_has_conflicts: boolean | null;
  pr_display_state: "open" | "draft" | "merged" | "closed" | null;
  pr_review_running: boolean | null;
  pr_revision_running: boolean | null;
  session_link: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}


export interface UpsertDispatchRunInput {
  ticketKey: string;
  projectKey: string;
  summary?: string;
  status: DispatchStatus;
  blockedBy?: string[];
  priority?: number;
}

export interface CreateRunInput {
  ticketKey: string;
  runType?: string;
  status: DispatchStatus;
  runId?: string | null;
  model?: string | null;
  spawnedAt?: Date | null;
  completedAt?: Date | null;
  sessionLink?: string | null;
  error?: string | null;
}


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

export async function listActiveProjectConfigs(): Promise<ProjectConfig[]> {
  return sql<ProjectConfig[]>`
    SELECT *
    FROM project_configs
    WHERE active = true
    ORDER BY project_key ASC
  `;
}

export async function upsertDispatchRun(
  run: UpsertDispatchRunInput
): Promise<DispatchEntry> {
  const rows = await sql<DispatchEntry[]>`
    INSERT INTO dispatch_entries (
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
      summary     = COALESCE(EXCLUDED.summary, dispatch_entries.summary),
      status      = CASE
                      WHEN dispatch_entries.status IN ('running', 'succeeded')
                        AND EXCLUDED.status = 'queued'
                      THEN dispatch_entries.status
                      ELSE EXCLUDED.status
                    END,
      blocked_by  = EXCLUDED.blocked_by,
      priority    = EXCLUDED.priority,
      updated_at  = NOW()
    RETURNING *
  `;
  return rows[0]!;
}

export async function createRun(input: CreateRunInput): Promise<RunRecord> {
  const rows = await sql<RunRecord[]>`
    INSERT INTO dispatch_runs (
      id,
      ticket_key,
      run_type,
      run_id,
      status,
      model,
      spawned_at,
      completed_at,
      session_link,
      error
    ) VALUES (
      ${randomUUID()},
      ${input.ticketKey},
      ${input.runType ?? "implementation"},
      ${input.runId ?? null},
      ${input.status},
      ${input.model ?? null},
      ${input.spawnedAt ?? null},
      ${input.completedAt ?? null},
      ${input.sessionLink ?? null},
      ${input.error ?? null}
    )
    RETURNING *
  `;
  return rows[0]!;
}

export async function getRunsForTicket(ticketKey: string): Promise<RunRecord[]> {
  return sql<RunRecord[]>`
    SELECT *
    FROM dispatch_runs
    WHERE ticket_key = ${ticketKey}
    ORDER BY created_at DESC
  `;
}

export async function getRunsByPrUrl(prUrl: string): Promise<DispatchRun[]> {
  return sql<DispatchRun[]>`
    SELECT
      r.*,
      e.project_key,
      e.summary,
      e.blocked_by,
      e.priority,
      e.ticket_status_name,
      e.ticket_status_category
    FROM dispatch_runs r
    INNER JOIN dispatch_entries e ON e.ticket_key = r.ticket_key
    WHERE r.pr_url = ${prUrl}
    ORDER BY r.created_at DESC
  `;
}

export async function getRunsWithActivePr(): Promise<DispatchRun[]> {
  return sql<DispatchRun[]>`
    SELECT
      r.*,
      e.project_key,
      e.summary,
      e.blocked_by,
      e.priority,
      e.ticket_status_name,
      e.ticket_status_category
    FROM dispatch_runs r
    INNER JOIN dispatch_entries e ON e.ticket_key = r.ticket_key
    WHERE r.pr_url IS NOT NULL
      AND (r.pr_display_state IS NULL OR r.pr_display_state IN ('open', 'draft'))
    ORDER BY r.created_at DESC
  `;
}

export async function claimRunForSpawn(ticketKey: string): Promise<boolean> {
  const rows = await sql<Array<{ ticket_key: string }>>`
    UPDATE dispatch_entries de
    SET
      status = 'running',
      updated_at = NOW()
    WHERE de.ticket_key = ${ticketKey}
      AND de.status = 'queued'
      AND NOT EXISTS (
        SELECT 1
        FROM dispatch_runs dr
        WHERE dr.ticket_key = de.ticket_key
          AND dr.status = 'running'
      )
    RETURNING ticket_key
  `;
  return rows.length > 0;
}

export async function releaseSpawnClaim(ticketKey: string): Promise<void> {
  await sql`
    UPDATE dispatch_entries de
    SET
      status = 'queued',
      updated_at = NOW()
    WHERE de.ticket_key = ${ticketKey}
      AND de.status = 'running'
      AND NOT EXISTS (
        SELECT 1
        FROM dispatch_runs dr
        WHERE dr.ticket_key = de.ticket_key
          AND dr.status = 'running'
      )
  `;
}

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

export async function deleteRevisionEvent(eventKey: string): Promise<void> {
  await sql`
    DELETE FROM revision_events
    WHERE event_key = ${eventKey}
  `;
}

export async function claimRevisionSlot(
  ticketKey: string
): Promise<{
  claimed: boolean;
  previousStatus: DispatchStatus | null;
  previousRunId: string | null;
  runRecordId: string | null;
}> {
  const runRecordId = randomUUID();
  const rows = await sql<
    Array<{
      previous_status: DispatchStatus;
      previous_run_id: string | null;
      run_record_id: string;
    }>
  >`
    WITH latest AS (
      SELECT status, run_id
      FROM dispatch_runs
      WHERE ticket_key = ${ticketKey}
      ORDER BY created_at DESC
      LIMIT 1
    ),
    claimed AS (
      UPDATE dispatch_entries de
      SET
        status = 'running',
        updated_at = NOW()
      WHERE de.ticket_key = ${ticketKey}
        AND de.status <> 'running'
        AND EXISTS (
          SELECT 1
          FROM latest
          WHERE status NOT IN ('queued', 'blocked', 'blocked_cycle', 'running')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM dispatch_runs dr
          WHERE dr.ticket_key = de.ticket_key
            AND dr.status = 'running'
        )
      RETURNING de.ticket_key
    ),
    inserted AS (
      INSERT INTO dispatch_runs (
        id,
        ticket_key,
        run_type,
        status,
        spawned_at
      )
      SELECT
        ${runRecordId}::uuid,
        claimed.ticket_key,
        'revision',
        'running',
        NOW()
      FROM claimed
      RETURNING id
    )
    SELECT
      latest.status AS previous_status,
      latest.run_id AS previous_run_id,
      inserted.id::text AS run_record_id
    FROM latest
    CROSS JOIN inserted
  `;
  if (!rows[0]) {
    return {
      claimed: false,
      previousStatus: null,
      previousRunId: null,
      runRecordId: null,
    };
  }
  return {
    claimed: true,
    previousStatus: rows[0].previous_status,
    previousRunId: rows[0].previous_run_id,
    runRecordId: rows[0].run_record_id,
  };
}

export async function releaseRevisionSlot(
  ticketKey: string,
  _previousStatus: DispatchStatus | null,
  _previousRunId: string | null = null,
  failedRunRecordId: string | null = null
): Promise<void> {
  if (failedRunRecordId) {
    await sql`
      DELETE FROM dispatch_runs
      WHERE id = ${failedRunRecordId}::uuid
        AND ticket_key = ${ticketKey}
    `;
  }
  await recomputeEntryStatus(ticketKey);
}

export async function getRunsByStatus(status: DispatchStatus): Promise<DispatchRun[]> {
  return sql<DispatchRun[]>`
    SELECT
      r.*,
      e.project_key,
      e.summary,
      e.blocked_by,
      e.priority,
      e.ticket_status_name,
      e.ticket_status_category
    FROM dispatch_runs r
    INNER JOIN dispatch_entries e ON e.ticket_key = r.ticket_key
    WHERE r.status = ${status}
    ORDER BY e.priority DESC, r.created_at ASC
  `;
}

export async function getEntriesByStatus(
  status: DispatchStatus
): Promise<DispatchEntry[]> {
  return sql<DispatchEntry[]>`
    SELECT *
    FROM dispatch_entries
    WHERE status = ${status}
    ORDER BY priority DESC, created_at ASC
  `;
}

export async function getRunsBlockedBy(ticketKey: string): Promise<DispatchEntry[]> {
  return sql<DispatchEntry[]>`
    SELECT *
    FROM dispatch_entries
    WHERE ${ticketKey} = ANY(blocked_by)
  `;
}

export async function updateRunStatus(
  ticketKey: string,
  updates: Partial<
    Pick<
      RunRecord,
      | "status"
      | "run_id"
      | "model"
      | "spawned_at"
      | "completed_at"
      | "pr_url"
      | "pr_has_conflicts"
      | "pr_display_state"
      | "pr_review_running"
      | "pr_revision_running"
      | "session_link"
      | "error"
    >
  > & {
    blocked_by?: string[] | null;
    run_record_id?: string | null;
    run_type?: string;
  }
): Promise<DispatchRun | null> {
  const runRecordId = updates.run_record_id ?? undefined;
  const hasExplicitRunRecordId = runRecordId !== undefined;
  const shouldUpdateStatus = updates.status !== undefined;
  const shouldUpdateRunId = updates.run_id != null;
  const shouldUpdateModel = updates.model != null;
  const shouldUpdateSpawnedAt = updates.spawned_at != null;
  const shouldUpdateCompletedAt = updates.completed_at != null;
  const shouldUpdatePrUrl = updates.pr_url != null;
  const shouldUpdatePrHasConflicts = updates.pr_has_conflicts != null;
  const shouldUpdatePrDisplayState = updates.pr_display_state != null;
  const shouldUpdatePrReviewRunning = updates.pr_review_running != null;
  const shouldUpdatePrRevisionRunning = updates.pr_revision_running != null;
  const shouldUpdateSessionLink = updates.session_link != null;
  const shouldUpdateError = updates.error != null;
  const fallbackRunType = updates.run_type ?? "implementation";
  const rows = await sql<DispatchRun[]>`
    WITH target AS (
      SELECT id
      FROM dispatch_runs
      WHERE ${runRecordId ?? null}::uuid IS NULL
        AND ticket_key = ${ticketKey}
      ORDER BY created_at DESC
      LIMIT 1
    ),
    updated AS (
      UPDATE dispatch_runs dr
      SET
        status       = CASE WHEN ${shouldUpdateStatus} THEN ${updates.status ?? null}::text ELSE dr.status END,
        run_id       = CASE WHEN ${shouldUpdateRunId} THEN ${updates.run_id ?? null} ELSE dr.run_id END,
        model        = CASE WHEN ${shouldUpdateModel} THEN ${updates.model ?? null} ELSE dr.model END,
        spawned_at   = CASE WHEN ${shouldUpdateSpawnedAt} THEN ${updates.spawned_at ?? null}::timestamptz ELSE dr.spawned_at END,
        completed_at = CASE WHEN ${shouldUpdateCompletedAt} THEN ${updates.completed_at ?? null}::timestamptz ELSE dr.completed_at END,
        pr_url       = CASE WHEN ${shouldUpdatePrUrl} THEN ${updates.pr_url ?? null} ELSE dr.pr_url END,
        pr_has_conflicts = CASE WHEN ${shouldUpdatePrHasConflicts} THEN ${updates.pr_has_conflicts ?? null}::boolean ELSE dr.pr_has_conflicts END,
        pr_display_state = CASE WHEN ${shouldUpdatePrDisplayState} THEN ${updates.pr_display_state ?? null}::text ELSE dr.pr_display_state END,
        pr_review_running = CASE WHEN ${shouldUpdatePrReviewRunning} THEN ${updates.pr_review_running ?? null}::boolean ELSE dr.pr_review_running END,
        pr_revision_running = CASE WHEN ${shouldUpdatePrRevisionRunning} THEN ${updates.pr_revision_running ?? null}::boolean ELSE dr.pr_revision_running END,
        session_link = CASE WHEN ${shouldUpdateSessionLink} THEN ${updates.session_link ?? null} ELSE dr.session_link END,
        error        = CASE WHEN ${shouldUpdateError} THEN ${updates.error ?? null} ELSE dr.error END,
        updated_at   = NOW()
      WHERE dr.id = COALESCE(${runRecordId ?? null}::uuid, (SELECT id FROM target))
      RETURNING dr.*
    )
    SELECT
      updated.*,
      e.project_key,
      e.summary,
      e.blocked_by,
      e.priority,
      e.ticket_status_name,
      e.ticket_status_category
    FROM updated
    INNER JOIN dispatch_entries e ON e.ticket_key = updated.ticket_key
  `;
  let updatedRun = rows[0] ?? null;
  const shouldInsertFallbackRun =
    shouldUpdateStatus ||
    shouldUpdateRunId ||
    shouldUpdateModel ||
    shouldUpdateSpawnedAt ||
    shouldUpdateCompletedAt ||
    shouldUpdatePrUrl ||
    shouldUpdatePrHasConflicts ||
    shouldUpdatePrDisplayState ||
    shouldUpdatePrReviewRunning ||
    shouldUpdatePrRevisionRunning ||
    shouldUpdateSessionLink ||
    shouldUpdateError;

  if (!updatedRun && shouldInsertFallbackRun && !hasExplicitRunRecordId) {
    const fallbackRows = await sql<DispatchRun[]>`
      WITH entry AS (
        UPDATE dispatch_entries
        SET
          status = COALESCE(${updates.status ?? null}::text, status),
          updated_at = NOW()
        WHERE ticket_key = ${ticketKey}
        RETURNING *
      ),
      inserted AS (
        INSERT INTO dispatch_runs (
          id,
          ticket_key,
          run_type,
          run_id,
          status,
          model,
          spawned_at,
          completed_at,
          pr_url,
          pr_has_conflicts,
          pr_display_state,
          pr_review_running,
          pr_revision_running,
          session_link,
          error,
          updated_at
        )
        SELECT
          ${randomUUID()},
          ${ticketKey},
          ${fallbackRunType},
          ${shouldUpdateRunId ? (updates.run_id ?? null) : null},
          COALESCE(${updates.status ?? null}::text, entry.status),
          ${shouldUpdateModel ? (updates.model ?? null) : null},
          ${shouldUpdateSpawnedAt ? (updates.spawned_at ?? null) : null},
          ${shouldUpdateCompletedAt ? (updates.completed_at ?? null) : null},
          ${shouldUpdatePrUrl ? (updates.pr_url ?? null) : null},
          ${shouldUpdatePrHasConflicts ? (updates.pr_has_conflicts ?? null) : null},
          ${shouldUpdatePrDisplayState ? (updates.pr_display_state ?? null) : null},
          ${shouldUpdatePrReviewRunning ? (updates.pr_review_running ?? null) : null},
          ${shouldUpdatePrRevisionRunning ? (updates.pr_revision_running ?? null) : null},
          ${shouldUpdateSessionLink ? (updates.session_link ?? null) : null},
          ${shouldUpdateError ? (updates.error ?? null) : null},
          NOW()
        FROM entry
        RETURNING *
      )
      SELECT
        inserted.*,
        entry.project_key,
        entry.summary,
        entry.blocked_by,
        entry.priority,
        entry.ticket_status_name,
        entry.ticket_status_category
      FROM inserted
      INNER JOIN entry ON entry.ticket_key = inserted.ticket_key
    `;
    updatedRun = fallbackRows[0] ?? null;
  }
  if (updates.blocked_by !== undefined) {
    await sql`
      UPDATE dispatch_entries
      SET blocked_by = ${updates.blocked_by}, updated_at = NOW()
      WHERE ticket_key = ${ticketKey}
    `;
  }

  if (updatedRun && (shouldUpdateStatus || shouldUpdateCompletedAt)) {
    await recomputeEntryStatus(ticketKey);
  }
  return updatedRun;
}

export async function removeBlocker(
  ticketKey: string,
  blockerKey: string
): Promise<DispatchEntry | null> {
  const rows = await sql<DispatchEntry[]>`
    UPDATE dispatch_entries
    SET
      blocked_by = array_remove(blocked_by, ${blockerKey}),
      status     = CASE
                     WHEN status IN ('blocked', 'blocked_cycle')
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

export async function setTicketStatuses(
  updates: TicketStatusUpdate[]
): Promise<void> {
  if (updates.length === 0) return;
  const ticketKeys = updates.map((u) => u.ticketKey);
  const statusNames = updates.map((u) => u.statusName);
  const statusCategories = updates.map((u) => u.statusCategory);
  await sql`
    UPDATE dispatch_entries AS de
    SET
      ticket_status_name = u.status_name,
      ticket_status_category = u.status_category,
      updated_at = NOW()
    FROM unnest(
      ${ticketKeys}::text[],
      ${statusNames}::text[],
      ${statusCategories}::text[]
    ) AS u(ticket_key, status_name, status_category)
    WHERE de.ticket_key = u.ticket_key
      AND (
        de.ticket_status_name IS DISTINCT FROM u.status_name
        OR de.ticket_status_category IS DISTINCT FROM u.status_category
      )
  `;
}

export async function getActiveRunCount(): Promise<number> {
  const rows = await sql<Array<{ count: string }>>`
    SELECT COUNT(*) AS count
    FROM dispatch_runs
    WHERE status = 'running'
  `;
  return parseInt(rows[0]?.count ?? "0", 10);
}

export async function getRunsByProject(projectKey: string): Promise<DispatchRun[]> {
  return sql<DispatchRun[]>`
    SELECT
      de.ticket_key,
      de.project_key,
      de.summary,
      de.status,
      de.blocked_by,
      de.priority,
      de.ticket_status_name,
      de.ticket_status_category,
      dr.id,
      dr.run_type,
      dr.run_id,
      dr.model,
      dr.spawned_at,
      dr.completed_at,
      dr.pr_url,
      dr.pr_has_conflicts,
      dr.pr_display_state,
      dr.pr_review_running,
      dr.pr_revision_running,
      dr.session_link,
      dr.error,
      de.created_at,
      de.updated_at
    FROM dispatch_entries de
    LEFT JOIN LATERAL (
      SELECT *
      FROM dispatch_runs
      WHERE ticket_key = de.ticket_key
      ORDER BY created_at DESC
      LIMIT 1
    ) dr ON true
    WHERE de.project_key = ${projectKey}
    ORDER BY de.created_at DESC
  `;
}

export async function deleteRun(ticketKey: string): Promise<void> {
  await sql`
    DELETE FROM dispatch_entries
    WHERE ticket_key = ${ticketKey}
  `;
}

async function recomputeEntryStatus(ticketKey: string): Promise<void> {
  await sql`
    WITH latest AS (
      SELECT status
      FROM dispatch_runs
      WHERE ticket_key = ${ticketKey}
      ORDER BY created_at DESC
      LIMIT 1
    ),
    has_running AS (
      SELECT EXISTS (
        SELECT 1
        FROM dispatch_runs
        WHERE ticket_key = ${ticketKey}
          AND status = 'running'
      ) AS running
    )
    UPDATE dispatch_entries de
    SET
      status = CASE
                 WHEN (SELECT running FROM has_running) THEN 'running'
                 WHEN EXISTS (SELECT 1 FROM latest) THEN (SELECT status FROM latest)
                 ELSE de.status
               END,
      updated_at = NOW()
    WHERE de.ticket_key = ${ticketKey}
  `;
}