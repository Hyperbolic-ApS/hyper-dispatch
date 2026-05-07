import { sql } from "./connection.js";

export interface ProjectConfig {
  project_key: string;
  jira_cloud_id: string;
  board_id: number;
  oz_env_id: string;
  github_repo: string;
  default_model: string | null;
  model_field_id: string | null;
  skills: string[];
  mcp_servers: Record<string, unknown> | null;
  github_pat: string | null;
  jira_api_token: string | null;
  jira_email: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ProjectConfigInput {
  project_key: string;
  jira_cloud_id: string;
  board_id: number;
  oz_env_id: string;
  github_repo: string;
  default_model?: string | null;
  model_field_id?: string | null;
  skills?: string[];
  mcp_servers?: Record<string, unknown> | null;
  github_pat?: string | null;
  jira_api_token?: string | null;
  jira_email?: string | null;
  active?: boolean;
}

export interface DispatchRun {
  ticket_key: string;
  project_key: string;
  summary: string | null;
  run_id: string | null;
  status: string;
  blocked_by: string[] | null;
  model: string | null;
  priority: number;
  spawned_at: Date | null;
  completed_at: Date | null;
  pr_url: string | null;
  session_link: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
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
      github_repo,
      default_model,
      model_field_id,
      skills,
      mcp_servers,
      github_pat,
      jira_api_token,
      jira_email,
      active
    ) VALUES (
      ${config.project_key},
      ${config.jira_cloud_id},
      ${config.board_id},
      ${config.oz_env_id},
      ${config.github_repo},
      ${config.default_model ?? null},
      ${config.model_field_id ?? null},
      ${sql.array(config.skills ?? [])},
      ${config.mcp_servers ? JSON.stringify(config.mcp_servers) : null}::jsonb,
      ${config.github_pat ?? null},
      ${config.jira_api_token ?? null},
      ${config.jira_email ?? null},
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
      github_repo    = ${merged.github_repo},
      default_model  = ${merged.default_model ?? null},
      model_field_id = ${merged.model_field_id ?? null},
      skills         = ${sql.array(merged.skills ?? [])},
      mcp_servers    = ${merged.mcp_servers ? JSON.stringify(merged.mcp_servers) : null}::jsonb,
      github_pat     = ${merged.github_pat ?? null},
      jira_api_token = ${merged.jira_api_token ?? null},
      jira_email     = ${merged.jira_email ?? null},
      active         = ${merged.active},
      updated_at     = NOW()
    WHERE project_key = ${projectKey}
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function deactivateProjectConfig(
  projectKey: string
): Promise<void> {
  await sql`
    UPDATE project_configs SET active = false, updated_at = NOW()
    WHERE project_key = ${projectKey}
  `;
}

export async function getAllDispatchRuns(): Promise<DispatchRun[]> {
  return sql<DispatchRun[]>`
    SELECT * FROM dispatch_runs ORDER BY created_at DESC
  `;
}

export async function getRunCountsByStatus(): Promise<RunStatusCount[]> {
  return sql<RunStatusCount[]>`
    SELECT status, COUNT(*)::TEXT as count FROM dispatch_runs GROUP BY status
  `;
}
