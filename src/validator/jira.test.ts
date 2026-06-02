import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateJiraProject } from "./jira.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("validateJiraProject", () => {
  const credentials = { cloudId: "test-cloud-id", apiToken: "token-value" };
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as typeof globalThis & { fetch: typeof fetch }, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function projectStatusesResponse(statusNames: string[]) {
    return jsonResponse([{ statuses: statusNames.map((name) => ({ name })) }]);
  }

  it("passes workflow statuses check when all required default statuses are present", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        projectStatusesResponse(["Backlog", "To Do", "In Progress", "In Review", "Done"])
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { id: "customfield_10", name: "Model field" },
          { id: "customfield_20", name: "Other field" },
        ])
      );

    const result = await validateJiraProject(
      "TEST",
      "customfield_10",
      undefined,
      credentials
    );
    const statusCheck = result.checks.find((check) => check.name === "Workflow statuses");

    expect(statusCheck).toEqual(
      expect.objectContaining({
        passed: true,
      })
    );
    expect(statusCheck?.message).toContain("All required statuses present");
    expect(result.valid).toBe(true);
  });

  it("fails workflow statuses check and lists missing statuses", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        projectStatusesResponse(["Backlog", "To Do", "Done"])
      )
      .mockResolvedValueOnce(jsonResponse([]));

    const result = await validateJiraProject(
      "TEST",
      "customfield_10",
      undefined,
      credentials
    );
    const statusCheck = result.checks.find((check) => check.name === "Workflow statuses");

    expect(statusCheck?.passed).toBe(false);
    expect(statusCheck?.message).toContain("Missing statuses");
    expect(statusCheck?.message).toContain("In Progress");
    expect(statusCheck?.message).toContain("In Review");
  });

  it("fails workflow statuses check when project statuses endpoint returns 401", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401, statusText: "Unauthorized" })
      )
      .mockResolvedValueOnce(jsonResponse([]));
    const result = await validateJiraProject(
      "TEST",
      "customfield_10",
      undefined,
      credentials
    );
    const statusCheck = result.checks.find((check) => check.name === "Workflow statuses");

    expect(statusCheck?.passed).toBe(false);
    expect(statusCheck?.message).toContain("401");
  });

  it("fails workflow statuses check when project statuses endpoint returns 404", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("Not Found", { status: 404, statusText: "Not Found" }))
      .mockResolvedValueOnce(jsonResponse([]));
    const result = await validateJiraProject(
      "TEST",
      "customfield_10",
      undefined,
      credentials
    );
    const statusCheck = result.checks.find((check) => check.name === "Workflow statuses");

    expect(statusCheck?.passed).toBe(false);
    expect(statusCheck?.message).toContain("404");
  });

  it("fails workflow statuses check with thrown network error message", async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse([]));
    const result = await validateJiraProject(
      "TEST",
      "customfield_10",
      undefined,
      credentials
    );
    const statusCheck = result.checks.find((check) => check.name === "Workflow statuses");
    expect(statusCheck?.passed).toBe(false);
    expect(statusCheck?.message).toContain("network down");
  });

  it("honors custom column mappings with mixed case and whitespace via jiraNamesEqual", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        projectStatusesResponse([" backlog ", " to do ", " in progress ", "IN REVIEW", "done "])
      );

    const result = await validateJiraProject(
      "TEST",
      null,
      {
        backlog: " Backlog ",
        toDo: "to do",
        inProgress: "In Progress",
        inReview: "In Review",
        done: "Done ",
      },
      credentials
    );
    const statusCheck = result.checks.find((check) => check.name === "Workflow statuses");

    expect(statusCheck?.passed).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("passes custom field check as skipped when modelFieldId is null", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        projectStatusesResponse(["Backlog", "To Do", "In Progress", "In Review", "Done"])
      );

    const result = await validateJiraProject("TEST", null, undefined, credentials);
    const customFieldCheck = result.checks.find((check) => check.name === "Custom field");

    expect(customFieldCheck?.passed).toBe(true);
    expect(customFieldCheck?.message).toContain("skipped");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("passes custom field check when configured field exists", async () => {
    fetchSpy
      .mockResolvedValueOnce(projectStatusesResponse([]))
      .mockResolvedValueOnce(
        jsonResponse([{ id: "customfield_10010", name: "Model Selector" }])
      );

    const result = await validateJiraProject(
      "TEST",
      "customfield_10010",
      undefined,
      credentials
    );
    const customFieldCheck = result.checks.find((check) => check.name === "Custom field");

    expect(customFieldCheck?.passed).toBe(true);
    expect(customFieldCheck?.message).toContain("customfield_10010");
  });

  it("fails custom field check when configured field does not exist", async () => {
    fetchSpy
      .mockResolvedValueOnce(projectStatusesResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ id: "customfield_55", name: "Other" }]));

    const result = await validateJiraProject(
      "TEST",
      "customfield_10010",
      undefined,
      credentials
    );
    const customFieldCheck = result.checks.find((check) => check.name === "Custom field");

    expect(customFieldCheck?.passed).toBe(false);
    expect(customFieldCheck?.message).toContain("not found");
  });

  it("fails workflow statuses check when a single required status is missing", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        projectStatusesResponse(["Backlog", "To Do", "In Progress", "In Review"])
      )
      .mockResolvedValueOnce(jsonResponse([]));

    const result = await validateJiraProject(
      "TEST",
      "customfield_10010",
      undefined,
      credentials
    );
    const statusCheck = result.checks.find(
      (check) => check.name === "Workflow statuses"
    );

    expect(statusCheck?.passed).toBe(false);
    expect(statusCheck?.message).toContain("Missing statuses: Done");
  });

  it("deduplicates statuses across multiple issue types", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse([
          { statuses: [{ name: "Backlog" }, { name: "To Do" }, { name: "In Progress" }] },
          { statuses: [{ name: "In Progress" }, { name: "In Review" }, { name: "Done" }] },
        ])
      );

    const result = await validateJiraProject("TEST", null, undefined, credentials);
    const statusCheck = result.checks.find((check) => check.name === "Workflow statuses");

    expect(statusCheck?.passed).toBe(true);
    expect(statusCheck?.message).toContain("All required statuses present");
  });

  it("sets final valid to checks.every(c => c.passed)", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        projectStatusesResponse(["Backlog", "To Do", "In Progress"])
      )
      .mockResolvedValueOnce(
        jsonResponse([{ id: "customfield_10010", name: "Model Selector" }])
      );

    const result = await validateJiraProject(
      "TEST",
      "customfield_10010",
      undefined,
      credentials
    );

    expect(result.checks).toHaveLength(2);
    expect(result.checks.map((check) => check.passed)).toEqual([false, true]);
    expect(result.valid).toBe(result.checks.every((check) => check.passed));
    expect(result.valid).toBe(false);
  });
});
