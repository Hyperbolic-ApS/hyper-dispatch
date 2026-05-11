import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getIssueLinksMock } = vi.hoisted(() => ({
  getIssueLinksMock: vi.fn(),
}));

vi.mock("../jira/client.js", () => ({
  getIssueLinks: getIssueLinksMock,
}));

import { detectCycles, resolveEligibility } from "./dependency-resolver.js";

function blockedByLink(
  key: string,
  statusCategoryKey: string | null = "done"
): Record<string, unknown> {
  const status =
    statusCategoryKey === null
      ? {}
      : {
          statusCategory: { key: statusCategoryKey },
        };

  return {
    id: `link-${key}`,
    type: {
      id: "10",
      name: "Blocks",
      inward: "is blocked by",
      outward: "blocks",
    },
    inwardIssue: {
      id: `issue-${key}`,
      key,
      fields: {
        status,
      },
    },
  } as Record<string, unknown>;
}

function outwardLink(key: string): Record<string, unknown> {
  return {
    id: `out-${key}`,
    type: {
      id: "11",
      name: "Relates",
      inward: "relates to",
      outward: "relates to",
    },
    inwardIssue: {
      id: `issue-${key}`,
      key,
      fields: {
        status: {
          statusCategory: { key: "new" },
        },
      },
    },
  };
}

describe("resolveEligibility", () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    getIssueLinksMock.mockReset();
  });

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns eligible when issue has no issuelinks", async () => {
    getIssueLinksMock.mockResolvedValueOnce({
      fields: {},
    });

    const result = await resolveEligibility("HYDI-32");

    expect(result).toEqual({ eligible: true, blockedBy: [] });
  });

  it("returns eligible when all blockers are done", async () => {
    getIssueLinksMock.mockResolvedValueOnce({
      fields: {
        issuelinks: [blockedByLink("HYDI-1", "done"), blockedByLink("HYDI-2", "done")],
      },
    });

    const result = await resolveEligibility("HYDI-32");
    expect(result).toEqual({ eligible: true, blockedBy: [] });
  });

  it("returns blocked key when one blocker is not done", async () => {
    getIssueLinksMock.mockResolvedValueOnce({
      fields: {
        issuelinks: [blockedByLink("HYDI-1", "done"), blockedByLink("HYDI-2", "indeterminate")],
      },
    });

    const result = await resolveEligibility("HYDI-32");
    expect(result).toEqual({ eligible: false, blockedBy: ["HYDI-2"] });
  });

  it("treats blockers with missing statusCategory as blocking", async () => {
    getIssueLinksMock.mockResolvedValueOnce({
      fields: {
        issuelinks: [blockedByLink("HYDI-3", null)],
      },
    });

    const result = await resolveEligibility("HYDI-32");
    expect(result).toEqual({ eligible: false, blockedBy: ["HYDI-3"] });
  });

  it("ignores links whose inward relation is not 'is blocked by'", async () => {
    getIssueLinksMock.mockResolvedValueOnce({
      fields: {
        issuelinks: [outwardLink("HYDI-4")],
      },
    });

    const result = await resolveEligibility("HYDI-32");
    expect(result).toEqual({ eligible: true, blockedBy: [] });
  });
});

describe("detectCycles", () => {
  beforeEach(() => {
    getIssueLinksMock.mockReset();
  });

  it("returns no cycle for linear chain A→B→C", async () => {
    getIssueLinksMock.mockImplementation(async (key: string) => {
      if (key === "A") return { fields: { issuelinks: [blockedByLink("B")] } };
      if (key === "B") return { fields: { issuelinks: [blockedByLink("C")] } };
      return { fields: { issuelinks: [] } };
    });

    const result = await detectCycles("A");
    expect(result).toEqual({ hasCycle: false, cycleKeys: [] });
  });

  it("detects self-cycle A→A", async () => {
    getIssueLinksMock.mockResolvedValue({
      fields: { issuelinks: [blockedByLink("A")] },
    });

    const result = await detectCycles("A");
    expect(result.hasCycle).toBe(true);
    expect(result.cycleKeys).toEqual(["A", "A"]);
  });

  it("detects two-node cycle A→B→A", async () => {
    getIssueLinksMock.mockImplementation(async (key: string) => {
      if (key === "A") return { fields: { issuelinks: [blockedByLink("B")] } };
      return { fields: { issuelinks: [blockedByLink("A")] } };
    });

    const result = await detectCycles("A");
    expect(result.hasCycle).toBe(true);
    expect(result.cycleKeys).toEqual(["A", "B", "A"]);
  });

  it("detects cycle at end of deep chain", async () => {
    getIssueLinksMock.mockImplementation(async (key: string) => {
      if (key === "A") return { fields: { issuelinks: [blockedByLink("B")] } };
      if (key === "B") return { fields: { issuelinks: [blockedByLink("C")] } };
      if (key === "C") return { fields: { issuelinks: [blockedByLink("D")] } };
      return { fields: { issuelinks: [blockedByLink("B")] } };
    });

    const result = await detectCycles("A");
    expect(result.hasCycle).toBe(true);
    expect(result.cycleKeys).toEqual(["A", "B", "C", "D", "B"]);
  });

  it("returns no cycle when a fetch error occurs mid traversal", async () => {
    getIssueLinksMock.mockImplementation(async (key: string) => {
      if (key === "A") return { fields: { issuelinks: [blockedByLink("B")] } };
      throw new Error(`Unable to fetch ${key}`);
    });

    const result = await detectCycles("A");
    // TODO(HYDI-32): detectCycles currently swallows fetch errors and reports no-cycle.
    expect(result).toEqual({ hasCycle: false, cycleKeys: [] });
  });
});
