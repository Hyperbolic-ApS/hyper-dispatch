import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDispatchRun,
  makeJiraIssue,
  makeProjectConfig,
} from "../test/fixtures.js";

const {
  mockClaimRunForSpawn,
  mockReleaseSpawnClaim,
  mockUpdateRunStatus,
  mockEnv,
  mockGetActiveRunCount,
  mockGetRunsByStatus,
  mockListActiveProjectConfigs,
  mockGetRunsByProject,
  mockDeleteRun,
  mockGetIssue,
  mockGetIssuesByKeys,
  mockSetTicketStatuses,
  mockSearchIssuesInStatus,
  mockSpawnAgent,
  mockSyncTicketInToDo,
  MockJiraApiError,
} = vi.hoisted(() => {
  class JiraApiError extends Error {
    status: number;

    constructor(status: number, message = "Jira API Error") {
      super(message);
      this.status = status;
    }
  }

  return {
    mockClaimRunForSpawn: vi.fn(),
    mockReleaseSpawnClaim: vi.fn(),
    mockUpdateRunStatus: vi.fn(),
    mockEnv: { MAX_CONCURRENT_AGENTS: 4 },
    mockGetActiveRunCount: vi.fn(),
    mockGetRunsByStatus: vi.fn(),
    mockListActiveProjectConfigs: vi.fn(),
    mockGetRunsByProject: vi.fn(),
    mockDeleteRun: vi.fn(),
    mockGetIssue: vi.fn(),
    mockGetIssuesByKeys: vi.fn(),
    mockSetTicketStatuses: vi.fn(),
    mockSearchIssuesInStatus: vi.fn(),
    mockSpawnAgent: vi.fn(),
    mockSyncTicketInToDo: vi.fn(),
    MockJiraApiError: JiraApiError,
  };
});

vi.mock("../config/env.js", () => ({
  env: mockEnv,
}));

vi.mock("../db/queries.js", () => ({
  claimRunForSpawn: mockClaimRunForSpawn,
  releaseSpawnClaim: mockReleaseSpawnClaim,
  updateRunStatus: mockUpdateRunStatus,
  getActiveRunCount: mockGetActiveRunCount,
  getRunsByStatus: mockGetRunsByStatus,
  listActiveProjectConfigs: mockListActiveProjectConfigs,
  getRunsByProject: mockGetRunsByProject,
  deleteRun: mockDeleteRun,
  setTicketStatuses: mockSetTicketStatuses,
}));

vi.mock("../jira/client.js", () => ({
  getIssue: mockGetIssue,
  getIssuesByKeys: mockGetIssuesByKeys,
  searchIssuesInStatus: mockSearchIssuesInStatus,
  JiraApiError: MockJiraApiError,
}));

vi.mock("./spawner.js", () => ({
  spawnAgent: mockSpawnAgent,
}));

vi.mock("./ticket-sync.js", () => ({
  syncTicketInToDo: mockSyncTicketInToDo,
}));

import { processQueue, startSchedulerLoop } from "./scheduler.js";

