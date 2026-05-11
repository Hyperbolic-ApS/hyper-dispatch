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

describe("configRouter", () => {
  it("returns 404 when validating a missing project", async () => {
    getProjectConfigMock.mockResolvedValue(null);
    const { configRouter } = await import("./config.js");
    const res = await configRouter.request("http://localhost/MISSING/validate");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Project MISSING not found" });
  });

  it("returns JSON validation output for api clients", async () => {
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    validateJiraProjectMock.mockResolvedValue({
      valid: true,
      checks: [{ name: "Board columns", passed: true, message: "ok" }],
    });

    const { configRouter } = await import("./config.js");
    const res = await configRouter.request("http://localhost/HYDI/validate", {
      headers: { accept: "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      valid: true,
      checks: [{ name: "Board columns", passed: true, message: "ok" }],
    });
  });

  it("returns HTML validation output when requested", async () => {
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    validateJiraProjectMock.mockResolvedValue({
      valid: false,
      checks: [{ name: "Workflow statuses", passed: false, message: "Missing statuses: Done" }],
    });

    const { configRouter } = await import("./config.js");
    const res = await configRouter.request("http://localhost/HYDI/validate", {
      headers: { accept: "text/html" },
    });

    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Validate: HYDI");
    expect(html).toContain("Missing statuses: Done");
  });

  it("returns 400 for malformed MCP JSON on create", async () => {
    const { configRouter } = await import("./config.js");
    const body = new URLSearchParams({
      project_key: "HYDI",
      jira_cloud_id: "cloud",
      board_id: "1",
      oz_env_id: "env",
      github_repo: "org/repo",
      mcp_servers: "{\"broken\"",
    });

    const res = await configRouter.request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid MCP servers JSON");
    expect(createProjectConfigMock).not.toHaveBeenCalled();
  });
});
