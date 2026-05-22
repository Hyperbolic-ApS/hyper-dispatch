import { describe, expect, it, vi } from "vitest";
import { makeDispatchRun } from "../test/fixtures.js";

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
  it("includes an immediate refresh trigger when the tab becomes active", async () => {
    getAllDispatchRunsMock.mockResolvedValue([makeDispatchRun()]);
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
  });

  it("renders a project dropdown and filters rows by selected project", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-31", project_key: "HYDI" }),
      makeDispatchRun({ ticket_key: "TEST-10", project_key: "TEST" }),
    ]);
    getRunCountsByStatusMock.mockResolvedValue([{ status: "queued", count: "2" }]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "To Do", statusCategory: { key: "new" } } },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/?project=HYDI");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<label class=\"filter-label\" for=\"project-filter\">Project</label>");
    expect(html).toContain("<option value=\"\">All Projects</option>");
    expect(html).toContain("<option value=\"HYDI\" selected>HYDI</option>");
    expect(html).toContain("<option value=\"TEST\">TEST</option>");
    expect(html).toContain(">HYDI-31</a>");
    expect(html).not.toContain(">TEST-10</a>");
  });
});
