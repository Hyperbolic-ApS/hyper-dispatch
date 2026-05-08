import { describe, expect, it, vi } from "vitest";
import { makeJiraIssue } from "../test/fixtures.js";

const getIssueLinksMock = vi.fn();

vi.mock("../jira/client.js", () => ({
  getIssueLinks: getIssueLinksMock,
}));

describe("resolveEligibility", () => {
  it("returns eligible when blockers are done", async () => {
    getIssueLinksMock.mockResolvedValue(
      makeJiraIssue({
        fields: {
          ...makeJiraIssue().fields,
          issuelinks: [
            {
              id: "1",
              type: { id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" },
              inwardIssue: {
                id: "2",
                key: "HYDI-2",
                fields: {
                  status: {
                    id: "3",
                    name: "Done",
                    statusCategory: { id: 3, key: "done", colorName: "green", name: "Done" },
                  },
                },
              },
            },
          ],
        },
      })
    );

    const { resolveEligibility } = await import("./dependency-resolver.js");
    const result = await resolveEligibility("HYDI-1");
    expect(result).toEqual({ eligible: true, blockedBy: [] });
  });

  it("returns blocked keys for incomplete blockers", async () => {
    getIssueLinksMock.mockResolvedValue(
      makeJiraIssue({
        fields: {
          ...makeJiraIssue().fields,
          issuelinks: [
            {
              id: "1",
              type: { id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" },
              inwardIssue: {
                id: "2",
                key: "HYDI-2",
                fields: {
                  status: {
                    id: "2",
                    name: "In Progress",
                    statusCategory: { id: 4, key: "indeterminate", colorName: "yellow", name: "In Progress" },
                  },
                },
              },
            },
          ],
        },
      })
    );

    const { resolveEligibility } = await import("./dependency-resolver.js");
    const result = await resolveEligibility("HYDI-1");
    expect(result).toEqual({ eligible: false, blockedBy: ["HYDI-2"] });
  });
});

describe("detectCycles", () => {
  it("detects cycles across linked blockers", async () => {
    getIssueLinksMock.mockImplementation(async (key: string) => {
      if (key === "HYDI-1") {
        return makeJiraIssue({
          key,
          fields: {
            ...makeJiraIssue().fields,
            issuelinks: [
              {
                id: "1",
                type: { id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" },
                inwardIssue: { id: "2", key: "HYDI-2" },
              },
            ],
          },
        });
      }

      return makeJiraIssue({
        key,
        fields: {
          ...makeJiraIssue().fields,
          issuelinks: [
            {
              id: "2",
              type: { id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" },
              inwardIssue: { id: "1", key: "HYDI-1" },
            },
          ],
        },
      });
    });

    const { detectCycles } = await import("./dependency-resolver.js");
    const result = await detectCycles("HYDI-1");
    expect(result.hasCycle).toBe(true);
    expect(result.cycleKeys).toContain("HYDI-1");
    expect(result.cycleKeys).toContain("HYDI-2");
  });

  it("returns no-cycle when linked fetch fails", async () => {
    getIssueLinksMock.mockRejectedValue(new Error("boom"));
    const { detectCycles } = await import("./dependency-resolver.js");
    const result = await detectCycles("HYDI-3");
    expect(result).toEqual({ hasCycle: false, cycleKeys: [] });
  });
});
