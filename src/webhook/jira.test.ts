import { beforeEach, describe, expect, it, vi } from "vitest";
import { testClient } from "hono/testing";
import { makeDispatchRun, makeProjectConfig } from "../test/fixtures.js";
const {
  mockGetProjectConfig,
  mockGetRunsBlockedBy,
  mockRemoveBlocker,
  mockUpsertDispatchRun,
  mockGetIssueLinks,
  mockResolveEligibility,
  mockDetectCycles,
} = vi.hoisted(() => ({
  mockGetProjectConfig: vi.fn(),
  mockGetRunsBlockedBy: vi.fn(),
  mockRemoveBlocker: vi.fn(),
  mockUpsertDispatchRun: vi.fn(),
  mockGetIssueLinks: vi.fn(),
  mockResolveEligibility: vi.fn(),
  mockDetectCycles: vi.fn(),
}));

vi.mock("../db/queries.js", () => ({
  getProjectConfig: mockGetProjectConfig,
  getRunsBlockedBy: mockGetRunsBlockedBy,
  removeBlocker: mockRemoveBlocker,
  upsertDispatchRun: mockUpsertDispatchRun,
}));

vi.mock("../jira/client.js", () => ({
  getIssueLinks: mockGetIssueLinks,
}));

vi.mock("../orchestration/dependency-resolver.js", () => ({
  resolveEligibility: mockResolveEligibility,
  detectCycles: mockDetectCycles,
}));

import { webhookRouter } from "./jira.js";

describe("webhookRouter /jira", () => {
  const client = testClient(webhookRouter) as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProjectConfig.mockResolvedValue(makeProjectConfig());
    mockGetRunsBlockedBy.mockResolvedValue([]);
    mockRemoveBlocker.mockResolvedValue(null);
    mockUpsertDispatchRun.mockResolvedValue(makeDispatchRun());
    mockGetIssueLinks.mockResolvedValue({
      fields: {
        summary: "Summary",
        priority: { name: "Medium" },
      },
    });
    mockDetectCycles.mockResolvedValue({ hasCycle: false, cycleKeys: [] });
    mockResolveEligibility.mockResolvedValue({ eligible: true, blockedBy: [] });
  });

  it("returns 400 when body is not valid JSON", async () => {
    const res = await client.jira.$post({
      body: "{not-json}",
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await client.jira.$post({
      json: { issueKey: "HYDI-10" },
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Missing required fields: issueKey, projectKey, transitionTarget",
    });
  });

  it("returns ignored when project is not configured", async () => {
    mockGetProjectConfig.mockResolvedValue(null);

    const res = await client.jira.$post({
      json: {
        issueKey: "HYDI-10",
        projectKey: "HYDI",
        transitionTarget: "To Do",
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      action: "ignored",
      reason: "project not configured",
    });
    expect(mockUpsertDispatchRun).not.toHaveBeenCalled();
  });

  it("blocks with blocked_cycle when detectCycles reports a cycle", async () => {
    mockDetectCycles.mockResolvedValue({
      hasCycle: true,
      cycleKeys: ["HYDI-10", "HYDI-11", "HYDI-10"],
    });

    const res = await client.jira.$post({
      json: {
        issueKey: "HYDI-10",
        projectKey: "HYDI",
        transitionTarget: "To Do",
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      action: "blocked_cycle",
      ticketKey: "HYDI-10",
      cycle: ["HYDI-10", "HYDI-11", "HYDI-10"],
    });
    expect(mockUpsertDispatchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketKey: "HYDI-10",
        projectKey: "HYDI",
        status: "blocked_cycle",
        blockedBy: ["HYDI-10", "HYDI-11", "HYDI-10"],
      })
    );
  });

  it("blocks when active blockers are present", async () => {
    mockResolveEligibility.mockResolvedValue({
      eligible: false,
      blockedBy: ["HYDI-11", "HYDI-12"],
    });

    const res = await client.jira.$post({
      json: {
        issueKey: "HYDI-10",
        projectKey: "HYDI",
        transitionTarget: "To Do",
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      action: "blocked",
      ticketKey: "HYDI-10",
      blockedBy: ["HYDI-11", "HYDI-12"],
    });
    expect(mockUpsertDispatchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        blockedBy: ["HYDI-11", "HYDI-12"],
      })
    );
  });

  it("queues when transition is To Do and issue is eligible", async () => {
    const res = await client.jira.$post({
      json: {
        issueKey: "HYDI-10",
        projectKey: "HYDI",
        transitionTarget: "To Do",
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      action: "queued",
      ticketKey: "HYDI-10",
    });
    expect(mockUpsertDispatchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "queued",
      })
    );
  });

  it("unblocks waiting runs when transition is Done", async () => {
    mockGetRunsBlockedBy.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-20" }),
      makeDispatchRun({ ticket_key: "HYDI-21" }),
    ]);
    mockRemoveBlocker
      .mockResolvedValueOnce(makeDispatchRun({ ticket_key: "HYDI-20" }))
      .mockResolvedValueOnce(null);

    const res = await client.jira.$post({
      json: {
        issueKey: "HYDI-10",
        projectKey: "HYDI",
        transitionTarget: "Done",
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ action: "unblocked", count: 1 });
    expect(mockGetRunsBlockedBy).toHaveBeenCalledWith("HYDI-10");
    expect(mockRemoveBlocker).toHaveBeenCalledTimes(2);
    expect(mockRemoveBlocker).toHaveBeenNthCalledWith(1, "HYDI-20", "HYDI-10");
    expect(mockRemoveBlocker).toHaveBeenNthCalledWith(2, "HYDI-21", "HYDI-10");
  });

  it("matches custom configured column names case-insensitively", async () => {
    mockGetProjectConfig.mockResolvedValue(
      makeProjectConfig({
        to_do_column_name: "Ready For Dev",
        done_column_name: "Shipped",
      })
    );

    const res = await client.jira.$post({
      json: {
        issueKey: "HYDI-10",
        projectKey: "HYDI",
        transitionTarget: "  READY for dev ",
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      action: "queued",
      ticketKey: "HYDI-10",
    });
    expect(mockUpsertDispatchRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "queued" })
    );
  });

  it("returns ignored for transitions that are neither To Do nor Done", async () => {
    const res = await client.jira.$post({
      json: {
        issueKey: "HYDI-10",
        projectKey: "HYDI",
        transitionTarget: "In Progress",
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ action: "ignored" });
    expect(mockUpsertDispatchRun).not.toHaveBeenCalled();
    expect(mockGetRunsBlockedBy).not.toHaveBeenCalled();
  });

  it("maps known priority names to queue priority numbers", async () => {
    mockGetIssueLinks.mockResolvedValue({
      fields: {
        summary: "Summary",
        priority: { name: "Highest" },
      },
    });

    await client.jira.$post({
      json: {
        issueKey: "HYDI-10",
        projectKey: "HYDI",
        transitionTarget: "To Do",
      },
    });

    expect(mockUpsertDispatchRun).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 5 })
    );
  });

  it("defaults priority to 0 when Jira issue has no priority", async () => {
    mockGetIssueLinks.mockResolvedValue({
      fields: {
        summary: "Summary",
      },
    });

    await client.jira.$post({
      json: {
        issueKey: "HYDI-10",
        projectKey: "HYDI",
        transitionTarget: "To Do",
      },
    });

    expect(mockUpsertDispatchRun).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 0 })
    );
  });
});
