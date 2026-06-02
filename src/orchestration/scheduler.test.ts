import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDispatchRun,
  makeJiraIssue,
  makeProjectConfig,
} from "../test/fixtures.js";

const {
  mockEnv,
  mockGetActiveRunCount,
  mockGetRunsByStatus,
  mockListActiveProjectConfigs,
  mockGetRunsByProject,
  mockDeleteRun,
  mockClaimRunForSpawn,
  mockUpdateRunStatus,
  mockGetIssue,
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
    mockEnv: { MAX_CONCURRENT_AGENTS: 4 },
    mockGetActiveRunCount: vi.fn(),
    mockGetRunsByStatus: vi.fn(),
    mockListActiveProjectConfigs: vi.fn(),
    mockGetRunsByProject: vi.fn(),
    mockDeleteRun: vi.fn(),
    mockClaimRunForSpawn: vi.fn(),
    mockUpdateRunStatus: vi.fn(),
    mockGetIssue: vi.fn(),
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
  getActiveRunCount: mockGetActiveRunCount,
  getRunsByStatus: mockGetRunsByStatus,
  listActiveProjectConfigs: mockListActiveProjectConfigs,
  getRunsByProject: mockGetRunsByProject,
  deleteRun: mockDeleteRun,
  claimRunForSpawn: mockClaimRunForSpawn,
  updateRunStatus: mockUpdateRunStatus,
}));

vi.mock("../jira/client.js", () => ({
  getIssue: mockGetIssue,
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
    mockGetActiveRunCount.mockResolvedValue(0);
    mockGetRunsByStatus.mockResolvedValue([]);
    mockListActiveProjectConfigs.mockResolvedValue([]);
    mockGetRunsByProject.mockResolvedValue([]);
    mockDeleteRun.mockResolvedValue(undefined);
    mockClaimRunForSpawn.mockResolvedValue(true);
    mockUpdateRunStatus.mockResolvedValue(null);
    mockGetIssue.mockResolvedValue(makeJiraIssue());
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

  it("skips runs already claimed by another scheduler cycle", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([project]);
    mockGetRunsByStatus.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI" }),
    ]);
    mockClaimRunForSpawn.mockResolvedValueOnce(false);

    const spawned = await processQueue();

    expect(spawned).toBe(0);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "[scheduler] Skipping HYDI-1: run already claimed by another cycle."
    );
    logSpy.mockRestore();
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
    expect(errorSpy).toHaveBeenCalled();
    expect(mockUpdateRunStatus).toHaveBeenCalledWith("HYDI-1", {
      status: "queued",
    });
    errorSpy.mockRestore();
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
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      "HYDI-2",
      project,
      expect.any(Object)
    );
    expect(errorSpy).toHaveBeenCalled();
    expect(mockUpdateRunStatus).toHaveBeenCalledWith("HYDI-1", {
      status: "queued",
    });
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

  it("removes runs when Jira returns 404 during reconciliation", async () => {
    const jira = await import("../jira/client.js");
    const project = makeProjectConfig({ project_key: "HYDI" });
    mockListActiveProjectConfigs
      .mockResolvedValueOnce([project])
      .mockResolvedValueOnce([]);
    mockSearchIssuesInStatus.mockResolvedValue([]);
    mockGetRunsByProject.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-404", project_key: "HYDI" }),
    ]);
    mockGetIssue.mockRejectedValueOnce(
      new jira.JiraApiError(404, "not found", "not found")
    );
    mockGetActiveRunCount.mockResolvedValue(4);

    await processQueue();

    expect(mockDeleteRun).toHaveBeenCalledWith("HYDI-404");
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
    mockGetActiveRunCount.mockResolvedValue(0);
    mockGetRunsByStatus.mockResolvedValue([]);
    mockListActiveProjectConfigs.mockResolvedValue([]);
    mockGetRunsByProject.mockResolvedValue([]);
    mockClaimRunForSpawn.mockResolvedValue(true);
    mockUpdateRunStatus.mockResolvedValue(null);
    mockGetIssue.mockResolvedValue(makeJiraIssue());
    mockSearchIssuesInStatus.mockResolvedValue([]);
    mockSpawnAgent.mockResolvedValue(undefined);
    mockSyncTicketInToDo.mockResolvedValue({ action: "queued" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts and stops scheduler interval", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const stop = startSchedulerLoop();
    await vi.advanceTimersByTimeAsync(30_000);
    stop();

    expect(logSpy).toHaveBeenCalledWith("[scheduler] Loop stopped.");
    logSpy.mockRestore();
  });

  it("logs unhandled interval errors from processQueue", async () => {
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

  it("does not start a new cycle until the previous cycle completes", async () => {
    let release: (() => void) | undefined;
    const pendingCycle = new Promise<number>((resolve) => {
      release = () => resolve(0);
    });
    mockGetActiveRunCount.mockReturnValueOnce(pendingCycle);

    const stop = startSchedulerLoop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockGetActiveRunCount).toHaveBeenCalledTimes(1);

    release?.();
    await Promise.resolve();
    stop();
  });
});