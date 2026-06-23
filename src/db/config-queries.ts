import { sql } from "./connection.js";
import type { DispatchRun } from "./dispatch-run.js";
import type { RunRecord } from "./queries.js";
export type { DispatchRun } from "./dispatch-run.js";

export interface ProjectConfig {
  project_key: string;
  jira_cloud_id: string;
  board_id: number;
  oz_env_id: string;
  oz_api_key: string | null;
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
  github_pat: string | null;
  jira_api_token: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ProjectConfigInput {
  project_key: string;
  jira_cloud_id: string;
  board_id: number;
  oz_env_id: string;
  oz_api_key?: string | null;
  oz_agent_identity_uid?: string | null;
  github_repo: string;
  default_model?: string | null;
  model_field_id?: string | null;
  backlog_column_name?: string;
  to_do_column_name?: string;
  in_progress_column_name?: string;
  in_review_column_name?: string;
  done_column_name?: string;
  skills?: string[];
  mcp_servers?: Record<string, unknown> | null;
  github_pat?: string | null;
  jira_api_token?: string | null;
  active?: boolean;
}

export interface RunStatusCount {
  status: string;
  count: string;
}

export async function listProjectConfigs(): Promise<ProjectConfig[]> {
  return sql<ProjectConfig[]>`
    SELECT * FROM project_configs ORDER BY project_key ASC
  `;
}

export async function getProjectConfig(
  projectKey: string
): Promise<ProjectConfig | null> {
  const rows = await sql<ProjectConfig[]>`
    SELECT * FROM project_configs WHERE project_key = ${projectKey}
  `;
  return rows[0] ?? null;
}

export async function createProjectConfig(
  config: ProjectConfigInput
): Promise<ProjectConfig> {
  const rows = await sql<ProjectConfig[]>`
    INSERT INTO project_configs (
      project_key,
      jira_cloud_id,
      board_id,
      oz_env_id,
      oz_api_key,
      oz_agent_identity_uid,
      github_repo,
      default_model,
      model_field_id,
      backlog_column_name,
      to_do_column_name,
      in_progress_column_name,
      in_review_column_name,
      done_column_name,
      skills,
      mcp_servers,
      github_pat,
      jira_api_token,
      active
    ) VALUES (
      ${config.project_key},
      ${config.jira_cloud_id},
      ${config.board_id},
      ${config.oz_env_id},
      ${config.oz_api_key ?? null},
      ${config.oz_agent_identity_uid ?? null},
      ${config.github_repo},
      ${config.default_model ?? null},
      ${config.model_field_id ?? null},
      ${config.backlog_column_name ?? "Backlog"},
      ${config.to_do_column_name ?? "To Do"},
      ${config.in_progress_column_name ?? "In Progress"},
      ${config.in_review_column_name ?? "In Review"},
      ${config.done_column_name ?? "Done"},
      ${sql.array(config.skills ?? [])},
      ${config.mcp_servers ? JSON.stringify(config.mcp_servers) : null}::jsonb,
      ${config.github_pat ?? null},
      ${config.jira_api_token ?? null},
      ${config.active ?? true}
    )
    RETURNING *
  `;
  return rows[0]!;
}

export async function updateProjectConfig(
  projectKey: string,
  updates: Partial<ProjectConfigInput>
): Promise<ProjectConfig | null> {
  const current = await getProjectConfig(projectKey);
  if (!current) return null;
  const merged = { ...current, ...updates };
  const rows = await sql<ProjectConfig[]>`
    UPDATE project_configs SET
      jira_cloud_id  = ${merged.jira_cloud_id},
      board_id       = ${merged.board_id},
      oz_env_id      = ${merged.oz_env_id},
      oz_api_key     = ${merged.oz_api_key ?? null},
      oz_agent_identity_uid = ${merged.oz_agent_identity_uid ?? null},
      github_repo    = ${merged.github_repo},
      default_model  = ${merged.default_model ?? null},
      model_field_id = ${merged.model_field_id ?? null},
      backlog_column_name = ${merged.backlog_column_name ?? "Backlog"},
      to_do_column_name = ${merged.to_do_column_name ?? "To Do"},
      in_progress_column_name = ${merged.in_progress_column_name ?? "In Progress"},
      in_review_column_name = ${merged.in_review_column_name ?? "In Review"},
      done_column_name = ${merged.done_column_name ?? "Done"},
      skills         = ${sql.array(merged.skills ?? [])},
      mcp_servers    = ${merged.mcp_servers ? JSON.stringify(merged.mcp_servers) : null}::jsonb,
      github_pat     = ${merged.github_pat ?? null},
      jira_api_token = ${merged.jira_api_token ?? null},
      active         = ${merged.active},
      updated_at     = NOW()
    WHERE project_key = ${projectKey}
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function deleteProjectConfig(projectKey: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM dispatch_entries
      WHERE project_key = ${projectKey}
    `;
    await tx`
      DELETE FROM project_configs
      WHERE project_key = ${projectKey}
    `;
  });
}


