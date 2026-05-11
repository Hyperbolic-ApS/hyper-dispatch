import { describe, expect, it, vi } from "vitest";
import { makeJiraIssue } from "../test/fixtures.js";

const getIssueLinksMock = vi.fn();
const upsertDispatchRunMock = vi.fn();
const resolveEligibilityMock = vi.fn();
const detectCyclesMock = vi.fn();

vi.mock("../jira/client.js", () => ({
  getIssueLinks: getIssueLinksMock,
}));

vi.mock("../db/queries.js", () => ({
  upsertDispatchRun: upsertDispatchRunMock,
}));

vi.mock("./dependency-resolver.js", () => ({
  resolveEligibility: resolveEligibilityMock,
  detectCycles: detectCyclesMock,
}));

describe("syncTicketInToDo", () => {
  it("stores blocked_cycle when cycle is detected", async () => {
    getIssueLinksMock.mockResolvedValue(makeJiraIssue());
    detectCyclesMock.mockResolvedValue({
      hasCycle: true,
      cycleKeys: ["HYDI-1", "HYDI-2", "HYDI-1"],
    });

    const { syncTicketInToDo } = await import("./ticket-sync.js");
    const result = await syncTicketInToDo("HYDI-1", "HYDI");

    expect(result.action).toBe("blocked_cycle");
    expect(upsertDispatchRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketKey: "HYDI-1",
        status: "blocked_cycle",
      })
    );
  });

  it("stores blocked runs when dependencies are unresolved", async () => {
    getIssueLinksMock.mockResolvedValue(makeJiraIssue());
    detectCyclesMock.mockResolvedValue({ hasCycle: false, cycleKeys: [] });
    resolveEligibilityMock.mockResolvedValue({
      eligible: false,
      blockedBy: ["HYDI-10"],
    });

    const { syncTicketInToDo } = await import("./ticket-sync.js");
    const result = await syncTicketInToDo("HYDI-1", "HYDI");

    expect(result).toEqual({
      action: "blocked",
      ticketKey: "HYDI-1",
      blockedBy: ["HYDI-10"],
    });
    expect(upsertDispatchRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        blockedBy: ["HYDI-10"],
      })
    );
  });

  it("stores queued runs when eligible and non-cyclic", async () => {
    getIssueLinksMock.mockResolvedValue(
      makeJiraIssue({
        fields: {
          ...makeJiraIssue().fields,
          priority: { id: "2", name: "High" },
        },
      })
    );
    detectCyclesMock.mockResolvedValue({ hasCycle: false, cycleKeys: [] });
    resolveEligibilityMock.mockResolvedValue({ eligible: true, blockedBy: [] });

    const { syncTicketInToDo } = await import("./ticket-sync.js");
    const result = await syncTicketInToDo("HYDI-3", "HYDI");

    expect(result).toEqual({ action: "queued", ticketKey: "HYDI-3" });
    expect(upsertDispatchRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketKey: "HYDI-3",
        status: "queued",
        priority: 4,
      })
    );
  });
});
