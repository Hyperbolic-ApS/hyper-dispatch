import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateJiraProject, type JiraCredentials } from "./jira.js";

const CREDS: JiraCredentials = {
  email: "agent@example.com",
  apiToken: "token",
};

function jsonResponse(
  body: unknown,
  init: { status?: number; statusText?: string } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { "content-type": "application/json" },
  });
}

describe("validateJiraProject", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("passes board columns and statuses for default mappings and reports valid from checks.every", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
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
      .mockResolvedValueOnce(jsonResponse([{ name: "Backlog" }, { name: "To Do" }, { name: "In Progress" }, { name: "In Review" }, { name: "Done" }]));

    const result = await validateJiraProject(7, null, undefined, CREDS);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Board columns", passed: true }),
        expect.objectContaining({
          name: "Custom field",
          passed: true,
          message: "No model_field_id configured — skipped",
        }),
        expect.objectContaining({ name: "Workflow statuses", passed: true }),
      ])
    );
    expect(result.valid).toBe(result.checks.every((c) => c.passed));
    expect(result.valid).toBe(true);
  });

  it("fails board columns when required defaults are missing and lists missing values", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          columnConfig: {
            columns: [
              { name: "Backlog" },
              { name: "To Do" },
              { name: "In Progress" },
              { name: "Done" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse([{ name: "Backlog" }, { name: "To Do" }, { name: "In Progress" }, { name: "In Review" }, { name: "Done" }]));

    const result = await validateJiraProject(7, null, undefined, CREDS);
    const board = result.checks.find((c) => c.name === "Board columns");

    expect(board?.passed).toBe(false);
    expect(board?.message).toContain("Missing columns: In Review");
    expect(result.valid).toBe(false);
  });

  it("fails board columns when Jira board endpoint returns non-OK status and includes status details", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({}, { status: 401, statusText: "Unauthorized" }))
      .mockResolvedValueOnce(jsonResponse([{ name: "Backlog" }, { name: "To Do" }, { name: "In Progress" }, { name: "In Review" }, { name: "Done" }]));

    const result401 = await validateJiraProject(7, null, undefined, CREDS);
    const board401 = result401.checks.find((c) => c.name === "Board columns");
    expect(board401?.passed).toBe(false);
    expect(board401?.message).toContain("401 Unauthorized");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({}, { status: 404, statusText: "Not Found" }))
      .mockResolvedValueOnce(jsonResponse([{ name: "Backlog" }, { name: "To Do" }, { name: "In Progress" }, { name: "In Review" }, { name: "Done" }]));

    const result404 = await validateJiraProject(7, null, undefined, CREDS);
    const board404 = result404.checks.find((c) => c.name === "Board columns");
    expect(board404?.passed).toBe(false);
    expect(board404?.message).toContain("404 Not Found");
  });

  it("fails board columns on network errors with the thrown message", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse([{ name: "Backlog" }, { name: "To Do" }, { name: "In Progress" }, { name: "In Review" }, { name: "Done" }]));

    const result = await validateJiraProject(7, null, undefined, CREDS);
    const board = result.checks.find((c) => c.name === "Board columns");

    expect(board?.passed).toBe(false);
    expect(board?.message).toContain("network down");
  });

  it("honors trimmed and case-insensitive custom column mappings for board and workflow checks", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          columnConfig: {
            columns: [
              { name: " backlog " },
              { name: "todo lane" },
              { name: "working" },
              { name: "REVIEW" },
              { name: " shipped " },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { name: "BACKLOG" },
          { name: "Todo Lane" },
          { name: "Working" },
          { name: "review" },
          { name: "Shipped" },
        ])
      );

    const result = await validateJiraProject(
      7,
      null,
      {
        backlog: "  Backlog",
        toDo: "TODO lane ",
        inProgress: " working ",
        inReview: "review",
        done: "SHIPPED",
      },
      CREDS
    );

    expect(result.checks.find((c) => c.name === "Board columns")?.passed).toBe(true);
    expect(result.checks.find((c) => c.name === "Workflow statuses")?.passed).toBe(
      true
    );
  });

  it("passes custom field check when field exists and fails when it is missing", async () => {
    vi.spyOn(globalThis, "fetch")
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
      .mockResolvedValueOnce(jsonResponse([{ id: "customfield_10050", name: "Model" }]))
      .mockResolvedValueOnce(jsonResponse([{ name: "Backlog" }, { name: "To Do" }, { name: "In Progress" }, { name: "In Review" }, { name: "Done" }]));

    const foundResult = await validateJiraProject(
      7,
      "customfield_10050",
      undefined,
      CREDS
    );
    expect(foundResult.checks.find((c) => c.name === "Custom field")?.passed).toBe(true);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch")
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
      .mockResolvedValueOnce(jsonResponse([{ id: "customfield_99999", name: "Other" }]))
      .mockResolvedValueOnce(jsonResponse([{ name: "Backlog" }, { name: "To Do" }, { name: "In Progress" }, { name: "In Review" }, { name: "Done" }]));

    const missingResult = await validateJiraProject(
      7,
      "customfield_10050",
      undefined,
      CREDS
    );
    const field = missingResult.checks.find((c) => c.name === "Custom field");
    expect(field?.passed).toBe(false);
    expect(field?.message).toContain('Field "customfield_10050" not found');
  });

  it("fails workflow statuses when required status is missing", async () => {
    vi.spyOn(globalThis, "fetch")
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
      .mockResolvedValueOnce(jsonResponse([{ name: "Backlog" }, { name: "To Do" }, { name: "In Progress" }, { name: "In Review" }]));

    const result = await validateJiraProject(7, null, undefined, CREDS);
    const status = result.checks.find((c) => c.name === "Workflow statuses");

    expect(status?.passed).toBe(false);
    expect(status?.message).toContain("Missing statuses: Done");
  });
});
