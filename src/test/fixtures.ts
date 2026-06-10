import type { DispatchRun, ProjectConfig } from "../db/queries.js";
import type { JiraIssue } from "../jira/types.js";

export interface OzRunFixture {
  run_id: string;
  state: string;
  session_link: string | null;
  artifacts: Array<{ artifact_type: string; data: Record<string, string | null> }>;
  status_message?: { message?: string };
}

export function makeJiraIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  const issue: JiraIssue = {
    id: "10001",
    key: "HYDI-31",
    self: "https://example.atlassian.net/rest/api/3/issue/10001",
    fields: {
      summary: "Default fixture summary",
      status: {
        id: "3",
        name: "To Do",
        statusCategory: {
          id: 2,
          key: "new",
          colorName: "blue-gray",
          name: "To Do",
        },
      },
      project: {
        id: "10000",
        key: "HYDI",
        name: "HyperDispatch",
      },
    },
  };

  return { ...issue, ...overrides };
}

export function makeDispatchRun(
  overrides: Partial<DispatchRun> = {}
): DispatchRun {
  const run: DispatchRun = {
    ticket_key: "HYDI-31",
    project_key: "HYDI",
    summary: "Default fixture summary",
    run_id: "run_123",
    status: "queued",
    blocked_by: null,
    model: null,
    priority: 0,
    spawned_at: null,
    completed_at: null,
    pr_url: null,
    pr_has_conflicts: null,
    session_link: null,
    error: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };

  return { ...run, ...overrides };
}

export function makeProjectConfig(
  overrides: Partial<ProjectConfig> = {}
): ProjectConfig {
  const config: ProjectConfig = {
    project_key: "HYDI",
    jira_cloud_id: "cloud-123",
    board_id: 1,
    oz_env_id: "env_123",
    oz_agent_identity_uid: null,
    github_repo: "org/hyper-dispatch",
    default_model: "auto",
    model_field_id: null,
    backlog_column_name: "Backlog",
    to_do_column_name: "To Do",
    in_progress_column_name: "In Progress",
    in_review_column_name: "In Review",
    done_column_name: "Done",
    skills: ["hyperdispatch-worker"],
    mcp_servers: null,
    active: true,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };

  return { ...config, ...overrides };
}

export function makeOzRun(overrides: Partial<OzRunFixture> = {}): OzRunFixture {
  const run: OzRunFixture = {
    run_id: "run_123",
    state: "SUCCEEDED",
    session_link: "https://warp.dev/run/run_123",
    artifacts: [],
    status_message: undefined,
  };

  return { ...run, ...overrides };
}