describe("processQueue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockEnv.MAX_CONCURRENT_AGENTS = 4;
    mockClaimRunForSpawn.mockResolvedValue(true);
    mockReleaseSpawnClaim.mockResolvedValue(undefined);
    mockUpdateRunStatus.mockResolvedValue(makeDispatchRun());
    mockGetActiveRunCount.mockResolvedValue(0);
    mockGetRunsByStatus.mockResolvedValue([]);
    mockListActiveProjectConfigs.mockResolvedValue([]);
    mockGetRunsByProject.mockResolvedValue([]);
    mockDeleteRun.mockResolvedValue(undefined);
    mockGetIssue.mockResolvedValue(makeJiraIssue());
    mockGetIssuesByKeys.mockResolvedValue([]);
    mockSetTicketStatuses.mockResolvedValue(undefined);
    mockSearchIssuesInStatus.mockResolvedValue([]);
    mockSpawnAgent.mockResolvedValue(undefined);
    mockSyncTicketInToDo.mockResolvedValue({ action: "queued" });
  });

  it("returns 0 and does not spawn when at capacity", async () => {
    mockEnv.MAX_CONCURRENT_AGENTS = 2;
    mockGetActiveRunCount.mockResolvedValue(2);

    const spawned = await processQueue();

    expect(spawned).toBe(0);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("returns 0 when slots are available but no queued runs exist", async () => {
    mockEnv.MAX_CONCURRENT_AGENTS = 3;
    mockGetActiveRunCount.mockResolvedValue(1);
    mockGetRunsByStatus.mockResolvedValue([]);

    const spawned = await processQueue();

    expect(spawned).toBe(0);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("spawns only up to available slots", async () => {
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockEnv.MAX_CONCURRENT_AGENTS = 3;
    mockGetActiveRunCount.mockResolvedValue(1);
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([project]);
    mockGetRunsByStatus.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI" }),
      makeDispatchRun({ ticket_key: "HYDI-2", project_key: "HYDI" }),
      makeDispatchRun({ ticket_key: "HYDI-3", project_key: "HYDI" }),
      makeDispatchRun({ ticket_key: "HYDI-4", project_key: "HYDI" }),
      makeDispatchRun({ ticket_key: "HYDI-5", project_key: "HYDI" }),
    ]);

    const spawned = await processQueue();

    expect(spawned).toBe(2);
    expect(mockClaimRunForSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
    expect(mockSpawnAgent).toHaveBeenNthCalledWith(
      1,
      "HYDI-1",
      project,
      expect.any(Object)
    );
    expect(mockSpawnAgent).toHaveBeenNthCalledWith(
      2,
      "HYDI-2",
      project,
      expect.any(Object)
    );
  });

  it("logs a warning and skips queued runs with missing project config", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([project]);
    mockGetRunsByStatus.mockResolvedValue([
      makeDispatchRun({ ticket_key: "OPS-1", project_key: "OPS" }),
      makeDispatchRun({ ticket_key: "HYDI-2", project_key: "HYDI" }),
    ]);

    const spawned = await processQueue();

    expect(spawned).toBe(1);
    expect(mockReleaseSpawnClaim).toHaveBeenCalledWith("OPS-1");
    expect(warnSpy).toHaveBeenCalledWith(
      "[scheduler] Skipping OPS-1: project OPS is not configured."
    );
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      "HYDI-2",
      project,
      expect.any(Object)
    );
    warnSpy.mockRestore();
  });

  it("continues processing when releaseSpawnClaim fails on a pre-spawn rollback path", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([project]);
    mockGetRunsByStatus.mockResolvedValue([
      makeDispatchRun({ ticket_key: "OPS-1", project_key: "OPS" }),
      makeDispatchRun({ ticket_key: "HYDI-2", project_key: "HYDI" }),
    ]);
    mockReleaseSpawnClaim
      .mockRejectedValueOnce(new Error("release failed"))
      .mockResolvedValue(undefined);

    const spawned = await processQueue();

    expect(spawned).toBe(1);
    expect(mockUpdateRunStatus).toHaveBeenCalledWith("OPS-1", {
      status: "failed",
      error: "claim rollback failed (missing project config)",
    });
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      "HYDI-2",
      project,
      expect.any(Object)
    );
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("continues to later queued runs if spawnAgent throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([project]);
    mockGetRunsByStatus.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI" }),
      makeDispatchRun({ ticket_key: "HYDI-2", project_key: "HYDI" }),
    ]);
    mockSpawnAgent
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce(undefined);

    const spawned = await processQueue();

    expect(spawned).toBe(1);
    expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
    expect(mockReleaseSpawnClaim).not.toHaveBeenCalledWith("HYDI-1");
    expect(mockUpdateRunStatus).toHaveBeenCalledWith("HYDI-1", {
      status: "failed",
      error: "spawn failed",
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("marks a claimed run failed if spawnAgent fails after claim", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([project]);
    mockGetRunsByStatus.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI" }),
    ]);
    mockSpawnAgent.mockRejectedValueOnce(new Error("post-run failure"));

    const spawned = await processQueue();

    expect(spawned).toBe(0);
    expect(mockReleaseSpawnClaim).not.toHaveBeenCalledWith("HYDI-1");
    expect(mockUpdateRunStatus).toHaveBeenCalledWith("HYDI-1", {
      status: "failed",
      error: "post-run failure",
    });
    errorSpy.mockRestore();
  });

  it("falls back to release claim when post-spawn status update fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([project]);
    mockGetRunsByStatus.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI" }),
      makeDispatchRun({ ticket_key: "HYDI-2", project_key: "HYDI" }),
    ]);
    mockSpawnAgent
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce(undefined);
    mockUpdateRunStatus.mockRejectedValueOnce(new Error("status write failed"));

    const spawned = await processQueue();

    expect(spawned).toBe(1);
    expect(mockReleaseSpawnClaim).toHaveBeenCalledWith("HYDI-1");
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      "HYDI-2",
      project,
      expect.any(Object)
    );
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("skips runs that fail atomic claim and continues with next queued run", async () => {
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([project]);
    mockGetRunsByStatus.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI" }),
      makeDispatchRun({ ticket_key: "HYDI-2", project_key: "HYDI" }),
    ]);
    mockClaimRunForSpawn.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const spawned = await processQueue();

    expect(spawned).toBe(1);
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      "HYDI-2",
      project,
      expect.any(Object)
    );
  });

  it("skips a run when getIssue throws and continues processing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([project]);
    mockGetRunsByStatus.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI" }),
      makeDispatchRun({ ticket_key: "HYDI-2", project_key: "HYDI" }),
    ]);
    mockGetIssue
      .mockRejectedValueOnce(new Error("jira down"))
      .mockResolvedValueOnce(makeJiraIssue({ key: "HYDI-2" }));

    const spawned = await processQueue();

    expect(spawned).toBe(1);
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    expect(mockReleaseSpawnClaim).toHaveBeenCalledWith("HYDI-1");
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      "HYDI-2",
      project,
      expect.any(Object)
    );
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("reconciles missing To Do tickets by ingesting them", async () => {
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([project])
      .mockResolvedValueOnce([]);
    mockSearchIssuesInStatus.mockResolvedValue([makeJiraIssue({ key: "HYDI-200" })]);
    mockGetRunsByProject.mockResolvedValue([]);
    mockGetActiveRunCount.mockResolvedValue(4);

    await processQueue();

    expect(mockSyncTicketInToDo).toHaveBeenCalledWith("HYDI-200", "HYDI");
  });

  it("removes runs that the batched Jira lookup no longer returns", async () => {
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([project])
      .mockResolvedValueOnce([]);
    mockSearchIssuesInStatus.mockResolvedValue([]);
    mockGetRunsByProject.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-404", project_key: "HYDI" }),
    ]);
    // bulkfetch omits the deleted ticket from its issues list.
    mockGetIssuesByKeys.mockResolvedValue([]);
    mockGetActiveRunCount.mockResolvedValue(4);

    await processQueue();

    expect(mockGetIssuesByKeys).toHaveBeenCalledWith(["HYDI-404"], ["status"]);
    expect(mockDeleteRun).toHaveBeenCalledWith("HYDI-404");
  });

  it("deletes only the runs missing from the batched Jira lookup", async () => {
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([project])
      .mockResolvedValueOnce([]);
    mockSearchIssuesInStatus.mockResolvedValue([]);
    mockGetRunsByProject.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI" }),
      makeDispatchRun({ ticket_key: "HYDI-2", project_key: "HYDI" }),
      makeDispatchRun({ ticket_key: "HYDI-3", project_key: "HYDI" }),
    ]);
    // Only HYDI-1 and HYDI-3 still exist in Jira; HYDI-2 was deleted.
    mockGetIssuesByKeys.mockResolvedValue([
      makeJiraIssue({ key: "HYDI-1" }),
      makeJiraIssue({ key: "HYDI-3" }),
    ]);
    mockGetActiveRunCount.mockResolvedValue(4);

    await processQueue();

    expect(mockDeleteRun).toHaveBeenCalledTimes(1);
    expect(mockDeleteRun).toHaveBeenCalledWith("HYDI-2");
  });

  it("persists ticket status for every live issue in one batched call per reconcile cycle", async () => {
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([project])
      .mockResolvedValueOnce([]);
    mockSearchIssuesInStatus.mockResolvedValue([]);
    mockGetRunsByProject.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI" }),
      makeDispatchRun({ ticket_key: "HYDI-2", project_key: "HYDI" }),
    ]);
    // Default makeJiraIssue status is To Do / new.
    mockGetIssuesByKeys.mockResolvedValue([
      makeJiraIssue({ key: "HYDI-1" }),
      makeJiraIssue({ key: "HYDI-2" }),
    ]);
    mockGetActiveRunCount.mockResolvedValue(4);

    await processQueue();

    // Single batched call carrying every live issue, so reconcile cost is O(1)
    // DB round-trips in the number of live issues — not O(N) sequential awaits.
    expect(mockSetTicketStatuses).toHaveBeenCalledTimes(1);
    expect(mockSetTicketStatuses).toHaveBeenCalledWith([
      { ticketKey: "HYDI-1", statusName: "To Do", statusCategory: "new" },
      { ticketKey: "HYDI-2", statusName: "To Do", statusCategory: "new" },
    ]);
  });

  it("does not delete any runs when the batched existence check fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([project])
      .mockResolvedValueOnce([]);
    mockSearchIssuesInStatus.mockResolvedValue([]);
    mockGetRunsByProject.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI" }),
    ]);
    mockGetIssuesByKeys.mockRejectedValue(new Error("jira bulk fetch failed"));
    mockGetActiveRunCount.mockResolvedValue(4);

    await processQueue();

    expect(mockDeleteRun).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[scheduler] Could not verify Jira existence for project HYDI:",
      expect.any(Error)
    );
    warnSpy.mockRestore();
  });

  it("logs reconciliation project failures and keeps going", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([project])
      .mockResolvedValueOnce([]);
    mockSearchIssuesInStatus.mockRejectedValueOnce(new Error("jira search failed"));
    mockGetActiveRunCount.mockResolvedValue(4);

    await processQueue();

    expect(errorSpy).toHaveBeenCalledWith(
      "[scheduler] Polling reconciliation failed for project HYDI:",
      expect.any(Error)
    );
    errorSpy.mockRestore();
  });
});

