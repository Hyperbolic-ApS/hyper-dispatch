import { describe, expect, it, vi } from "vitest";
import { makeDispatchRun } from "../test/fixtures.js";

const getAllDispatchRunsMock = vi.fn();
const getRunCountsByStatusMock = vi.fn();
const getRunHistoryForTicketsMock = vi.fn();
const annotateRunsWithProdDeploymentStatusMock = vi.fn();

vi.mock("../db/config-queries.js", () => ({
  getAllDispatchRuns: getAllDispatchRunsMock,
  getRunCountsByStatus: getRunCountsByStatusMock,
  getRunHistoryForTickets: getRunHistoryForTicketsMock,
}));

vi.mock("../coolify/prod-deployment.js", () => ({
  annotateRunsWithProdDeploymentStatus: annotateRunsWithProdDeploymentStatusMock,
}));

describe("apiRouter", () => {
  it("returns runs and counts with coolify prod deployment status", async () => {
    getAllDispatchRunsMock.mockResolvedValue([makeDispatchRun()]);
    getRunCountsByStatusMock.mockResolvedValue([{ status: "running", count: "1" }]);
    getRunHistoryForTicketsMock.mockResolvedValue([]);
    annotateRunsWithProdDeploymentStatusMock.mockImplementation(async (runs) =>
      runs.map((run: ReturnType<typeof makeDispatchRun>) => ({
        ...run,
        deployed_to_prod: true,
      }))
    );

    const { apiRouter } = await import("./api.js");
    const res = await apiRouter.request("http://localhost/status");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.counts.running).toBe(1);
    expect(body.runs[0]?.deployed_to_prod).toBe(true);
  });
});
