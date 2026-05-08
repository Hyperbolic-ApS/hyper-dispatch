import { describe, expect, it, vi } from "vitest";
import { validateJiraProject } from "./jira.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("validateJiraProject", () => {
  it("returns valid=true when board columns, field, and statuses are present", async () => {
    const fetchMock = vi
      .fn()
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
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateJiraProject(22, "customfield_10");

    expect(result.valid).toBe(true);
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports missing workflow status and missing custom field", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
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
        .mockResolvedValueOnce(jsonResponse([{ id: "customfield_11", name: "Wrong" }]))
        .mockResolvedValueOnce(
          jsonResponse([
            { name: "Backlog" },
            { name: "To Do" },
            { name: "In Progress" },
            { name: "In Review" },
          ])
        )
    );

    const result = await validateJiraProject(33, "customfield_10");
    const customFieldCheck = result.checks.find((c) => c.name === "Custom field");
    const statusCheck = result.checks.find((c) => c.name === "Workflow statuses");

    expect(result.valid).toBe(false);
    expect(customFieldCheck?.passed).toBe(false);
    expect(statusCheck?.passed).toBe(false);
    expect(statusCheck?.message).toContain("Missing statuses");
  });

  it("handles network errors as failed checks", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const result = await validateJiraProject(44, null);

    expect(result.valid).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Board columns", passed: false }),
        expect.objectContaining({ name: "Workflow statuses", passed: false }),
      ])
    );
  });
});