describe("startSchedulerLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mockEnv.MAX_CONCURRENT_AGENTS = 4;
    mockClaimRunForSpawn.mockResolvedValue(true);
    mockReleaseSpawnClaim.mockResolvedValue(undefined);
    mockGetActiveRunCount.mockResolvedValue(0);
    mockGetRunsByStatus.mockResolvedValue([]);
    mockListActiveProjectConfigs.mockResolvedValue([]);
    mockGetRunsByProject.mockResolvedValue([]);
    mockGetIssue.mockResolvedValue(makeJiraIssue());
    mockGetIssuesByKeys.mockResolvedValue([]);
    mockSetTicketStatuses.mockResolvedValue(undefined);
    mockSearchIssuesInStatus.mockResolvedValue([]);
    mockSpawnAgent.mockResolvedValue(undefined);
    mockSyncTicketInToDo.mockResolvedValue({ action: "queued" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts and stops scheduler loop", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const stop = startSchedulerLoop();
    await vi.advanceTimersByTimeAsync(30_000);
    stop();

    expect(logSpy).toHaveBeenCalledWith("[scheduler] Loop stopped.");
    logSpy.mockRestore();
  });

  it("does not overlap cycles when processQueue is still running", async () => {
    let releaseFirstCycle: (() => void) | undefined;
    mockListActiveProjectConfigs.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirstCycle = () => resolve([]);
        })
    );

    const stop = startSchedulerLoop();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockListActiveProjectConfigs).toHaveBeenCalledTimes(1);

    releaseFirstCycle?.();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockListActiveProjectConfigs).toHaveBeenCalledTimes(4);
    stop();
  });

  it("logs unhandled loop errors from processQueue", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockListActiveProjectConfigs.mockRejectedValueOnce(new Error("db down"));

    const stop = startSchedulerLoop();
    await vi.advanceTimersByTimeAsync(30_000);
    stop();

    expect(errorSpy).toHaveBeenCalledWith(
      "[scheduler] Unhandled error in processQueue:",
      expect.any(Error)
    );
    errorSpy.mockRestore();
  });
});