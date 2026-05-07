import { describe, expect, it, vi } from "vitest";
import {
  makeDispatchRun,
  makeJiraIssue,
  makeProjectConfig,
} from "../test/fixtures.js";
const {
  getActiveRunCountMock,
  getRunsByProjectMock,
  getRunsByStatusMock,
  listActiveProjectConfigsMock,
  deleteRunMock,
  searchIssuesInStatusMock,
  getIssueMock,
  syncTicketInToDoMock,
  spawnAgentMock,
} = vi.hoisted(() => ({
  getActiveRunCountMock: vi.fn(),
  getRunsByProjectMock: vi.fn(),
  getRunsByStatusMock: vi.fn(),
  listActiveProjectConfigsMock: vi.fn(),
  deleteRunMock: vi.fn(),
  searchIssuesInStatusMock: vi.fn(),
  getIssueMock: vi.fn(),
  syncTicketInToDoMock: vi.fn(),
  spawnAgentMock: vi.fn(),
}));

vi.mock("../db/queries.js", () => ({
  getActiveRunCount: getActiveRunCountMock,
  getRunsByProject: getRunsByProjectMock,
  getRunsByStatus: getRunsByStatusMock,
  listActiveProjectConfigs: listActiveProjectConfigsMock,
  deleteRun: deleteRunMock,
}));

vi.mock("../jira/client.js", async () => {
  return {
    JiraApiError: class JiraApiError extends Error {
      constructor(
        public readonly status: number,
        public readonly body: string,
        message: string
      ) {
        super(message);
      }
    },
    searchIssuesInStatus: searchIssuesInStatusMock,
    getIssue: getIssueMock,
  };
});

vi.mock("./ticket-sync.js", () => ({
  syncTicketInToDo: syncTicketInToDoMock,
}));

vi.mock("./spawner.js", () => ({
  spawnAgent: spawnAgentMock,
}));

describe("processQueue", () => {
  it("returns zero when already at capacity", async () => {
    getActiveRunCountMock.mockResolvedValue(4);
    listActiveProjectConfigsMock.mockResolvedValue([]);
    const { processQueue } = await import("./scheduler.js");

    const spawned = await processQueue();
    expect(spawned).toBe(0);
    expect(getRunsByStatusMock).not.toHaveBeenCalled();
  });

  it("spawns queued runs up to available slots and active project configs", async () => {
    const config = makeProjectConfig();
    listActiveProjectConfigsMock.mockResolvedValue([config]);
    searchIssuesInStatusMock.mockResolvedValue([]);
    getRunsByProjectMock.mockResolvedValue([]);
    getActiveRunCountMock.mockResolvedValue(1);
    getRunsByStatusMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-10", project_key: "HYDI" }),
      makeDispatchRun({ ticket_key: "OTHER-11", project_key: "OTHER" }),
      makeDispatchRun({ ticket_key: "HYDI-12", project_key: "HYDI" }),
    ]);
    getIssueMock.mockResolvedValue(makeJiraIssue());

    const { processQueue } = await import("./scheduler.js");
    const spawned = await processQueue();

    expect(spawned).toBe(2);
    expect(spawnAgentMock).toHaveBeenCalledTimes(2);
    expect(spawnAgentMock).toHaveBeenNthCalledWith(
      1,
      "HYDI-10",
      config,
      expect.any(Object)
    );
    expect(spawnAgentMock).toHaveBeenNthCalledWith(
      2,
      "HYDI-12",
      config,
      expect.any(Object)
    );
  });

  it("deletes stale dispatch rows when Jira returns 404 during reconciliation", async () => {
    const config = makeProjectConfig();
    const { JiraApiError } = await import("../jira/client.js");
    listActiveProjectConfigsMock.mockResolvedValue([config]);
    searchIssuesInStatusMock.mockResolvedValue([]);
    getRunsByProjectMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-404", project_key: "HYDI" }),
    ]);
    getIssueMock.mockRejectedValue(
      new JiraApiError(404, "Not Found", "Issue missing")
    );
    getActiveRunCountMock.mockResolvedValue(0);
    getRunsByStatusMock.mockResolvedValue([]);

    const { processQueue } = await import("./scheduler.js");
    await processQueue();

    expect(deleteRunMock).toHaveBeenCalledWith("HYDI-404");
  });

  it("syncs missing To Do issues discovered from polling", async () => {
    const config = makeProjectConfig();
    listActiveProjectConfigsMock.mockResolvedValue([config]);
    searchIssuesInStatusMock.mockResolvedValue([
      makeJiraIssue({ key: "HYDI-77" }),
    ]);
    getRunsByProjectMock.mockResolvedValue([]);
    getActiveRunCountMock.mockResolvedValue(0);
    getRunsByStatusMock.mockResolvedValue([]);
    syncTicketInToDoMock.mockResolvedValue({ action: "queued", ticketKey: "HYDI-77" });

    const { processQueue } = await import("./scheduler.js");
    await processQueue();

    expect(syncTicketInToDoMock).toHaveBeenCalledWith("HYDI-77", "HYDI");
  });
});
