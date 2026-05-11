import { testClient } from "hono/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JIRA_COLUMN_MAPPINGS } from "../jira/columns.js";
import { makeProjectConfig } from "../test/fixtures.js";

const listProjectConfigsMock = vi.fn();
const getProjectConfigMock = vi.fn();
const createProjectConfigMock = vi.fn();
const updateProjectConfigMock = vi.fn();
const deactivateProjectConfigMock = vi.fn();
const discoverSkillsMock = vi.fn();
const validateJiraProjectMock = vi.fn();

vi.mock("../db/config-queries.js", () => ({
  listProjectConfigs: listProjectConfigsMock,
  getProjectConfig: getProjectConfigMock,
  createProjectConfig: createProjectConfigMock,
  updateProjectConfig: updateProjectConfigMock,
  deactivateProjectConfig: deactivateProjectConfigMock,
}));

vi.mock("../github/skills.js", () => ({
  discoverSkills: discoverSkillsMock,
}));

vi.mock("../validator/jira.js", () => ({
  validateJiraProject: validateJiraProjectMock,
}));

vi.mock("../jira/client.js", () => ({}));
vi.mock("@octokit/rest", () => ({ Octokit: vi.fn() }));

function baseCreateForm(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    project_key: "HYDI",
    jira_cloud_id: "cloud-123",
    board_id: "77",
    oz_env_id: "env-123",
    github_repo: "hyperbolic-co/hyper-dispatch",
    default_model: "auto",
    model_field_id: "customfield_10050",
    skills: "owner/repo:one, owner/repo:two",
    mcp_servers: "{\"playwright\":{\"command\":\"npx\"}}",
    github_pat: "ghp_123",
    jira_api_token: "jira_123",
    jira_email: "jira@example.com",
    active: "true",
    ...overrides,
  };
}

async function getClient(): Promise<any> {
  const { configRouter } = await import("./config.js");
  return testClient(configRouter);
}

