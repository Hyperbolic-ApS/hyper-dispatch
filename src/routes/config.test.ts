import { testClient } from "hono/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JIRA_COLUMN_MAPPINGS } from "../jira/columns.js";
import { makeProjectConfig } from "../test/fixtures.js";

const listProjectConfigsMock = vi.fn();
const getProjectConfigMock = vi.fn();
const createProjectConfigMock = vi.fn();
const updateProjectConfigMock = vi.fn();
const deleteProjectConfigMock = vi.fn();
const discoverSkillsMock = vi.fn();
const validateJiraProjectMock = vi.fn();

vi.mock("../db/config-queries.js", () => ({
  listProjectConfigs: listProjectConfigsMock,
  getProjectConfig: getProjectConfigMock,
  createProjectConfig: createProjectConfigMock,
  updateProjectConfig: updateProjectConfigMock,
  deleteProjectConfig: deleteProjectConfigMock,
}));

vi.mock("../github/skills.js", () => ({
  discoverSkills: discoverSkillsMock,
}));

vi.mock("../validator/jira.js", () => ({
  validateJiraProject: validateJiraProjectMock,
}));
vi.mock("../jira/client.js", () => ({}));

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(),
}));

describe("configRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getClient() {
    const { configRouter } = await import("./config.js");
    return testClient(configRouter) as any;
  }

  function baseCreateForm() {
    return {
      project_key: "HYDI",
      jira_cloud_id: "cloud-id",
      board_id: "21",
      oz_env_id: "env_123",
      oz_api_key: "oz_key_123",
      oz_agent_identity_uid: "agent_identity_123",
      github_repo: "owner/repo",
      default_model: "auto",
      model_field_id: "customfield_10010",
      backlog_column_name: "Backlog",
      to_do_column_name: "To Do",
      in_progress_column_name: "In Progress",
      in_review_column_name: "In Review",
      done_column_name: "Done",
      skills: "owner/repo:hyperdispatch-worker",
      mcp_servers: "{\"playwright\":{\"command\":\"npx\"}}",
      github_pat: "gh_pat_123",
      jira_api_token: "jira_token",
      active: "true",
    };
  }

  it("POST / returns 400 and form error when required field is missing", async () => {
    const client = await getClient();
    const form = baseCreateForm();
    const { project_key: _missing, ...missingProjectKeyForm } = form;

    const res = await client.index.$post({
      form: missingProjectKeyForm,
    });

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Missing required fields");
    expect(createProjectConfigMock).not.toHaveBeenCalled();
  });

  it("POST / creates project with normalized values", async () => {
    const client = await getClient();
    await client.index.$post({
      form: {
        ...baseCreateForm(),
        backlog_column_name: "   ",
        to_do_column_name: "   Ready to Build  ",
        in_progress_column_name: "  ",
        in_review_column_name: " In Review ",
        done_column_name: "",
        skills: " owner/repo:first , , owner/repo:second ",
      },
    });

    expect(createProjectConfigMock).toHaveBeenCalledTimes(1);
    expect(createProjectConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backlog_column_name: DEFAULT_JIRA_COLUMN_MAPPINGS.backlog,
        to_do_column_name: "Ready to Build",
        in_progress_column_name: DEFAULT_JIRA_COLUMN_MAPPINGS.inProgress,
        in_review_column_name: "In Review",
        done_column_name: DEFAULT_JIRA_COLUMN_MAPPINGS.done,
        oz_agent_identity_uid: "agent_identity_123",
        oz_api_key: "oz_key_123",
        skills: ["owner/repo:first", "owner/repo:second"],
        mcp_servers: { playwright: { command: "npx" } },
      })
    );
  });

  it("POST / normalizes empty Oz Agent ID to null", async () => {
    const client = await getClient();
    await client.index.$post({
      form: { ...baseCreateForm(), oz_agent_identity_uid: "" },
    });

    expect(createProjectConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ oz_agent_identity_uid: null })
    );
  });

  it("POST / normalizes whitespace-only Oz Agent ID to null", async () => {
    const client = await getClient();
    await client.index.$post({
      form: { ...baseCreateForm(), oz_agent_identity_uid: "   " },
    });

    expect(createProjectConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ oz_agent_identity_uid: null })
    );
  });

  it("POST / returns MCP JSON parse errors with line numbers", async () => {
    const client = await getClient();
    const res = await client.index.$post({
      form: {
        ...baseCreateForm(),
        mcp_servers: "{\n  \"broken\": 123,\n}",
      },
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("(line ");
    expect(createProjectConfigMock).not.toHaveBeenCalled();
  });

  it("POST /:projectKey preserves existing tokens when token fields are empty", async () => {
    const client = await getClient();
    await client[":projectKey"].$post({
      param: { projectKey: "HYDI" },
      form: {
        ...baseCreateForm(),
        oz_api_key: "",
        github_pat: "",
        jira_api_token: "",
        backlog_column_name: "",
        to_do_column_name: "  ",
      },
    });

    expect(updateProjectConfigMock).toHaveBeenCalledTimes(1);
    expect(updateProjectConfigMock).toHaveBeenCalledWith(
      "HYDI",
      expect.objectContaining({
        backlog_column_name: DEFAULT_JIRA_COLUMN_MAPPINGS.backlog,
        to_do_column_name: DEFAULT_JIRA_COLUMN_MAPPINGS.toDo,
      })
    );
    const updates = updateProjectConfigMock.mock.calls[0]?.[1];
    expect(updates?.oz_api_key).toBeUndefined();
    expect(updates?.github_pat).toBeUndefined();
    expect(updates?.jira_api_token).toBeUndefined();
  });

  it("POST /:projectKey updates tokens when token fields are provided", async () => {
    const client = await getClient();
    await client[":projectKey"].$post({
      param: { projectKey: "HYDI" },
      form: {
        ...baseCreateForm(),
        oz_api_key: "new-oz-key",
        github_pat: "new-pat",
        jira_api_token: "new-jira-token",
      },
    });

    expect(updateProjectConfigMock).toHaveBeenCalledWith(
      "HYDI",
      expect.objectContaining({
        oz_api_key: "new-oz-key",
        github_pat: "new-pat",
        jira_api_token: "new-jira-token",
      })
    );
  });

  it("POST /:projectKey forwards oz_agent_identity_uid to updateProjectConfig", async () => {
    const client = await getClient();
    await client[":projectKey"].$post({
      param: { projectKey: "HYDI" },
      form: { ...baseCreateForm(), oz_agent_identity_uid: "agent_identity_123" },
    });

    expect(updateProjectConfigMock).toHaveBeenCalledWith(
      "HYDI",
      expect.objectContaining({ oz_agent_identity_uid: "agent_identity_123" })
    );
  });

  it("POST /:projectKey normalizes empty Oz Agent ID to null", async () => {
    const client = await getClient();
    await client[":projectKey"].$post({
      param: { projectKey: "HYDI" },
      form: { ...baseCreateForm(), oz_agent_identity_uid: "" },
    });

    expect(updateProjectConfigMock).toHaveBeenCalledWith(
      "HYDI",
      expect.objectContaining({ oz_agent_identity_uid: null })
    );
  });

  it("POST /:projectKey/delete removes the project and redirects to config overview", async () => {
    const client = await getClient();
    const res = await client[":projectKey"].delete.$post({
      param: { projectKey: "HYDI" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/config");
    expect(deleteProjectConfigMock).toHaveBeenCalledWith("HYDI");
  });

  it("POST /skills returns 400 for invalid owner/repo format", async () => {
    const client = await getClient();
    const res = await client.skills.$post({
      json: { repo: "invalid-format" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid repo format. Use owner/repo",
    });
  });

  it("POST /skills calls discoverSkills and returns empty list when none found", async () => {
    const client = await getClient();
    discoverSkillsMock.mockResolvedValue([]);
    getProjectConfigMock.mockResolvedValue(
      makeProjectConfig({
        github_pat: "saved-token",
      } as any)
    );
    const res = await client.skills.$post({
      json: { repo: "owner/repo", projectKey: "HYDI" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(discoverSkillsMock).toHaveBeenCalledWith(
      "owner",
      "repo",
      "main",
      "saved-token"
    );
  });

  it("POST /skills returns 404 when GitHub discovery returns not-found", async () => {
    const client = await getClient();
    const err = Object.assign(new Error("Not Found"), { status: 404 });
    discoverSkillsMock.mockRejectedValue(err);
    const res = await client.skills.$post({
      json: { repo: "owner/repo" },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
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

  it("returns JSON validation output and passes saved mappings/creds to validator", async () => {
    getProjectConfigMock.mockResolvedValue(
      makeProjectConfig({
        board_id: 77,
        model_field_id: "customfield_10010",
        backlog_column_name: "Backlog",
        to_do_column_name: "To Do",
        in_progress_column_name: "In Progress",
        in_review_column_name: "In Review",
        done_column_name: "Done",
        jira_api_token: "project-token",
      } as any)
    );
    validateJiraProjectMock.mockResolvedValue({
      valid: false,
      checks: [
        { name: "Workflow statuses", passed: true, message: "ok" },
        { name: "Custom field", passed: false, message: "missing field" },
      ],
    });

    const client = await getClient();
    const res = await client[":projectKey"].validate.$get({
      param: { projectKey: "HYDI" },
      header: { accept: "application/json" },
    });

    const payload = (await res.json()) as {
      checks: Array<{ passed: boolean }>;
    };
    expect(res.status).toBe(200);
    expect(payload.checks).toHaveLength(2);
    expect(payload.checks.some((check: { passed: boolean }) => check.passed === false)).toBe(true);
    expect(payload.checks.some((check: { passed: boolean }) => check.passed === true)).toBe(true);
    expect(validateJiraProjectMock).toHaveBeenCalledWith(
      "HYDI",
      "customfield_10010",
      {
        backlog: "Backlog",
        toDo: "To Do",
        inProgress: "In Progress",
        inReview: "In Review",
        done: "Done",
      },
      {
        cloudId: "cloud-123",
        apiToken: "project-token",
      }
    );
  });

  it("returns HTML validation output when requested", async () => {
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    validateJiraProjectMock.mockResolvedValue({
      valid: false,
      checks: [{ name: "Workflow statuses", passed: false, message: "Missing statuses: Done" }],
    });
    const client = await getClient();
    const res = await client[":projectKey"].validate.$get({
      param: { projectKey: "HYDI" },
      header: { accept: "text/html" },
    });

    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Validate: HYDI");
    expect(html).toContain("Missing statuses: Done");
  });

});
