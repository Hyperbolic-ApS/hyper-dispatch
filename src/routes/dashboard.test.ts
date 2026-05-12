import { describe, expect, it, vi } from "vitest";
import { makeDispatchRun } from "../test/fixtures.js";

const getAllDispatchRunsMock = vi.fn();
const getRunCountsByStatusMock = vi.fn();
const getIssueMock = vi.fn();
const annotateRunsWithProdDeploymentStatusMock = vi.fn();

vi.mock("../db/config-queries.js", () => ({
  getAllDispatchRuns: getAllDispatchRunsMock,
  getRunCountsByStatus: getRunCountsByStatusMock,
}));

vi.mock("../jira/client.js", () => ({
  getIssue: getIssueMock,
}));

vi.mock("../coolify/prod-deployment.js", () => ({
  annotateRunsWithProdDeploymentStatus: annotateRunsWithProdDeploymentStatusMock,
}));

describe("dashboardRouter", () => {
  it("includes an immediate refresh trigger when the tab becomes active", async () => {
    getAllDispatchRunsMock.mockResolvedValue([makeDispatchRun()]);
    annotateRunsWithProdDeploymentStatusMock.mockImplementation(async (runs) =>
      runs.map((run: ReturnType<typeof makeDispatchRun>) => ({
        ...run,
        deployed_to_prod: false,
      }))
    );
    getRunCountsByStatusMock.mockResolvedValue([{ status: "queued", count: "1" }]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "To Do", statusCategory: { key: "new" } } },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("document.addEventListener(\"visibilitychange\"");
    expect(html).toContain("previousVisibilityState !== \"visible\"");
    expect(html).toContain("window.location.reload();");
    expect(html).toContain("Prod Deployment (Coolify)");
    expect(html).toContain("Not deployed");
  });
});
