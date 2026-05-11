import { describe, expect, it, vi } from "vitest";
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

function formBody(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

describe("configRouter", () => {
  it("POST / re-renders form with an error when required fields are missing", async () => {
    const { configRouter } = await import("./config.js");
    const res = await configRouter.request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        project_key: "",
        jira_cloud_id: "",
        board_id: "",
        oz_env_id: "",
        github_repo: "",
      }),
    });

    const html = await res.text();
    expect(res.status).toBe(400);
    expect(html).toContain("Missing required fields");
    expect(html).toContain("<form");
    expect(createProjectConfigMock).not.toHaveBeenCalled();
  });

  it("POST / creates project with normalized column names and parsed values", async () => {
    const { configRouter } = await import("./config.js");
    const res = await configRouter.request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        project_key: " HYDI ",
        jira_cloud_id: " cloud-1 ",
        board_id: "42",
        oz_env_id: " env-1 ",
        github_repo: "org/repo",
        default_model: "auto",
        model_field_id: "customfield_10",
        backlog_column_name: "  Backlog  ",
        to_do_column_name: "   ",
        in_progress_column_name: " In Progress ",
        in_review_column_name: "",
        done_column_name: " Done ",
        skills: "a/repo:one, b/repo:two,",
        mcp_servers: "{\"sse\":{\"url\":\"http://localhost:8080\"}}",
        github_pat: "ghp_test",
        jira_api_token: "jira_test",
        jira_email: "jira@example.com",
        active: "true",
      }),
    });

    expect(res.status).toBe(302);
    expect(createProjectConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_key: "HYDI",
        jira_cloud_id: "cloud-1",
        board_id: 42,
        oz_env_id: "env-1",
        github_repo: "org/repo",
        backlog_column_name: "Backlog",
        to_do_column_name: "To Do",
        in_progress_column_name: "In Progress",
        in_review_column_name: "In Review",
        done_column_name: "Done",
        skills: ["a/repo:one", "b/repo:two"],
      })
    );
  });

  it("POST / surfaces MCP JSON parsing errors with line numbers", async () => {
    const { configRouter } = await import("./config.js");
    const res = await configRouter.request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        project_key: "HYDI",
        jira_cloud_id: "cloud",
        board_id: "1",
        oz_env_id: "env",
        github_repo: "org/repo",
        mcp_servers: "{\n  \"broken\":\n}",
      }),
    });

    const body = await res.text();
    expect(res.status).toBe(400);
    expect(body).toContain("Invalid MCP servers JSON");
    expect(body).toContain("line 3");
    expect(createProjectConfigMock).not.toHaveBeenCalled();
  });

  it("POST /:projectKey keeps existing token values when token fields are empty", async () => {
    const { configRouter } = await import("./config.js");
    const res = await configRouter.request("http://localhost/HYDI", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        jira_cloud_id: "cloud",
        board_id: "7",
        oz_env_id: "env",
        github_repo: "org/repo",
        backlog_column_name: "",
        to_do_column_name: "",
        in_progress_column_name: "",
        in_review_column_name: "",
        done_column_name: "",
        skills: "",
        mcp_servers: "",
        github_pat: "",
        jira_api_token: "",
        jira_email: "",
      }),
    });

    expect(res.status).toBe(302);
    expect(updateProjectConfigMock).toHaveBeenCalledWith(
      "HYDI",
      expect.objectContaining({
        backlog_column_name: "Backlog",
        to_do_column_name: "To Do",
        in_progress_column_name: "In Progress",
        in_review_column_name: "In Review",
        done_column_name: "Done",
      })
    );
    expect(updateProjectConfigMock.mock.calls[0]?.[1]).not.toHaveProperty(
      "github_pat"
    );
    expect(updateProjectConfigMock.mock.calls[0]?.[1]).not.toHaveProperty(
      "jira_api_token"
    );
    expect(updateProjectConfigMock.mock.calls[0]?.[1]).not.toHaveProperty(
      "jira_email"
    );
  });

  it("POST /:projectKey updates token values when token fields are supplied", async () => {
    const { configRouter } = await import("./config.js");
    await configRouter.request("http://localhost/HYDI", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        jira_cloud_id: "cloud",
        board_id: "7",
        oz_env_id: "env",
        github_repo: "org/repo",
        backlog_column_name: "backlog",
        to_do_column_name: "to do",
        in_progress_column_name: "progress",
        in_review_column_name: "review",
        done_column_name: "done",
        skills: "",
        mcp_servers: "",
        github_pat: "new-gh-token",
        jira_api_token: "new-jira-token",
        jira_email: "new@example.com",
      }),
    });

    expect(updateProjectConfigMock).toHaveBeenCalledWith(
      "HYDI",
      expect.objectContaining({
        github_pat: "new-gh-token",
        jira_api_token: "new-jira-token",
        jira_email: "new@example.com",
      })
    );
  });

  it("POST /skills returns 400 for invalid owner/repo format", async () => {
    const { configRouter } = await import("./config.js");
    const res = await configRouter.request("http://localhost/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "invalid-format" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid repo format. Use owner/repo",
    });
  });

  it("POST /skills calls discoverSkills and returns empty results when none found", async () => {
    discoverSkillsMock.mockResolvedValue([]);
    const { configRouter } = await import("./config.js");
    const res = await configRouter.request("http://localhost/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "owner/repo" }),
    });

    expect(res.status).toBe(200);
    expect(discoverSkillsMock).toHaveBeenCalledWith(
      "owner",
      "repo",
      "main",
      undefined
    );
    expect(await res.json()).toEqual([]);
  });

  it("POST /skills returns error response when GitHub lookup fails with 404", async () => {
    discoverSkillsMock.mockRejectedValue(new Error("404 Not Found"));
    const { configRouter } = await import("./config.js");
    const res = await configRouter.request("http://localhost/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "owner/repo" }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "404 Not Found" });
  });

  it("GET /:projectKey/validate returns checks and passes saved mappings to validator", async () => {
    getProjectConfigMock.mockResolvedValue(
      makeProjectConfig({
        board_id: 123,
        model_field_id: "customfield_42",
        backlog_column_name: "Backlog Custom",
        to_do_column_name: "Todo Custom",
        in_progress_column_name: "In Progress Custom",
        in_review_column_name: "In Review Custom",
        done_column_name: "Done Custom",
      })
    );
    validateJiraProjectMock.mockResolvedValue({
      valid: false,
      checks: [
        { name: "Board columns", passed: false, message: "missing done" },
        { name: "Custom field", passed: true, message: "ok" },
        { name: "Workflow statuses", passed: true, message: "ok" },
      ],
    });

    const { configRouter } = await import("./config.js");
    const res = await configRouter.request("http://localhost/HYDI/validate", {
      headers: { accept: "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      valid: false,
      checks: [
        { name: "Board columns", passed: false, message: "missing done" },
        { name: "Custom field", passed: true, message: "ok" },
        { name: "Workflow statuses", passed: true, message: "ok" },
      ],
    });
    expect(validateJiraProjectMock).toHaveBeenCalledWith(
      123,
      "customfield_42",
      {
        backlog: "Backlog Custom",
        toDo: "Todo Custom",
        inProgress: "In Progress Custom",
        inReview: "In Review Custom",
        done: "Done Custom",
      },
      undefined
    );
  });
});