export async function getAllDispatchRuns(): Promise<DispatchRun[]> {
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
      lr.id,
      lr.run_type,
      lr.run_id,
      lr.model,
      lr.spawned_at,
      lr.completed_at,
      COALESCE(lr.pr_url, lpr.pr_url) AS pr_url,
      COALESCE(lr.pr_has_conflicts, lpr.pr_has_conflicts) AS pr_has_conflicts,
      COALESCE(lr.pr_display_state, lpr.pr_display_state) AS pr_display_state,
      COALESCE(lr.pr_review_running, lpr.pr_review_running) AS pr_review_running,
      COALESCE(lr.pr_revision_running, lpr.pr_revision_running) AS pr_revision_running,
      lr.session_link,
      lr.error,
      de.created_at,
      de.updated_at
    FROM dispatch_entries de
    LEFT JOIN LATERAL (
      SELECT *
      FROM dispatch_runs dr
      WHERE dr.ticket_key = de.ticket_key
      ORDER BY dr.created_at DESC
      LIMIT 1
    ) lr ON true
    LEFT JOIN LATERAL (
      SELECT
        dr.pr_url,
        dr.pr_has_conflicts,
        dr.pr_display_state,
        dr.pr_review_running,
        dr.pr_revision_running
      FROM dispatch_runs dr
      WHERE dr.ticket_key = de.ticket_key
        AND dr.pr_url IS NOT NULL
      ORDER BY dr.created_at DESC
      LIMIT 1
    ) lpr ON true
    ORDER BY de.created_at DESC
  `;
}

export async function getRunCountsByStatus(): Promise<RunStatusCount[]> {
  return sql<RunStatusCount[]>`
    SELECT status, COUNT(*)::TEXT as count FROM dispatch_entries GROUP BY status
  `;
}

export const DEFAULT_DASHBOARD_PAGE_SIZE = 50;

export interface DispatchRunFilter {
  projectKey?: string | null;
  statuses?: string[];
  hideDone?: boolean;
}

export async function getDispatchRunsPage(
  filter: DispatchRunFilter,
  limit: number,
  offset: number
): Promise<DispatchRun[]> {
  const projectKey = filter.projectKey ?? null;
  const statuses = filter.statuses ?? [];
  const hideDone = filter.hideDone ?? false;
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
      lr.id,
      lr.run_type,
      lr.run_id,
      lr.model,
      lr.spawned_at,
      lr.completed_at,
      COALESCE(lr.pr_url, lpr.pr_url) AS pr_url,
      COALESCE(lr.pr_has_conflicts, lpr.pr_has_conflicts) AS pr_has_conflicts,
      COALESCE(lr.pr_display_state, lpr.pr_display_state) AS pr_display_state,
      COALESCE(lr.pr_review_running, lpr.pr_review_running) AS pr_review_running,
      COALESCE(lr.pr_revision_running, lpr.pr_revision_running) AS pr_revision_running,
      lr.session_link,
      lr.error,
      de.created_at,
      de.updated_at
    FROM dispatch_entries de
    LEFT JOIN LATERAL (
      SELECT *
      FROM dispatch_runs dr
      WHERE dr.ticket_key = de.ticket_key
      ORDER BY dr.created_at DESC
      LIMIT 1
    ) lr ON true
    LEFT JOIN LATERAL (
      SELECT
        dr.pr_url,
        dr.pr_has_conflicts,
        dr.pr_display_state,
        dr.pr_review_running,
        dr.pr_revision_running
      FROM dispatch_runs dr
      WHERE dr.ticket_key = de.ticket_key
        AND dr.pr_url IS NOT NULL
      ORDER BY dr.created_at DESC
      LIMIT 1
    ) lpr ON true
    WHERE (${projectKey}::text IS NULL OR de.project_key = ${projectKey})
      AND (${statuses.length === 0} OR de.status = ANY(${statuses}::text[]))
      AND (${!hideDone} OR de.ticket_status_category IS DISTINCT FROM 'done')
    ORDER BY de.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function countDispatchRuns(
  filter: DispatchRunFilter
): Promise<number> {
  const projectKey = filter.projectKey ?? null;
  const statuses = filter.statuses ?? [];
  const hideDone = filter.hideDone ?? false;
  const rows = await sql<Array<{ count: string }>>`
    SELECT COUNT(*)::TEXT AS count FROM dispatch_entries de
    WHERE (${projectKey}::text IS NULL OR de.project_key = ${projectKey})
      AND (${statuses.length === 0} OR de.status = ANY(${statuses}::text[]))
      AND (${!hideDone} OR de.ticket_status_category IS DISTINCT FROM 'done')
  `;
  return parseInt(rows[0]?.count ?? "0", 10);
}

export async function getStatusCounts(
  filter: Pick<DispatchRunFilter, "projectKey" | "hideDone">
): Promise<RunStatusCount[]> {
  const projectKey = filter.projectKey ?? null;
  const hideDone = filter.hideDone ?? false;
  return sql<RunStatusCount[]>`
    SELECT status, COUNT(*)::TEXT AS count FROM dispatch_entries de
    WHERE (${projectKey}::text IS NULL OR de.project_key = ${projectKey})
      AND (${!hideDone} OR de.ticket_status_category IS DISTINCT FROM 'done')
    GROUP BY status
  `;
}

export async function getDistinctRunProjectKeys(): Promise<string[]> {
  const rows = await sql<Array<{ project_key: string }>>`
    SELECT DISTINCT project_key FROM dispatch_entries ORDER BY project_key ASC
  `;
  return rows.map((row) => row.project_key);
}

export async function getRunHistoryForTickets(
  ticketKeys: string[]
): Promise<RunRecord[]> {
  if (ticketKeys.length === 0) return [];
  return sql<RunRecord[]>`
    SELECT *
    FROM dispatch_runs
    WHERE ticket_key = ANY(${ticketKeys}::text[])
    ORDER BY ticket_key ASC, created_at DESC
  `;
}