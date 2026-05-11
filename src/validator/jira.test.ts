import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateJiraProject } from "./jira.js";
import type { JiraCredentials } from "./jira.js";

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

describe("validateJiraProject", () => {
  const credentials: JiraCredentials = {
    email: "project@example.com",
    apiToken: "jira-token",
  };

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  it("passes board and workflow checks with defaults and skips field check when modelFieldId is null", async () => {
    vi.mocked(globalThis.fetch)
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

    expect(
      result.checks.find((check) => check.name === "Board columns")
    ).toEqual(expect.objectContaining({ passed: true }));
    expect(result.checks.find((check) => check.name === "Custom field")).toEqual(
      expect.objectContaining({
        passed: true,
        message: "No model_field_id configured — skipped",
      })
    );
    expect(
      result.checks.find((check) => check.name === "Workflow statuses")
    ).toEqual(expect.objectContaining({ passed: true }));
    expect(result.valid).toBe(result.checks.every((check) => check.passed));
  });

  it("fails board columns check when a required default column is missing", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          columnConfig: {
            columns: [
              { name: "Backlog" },
              { name: "To Do" },
              { name: "In Progress" },
              { name: "In Review" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse([{ name: "Backlog" }]));

    const result = await validateJiraProject(33, null, undefined, credentials);

    expect(result.checks.find((check) => check.name === "Board columns")).toEqual(
      expect.objectContaining({
        passed: false,
        message: expect.stringContaining("Missing columns: Done"),
      })
    );
    expect(result.valid).toBe(false);
  });

  it("includes status code details when board configuration endpoint returns 401 or 404", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(jsonResponse({}, 401, "Unauthorized"))
      .mockResolvedValueOnce(jsonResponse([{ name: "Backlog" }]));
    const unauthorized = await validateJiraProject(44, null, undefined, credentials);

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(jsonResponse({}, 404, "Not Found"))
      .mockResolvedValueOnce(jsonResponse([{ name: "Backlog" }]));
    const notFound = await validateJiraProject(44, null, undefined, credentials);

    expect(
      unauthorized.checks.find((check) => check.name === "Board columns")?.message
    ).toContain("401 Unauthorized");
    expect(
      notFound.checks.find((check) => check.name === "Board columns")?.message
    ).toContain("404 Not Found");
  });

  it("handles board configuration network errors as failed checks with error message", async () => {
    vi.mocked(globalThis.fetch)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse([{ name: "Backlog" }]));

    const result = await validateJiraProject(50, null, undefined, credentials);

    expect(result.checks.find((check) => check.name === "Board columns")).toEqual(
      expect.objectContaining({
        passed: false,
        message: "Error: network down",
      })
    );
  });

  it("honors custom mappings with mixed case and whitespace via jiraNamesEqual for columns and statuses", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          columnConfig: {
            columns: [
              { name: "  backlog  " },
              { name: "to do" },
              { name: "IN PROGRESS" },
              { name: "in review" },
              { name: " DONE " },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { name: " BACKLOG " },
          { name: "To Do" },
          { name: "in progress" },
          { name: "IN REVIEW" },
          { name: "done" },
        ])
      );

    const result = await validateJiraProject(
      55,
      null,
      {
        backlog: " Backlog ",
        toDo: " To Do ",
        inProgress: " In Progress ",
        inReview: " in review ",
        done: " Done ",
      },
      credentials
    );

    expect(
      result.checks.find((check) => check.name === "Board columns")?.passed
    ).toBe(true);
    expect(
      result.checks.find((check) => check.name === "Workflow statuses")?.passed
    ).toBe(true);
  });

  it("passes custom field check when field exists and fails when field is missing", async () => {
    vi.mocked(globalThis.fetch)
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
        jsonResponse([{ id: "customfield_10", name: "Model Field" }])
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
    const exists = await validateJiraProject(
      60,
      "customfield_10",
      undefined,
      credentials
    );

    vi.mocked(globalThis.fetch)
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
        jsonResponse([{ id: "customfield_11", name: "Different Field" }])
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
    const missing = await validateJiraProject(
      60,
      "customfield_10",
      undefined,
      credentials
    );

    expect(exists.checks.find((check) => check.name === "Custom field")).toEqual(
      expect.objectContaining({ passed: true })
    );
    expect(missing.checks.find((check) => check.name === "Custom field")).toEqual(
      expect.objectContaining({
        passed: false,
        message: 'Field "customfield_10" not found in project fields',
      })
    );
  });

  it("fails workflow statuses check for missing statuses and for non-200 responses", async () => {
    vi.mocked(globalThis.fetch)
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
        ])
      );
    const missingStatuses = await validateJiraProject(70, null, undefined, credentials);

    vi.mocked(globalThis.fetch)
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
      .mockResolvedValueOnce(jsonResponse({}, 500, "Server Error"));
    const statusHttpFailure = await validateJiraProject(
      70,
      null,
      undefined,
      credentials
    );

    expect(
      missingStatuses.checks.find((check) => check.name === "Workflow statuses")
    ).toEqual(
      expect.objectContaining({
        passed: false,
        message: expect.stringContaining("Missing statuses"),
      })
    );
    expect(
      statusHttpFailure.checks.find((check) => check.name === "Workflow statuses")
    ).toEqual(
      expect.objectContaining({
        passed: false,
        message: expect.stringContaining("Failed to fetch statuses: 500"),
      })
    );
  });

  it("derives final valid flag strictly from checks.every(c => c.passed)", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          columnConfig: { columns: [{ name: "Backlog" }] },
        })
      )
      .mockResolvedValueOnce(jsonResponse([{ name: "Backlog" }]));
    const invalid = await validateJiraProject(80, null, undefined, credentials);

    vi.mocked(globalThis.fetch)
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
    const valid = await validateJiraProject(80, null, undefined, credentials);

    expect(invalid.valid).toBe(false);
    expect(valid.valid).toBe(true);
    expect(invalid.valid).toBe(invalid.checks.every((check) => check.passed));
    expect(valid.valid).toBe(valid.checks.every((check) => check.passed));
  });
});