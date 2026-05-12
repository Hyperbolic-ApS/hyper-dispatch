import { describe, expect, it, vi } from "vitest";
import { makeDispatchRun, makeJiraIssue } from "../test/fixtures.js";

const getAllDispatchRunsMock = vi.fn();
const getRunCountsByStatusMock = vi.fn();
const getIssueMock = vi.fn();

vi.mock("../db/config-queries.js", () => ({
  getAllDispatchRuns: getAllDispatchRunsMock,
  getRunCountsByStatus: getRunCountsByStatusMock,
}));

vi.mock("../jira/client.js", () => ({
  getIssue: getIssueMock,
}));

describe("dashboardRouter", () => {
  it("injects an immediate refresh when the tab becomes visible", async () => {
    getAllDispatchRunsMock.mockResolvedValue([makeDispatchRun({ ticket_key: "HYDI-38" })]);
    getRunCountsByStatusMock.mockResolvedValue([{ status: "running", count: "1" }]);
    getIssueMock.mockResolvedValue(makeJiraIssue({ key: "HYDI-38" }));

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('document.addEventListener("visibilitychange"');
    expect(html).toContain('document.visibilityState === "visible"');
    expect(html).toContain("window.location.reload()");
  });
});