describe("configRouter", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    listProjectConfigsMock.mockResolvedValue([]);
    createProjectConfigMock.mockResolvedValue(undefined);
    updateProjectConfigMock.mockResolvedValue(undefined);
  });

  it("re-renders create form with error when a required field is missing", async () => {
    const client = await getClient();
    const res = await client.index.$post({
      form: baseCreateForm({ project_key: "" }),
    });

    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Missing required fields");
    expect(createProjectConfigMock).not.toHaveBeenCalled();
  });

  it("creates config with normalized values and defaults for blank column names", async () => {
    const client = await getClient();
    const res = await client.index.$post({
      form: baseCreateForm({
        backlog_column_name: "   ",
        to_do_column_name: "  Ready  ",
        in_progress_column_name: "",
        in_review_column_name: " review lane ",
        done_column_name: "   ",
      }),
    });

    expect(res.status).toBe(302);
    expect(createProjectConfigMock).toHaveBeenCalledWith({
      project_key: "HYDI",
      jira_cloud_id: "cloud-123",
      board_id: 77,
      oz_env_id: "env-123",
      github_repo: "hyperbolic-co/hyper-dispatch",
      default_model: "auto",
      model_field_id: "customfield_10050",
      backlog_column_name: DEFAULT_JIRA_COLUMN_MAPPINGS.backlog,
      to_do_column_name: "Ready",
      in_progress_column_name: DEFAULT_JIRA_COLUMN_MAPPINGS.inProgress,
      in_review_column_name: "review lane",
      done_column_name: DEFAULT_JIRA_COLUMN_MAPPINGS.done,
      skills: ["owner/repo:one", "owner/repo:two"],
      mcp_servers: { playwright: { command: "npx" } },
      github_pat: "ghp_123",
      jira_api_token: "jira_123",
      jira_email: "jira@example.com",
      active: true,
    });
  });

  it("surfaces MCP JSON parse errors with line information", async () => {
    const client = await getClient();
    const res = await client.index.$post({
      form: baseCreateForm({
        mcp_servers: "{\n  \"a\": 1,\n}",
      }),
    });

    expect(res.status).toBe(400);
    const message = await res.text();
    expect(message).toContain("Invalid MCP servers JSON");
    expect(message).toMatch(/line \d+/i);
    expect(createProjectConfigMock).not.toHaveBeenCalled();
  });

  it("preserves existing tokens on update when token fields are empty", async () => {
    const client = await getClient();
    const res = await client[":projectKey"].$post({
      param: { projectKey: "HYDI" },
      form: {
        jira_cloud_id: "cloud-123",
        board_id: "7",
        oz_env_id: "env-123",
        github_repo: "hyperbolic-co/hyper-dispatch",
        default_model: "",
        model_field_id: "",
        skills: "owner/repo:one",
        mcp_servers: "{\"playwright\":{}}",
        github_pat: "",
        jira_api_token: "",
        jira_email: "",
        active: "true",
      },
    });

    expect(res.status).toBe(302);
    expect(updateProjectConfigMock).toHaveBeenCalledTimes(1);
    const [, updates] = updateProjectConfigMock.mock.calls[0]!;
    expect(updates.github_pat).toBeUndefined();
    expect(updates.jira_api_token).toBeUndefined();
    expect(updates.jira_email).toBeUndefined();
  });

  it("updates tokens and restores default columns when update overrides are blank", async () => {
    const client = await getClient();
    const res = await client[":projectKey"].$post({
      param: { projectKey: "HYDI" },
      form: {
        jira_cloud_id: "cloud-123",
        board_id: "8",
        oz_env_id: "env-123",
        github_repo: "hyperbolic-co/hyper-dispatch",
        default_model: "auto",
        model_field_id: "customfield_10050",
        backlog_column_name: " ",
        to_do_column_name: "  ",
        in_progress_column_name: "  In Progressing ",
        in_review_column_name: "",
        done_column_name: " ",
        skills: "",
        mcp_servers: "",
        github_pat: "ghp_new",
        jira_api_token: "jira_new",
        jira_email: "new@example.com",
        active: "true",
      },
    });

    expect(res.status).toBe(302);
    const [, updates] = updateProjectConfigMock.mock.calls[0]!;
    expect(updates.backlog_column_name).toBe(DEFAULT_JIRA_COLUMN_MAPPINGS.backlog);
    expect(updates.to_do_column_name).toBe(DEFAULT_JIRA_COLUMN_MAPPINGS.toDo);
    expect(updates.in_progress_column_name).toBe("In Progressing");
    expect(updates.in_review_column_name).toBe(DEFAULT_JIRA_COLUMN_MAPPINGS.inReview);
    expect(updates.done_column_name).toBe(DEFAULT_JIRA_COLUMN_MAPPINGS.done);
    expect(updates.github_pat).toBe("ghp_new");
    expect(updates.jira_api_token).toBe("jira_new");
    expect(updates.jira_email).toBe("new@example.com");
  });

  it("returns 400 for invalid owner/repo on skills discovery", async () => {
    const client = await getClient();
    const res = await client.skills.$post({
      json: { repo: "invalid-repo-format" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid repo format. Use owner/repo",
    });
    expect(discoverSkillsMock).not.toHaveBeenCalled();
  });

  it("returns empty skills list when discoverSkills finds nothing", async () => {
    discoverSkillsMock.mockResolvedValue([]);
    const client = await getClient();
    const res = await client.skills.$post({
      json: { repo: "hyperbolic-co/hyper-dispatch" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(discoverSkillsMock).toHaveBeenCalledWith(
      "hyperbolic-co",
      "hyper-dispatch",
      "main",
      undefined
    );
  });

  it("returns an error response when GitHub discovery returns 404", async () => {
    discoverSkillsMock.mockRejectedValue(new Error("404 Not Found"));
    const client = await getClient();
    const res = await client.skills.$post({
      json: { repo: "hyperbolic-co/hyper-dispatch" },
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "404 Not Found" });
  });

  it("returns 404 when validating a missing project", async () => {
    getProjectConfigMock.mockResolvedValue(null);
    const client = await getClient();
    const res = await client[":projectKey"].validate.$get({
      param: { projectKey: "MISSING" },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Project MISSING not found" });
  });

  it("returns all checks (including failures) and calls validator with saved mappings", async () => {
    getProjectConfigMock.mockResolvedValue(
      makeProjectConfig({
        board_id: 31,
        model_field_id: "customfield_10050",
        backlog_column_name: "Backlog Lane",
        to_do_column_name: "Ready",
        in_progress_column_name: "Working",
        in_review_column_name: "Review",
        done_column_name: "Ship",
        jira_email: "saved@example.com",
        jira_api_token: "saved-token",
      } as any)
    );
    validateJiraProjectMock.mockResolvedValue({
      valid: false,
      checks: [
        { name: "Board columns", passed: true, message: "ok" },
        { name: "Custom field", passed: false, message: "missing field" },
        { name: "Workflow statuses", passed: true, message: "ok" },
      ],
    });

    const client = await getClient();
    const res = await client[":projectKey"].validate.$get({
      param: { projectKey: "HYDI" },
      header: { accept: "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      valid: false,
      checks: [
        { name: "Board columns", passed: true, message: "ok" },
        { name: "Custom field", passed: false, message: "missing field" },
        { name: "Workflow statuses", passed: true, message: "ok" },
      ],
    });
    expect(validateJiraProjectMock).toHaveBeenCalledWith(
      31,
      "customfield_10050",
      {
        backlog: "Backlog Lane",
        toDo: "Ready",
        inProgress: "Working",
        inReview: "Review",
        done: "Ship",
      },
      { email: "saved@example.com", apiToken: "saved-token" }
    );
  });
});