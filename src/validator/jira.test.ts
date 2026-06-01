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

  it("passes board columns check when all required default columns are present", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          columnConfig: {
            columns: [
              { name: "Backlog" },
              { name: "To Do" },
              { name: "In Progress" },
              { name: "In Review" },
              { name: "Done" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { id: "customfield_10", name: "Model field" },
          { id: "customfield_20", name: "Other field" },
        ])
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { name: "Backlog" },
          { name: "To Do" },
          { name: "In Progress" },
          { name: "In Review" },
          { name: "Done" },
        ])
      );

    const result = await validateJiraProject(
      22,
      "customfield_10",
      undefined,
      credentials
    );
    const boardCheck = result.checks.find((check) => check.name === "Board columns");

    expect(boardCheck).toEqual(
      expect.objectContaining({
        passed: true,
      })
    );
    expect(boardCheck?.message).toContain("All required columns present");
    expect(result.valid).toBe(true);
  });

  it("fails board columns check and lists missing columns", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          columnConfig: {
            columns: [{ name: "Backlog" }, { name: "To Do" }, { name: "Done" }],
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ name: "Backlog" }]));

    const result = await validateJiraProject(
      33,
      "customfield_10",
      undefined,
      credentials
    );
    const boardCheck = result.checks.find((check) => check.name === "Board columns");

    expect(boardCheck?.passed).toBe(false);
    expect(boardCheck?.message).toContain("Missing columns");
    expect(boardCheck?.message).toContain("In Progress");
    expect(boardCheck?.message).toContain("In Review");
  });

  it("fails board columns check when board endpoint returns 401", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401, statusText: "Unauthorized" })
      )
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]));
    const result = await validateJiraProject(
      10,
      "customfield_10",
      undefined,
      credentials
    );
    const boardCheck = result.checks.find((check) => check.name === "Board columns");

    expect(boardCheck?.passed).toBe(false);
    expect(boardCheck?.message).toContain("401");
  });

  it("fails board columns check when board endpoint returns 404", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("Not Found", { status: 404, statusText: "Not Found" }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]));
    const result = await validateJiraProject(
      10,
      "customfield_10",
      undefined,
      credentials
    );
    const boardCheck = result.checks.find((check) => check.name === "Board columns");

    expect(boardCheck?.passed).toBe(false);
    expect(boardCheck?.message).toContain("404");
  });

  it("fails board columns check with thrown network error message", async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]));
    const result = await validateJiraProject(
      44,
      "customfield_10",
      undefined,
      credentials
    );
    const boardCheck = result.checks.find((check) => check.name === "Board columns");
    expect(boardCheck?.passed).toBe(false);
    expect(boardCheck?.message).toContain("network down");
  });

  it("honors custom column mappings with mixed case and whitespace via jiraNamesEqual", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          columnConfig: {
            columns: [
              { name: " backlog " },
              { name: " to do " },
              { name: " in progress " },
              { name: "IN REVIEW" },
              { name: "done " },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { name: "BACKLOG" },
          { name: "to do" },
          { name: "In Progress " },
          { name: "in review" },
          { name: " DONE" },
        ])
      );

    const result = await validateJiraProject(
      22,
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
    const boardCheck = result.checks.find((check) => check.name === "Board columns");
    const statusCheck = result.checks.find(
      (check) => check.name === "Workflow statuses"
    );

    expect(boardCheck?.passed).toBe(true);
    expect(statusCheck?.passed).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("passes custom field check as skipped when modelFieldId is null", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          columnConfig: {
            columns: [
              { name: "Backlog" },
              { name: "To Do" },
              { name: "In Progress" },
              { name: "In Review" },
              { name: "Done" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { name: "Backlog" },
          { name: "To Do" },
          { name: "In Progress" },
          { name: "In Review" },
          { name: "Done" },
        ])
      );

    const result = await validateJiraProject(22, null, undefined, credentials);
    const customFieldCheck = result.checks.find((check) => check.name === "Custom field");

    expect(customFieldCheck?.passed).toBe(true);
    expect(customFieldCheck?.message).toContain("skipped");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("passes custom field check when configured field exists", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ columnConfig: { columns: [] } }))
      .mockResolvedValueOnce(
        jsonResponse([{ id: "customfield_10010", name: "Model Selector" }])
      )
      .mockResolvedValueOnce(jsonResponse([]));

    const result = await validateJiraProject(
      22,
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
      .mockResolvedValueOnce(jsonResponse({ columnConfig: { columns: [] } }))
      .mockResolvedValueOnce(jsonResponse([{ id: "customfield_55", name: "Other" }]))
      .mockResolvedValueOnce(jsonResponse([]));

    const result = await validateJiraProject(
      22,
      "customfield_10010",
      undefined,
      credentials
    );
    const customFieldCheck = result.checks.find((check) => check.name === "Custom field");

    expect(customFieldCheck?.passed).toBe(false);
    expect(customFieldCheck?.message).toContain("not found");
  });

  it("fails workflow statuses check when required statuses are missing", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          columnConfig: {
            columns: [
              { name: "Backlog" },
              { name: "To Do" },
              { name: "In Progress" },
              { name: "In Review" },
              { name: "Done" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        jsonResponse([
          { name: "Backlog" },
          { name: "To Do" },
          { name: "In Progress" },
          { name: "In Review" },
        ])
      );

    const result = await validateJiraProject(
      22,
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

  it("sets final valid to checks.every(c => c.passed)", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          columnConfig: {
            columns: [
              { name: "Backlog" },
              { name: "To Do" },
              { name: "In Progress" },
              { name: "In Review" },
              { name: "Done" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse([{ id: "customfield_10010", name: "Model Selector" }])
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { name: "Backlog" },
          { name: "To Do" },
          { name: "In Progress" },
        ])
      );

    const result = await validateJiraProject(
      22,
      "customfield_10010",
      undefined,
      credentials
    );

    expect(result.checks).toHaveLength(3);
    expect(result.checks.map((check) => check.passed)).toEqual([true, true, false]);
    expect(result.valid).toBe(result.checks.every((check) => check.passed));
    expect(result.valid).toBe(false);
  });
});