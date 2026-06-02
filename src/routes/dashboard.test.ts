import { describe, expect, it, vi } from "vitest";
import { makeDispatchRun } from "../test/fixtures.js";

const getAllDispatchRunsMock = vi.fn();
const getIssueMock = vi.fn();

vi.mock("../db/config-queries.js", () => ({
  getAllDispatchRuns: getAllDispatchRunsMock,
}));

vi.mock("../jira/client.js", () => ({
  getIssue: getIssueMock,
}));

describe("dashboardRouter", () => {
  it("includes an immediate refresh trigger when the tab becomes active", async () => {
    getAllDispatchRunsMock.mockResolvedValue([makeDispatchRun()]);
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
    expect(html).toContain("⚙ Configure</a>");
  });

  it("renders a project dropdown and filters rows by selected project", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-31", project_key: "HYDI" }),
      makeDispatchRun({ ticket_key: "TEST-10", project_key: "TEST" }),
    ]);
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

  it("stat cards reflect the active project and hideDone filters", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI", status: "running" }),
      makeDispatchRun({ ticket_key: "HYDI-2", project_key: "HYDI", status: "succeeded" }),
      makeDispatchRun({ ticket_key: "TEST-1", project_key: "TEST", status: "queued" }),
      makeDispatchRun({ ticket_key: "TEST-2", project_key: "TEST", status: "failed" }),
    ]);
    getIssueMock.mockImplementation(async (key: string) => {
      if (key === "HYDI-2") {
        return { fields: { status: { name: "Done", statusCategory: { key: "done" } } } };
      }
      return { fields: { status: { name: "In Progress", statusCategory: { key: "in-flight" } } } };
    });

    const { dashboardRouter } = await import("./dashboard.js");

    // With project=HYDI, only HYDI runs count: 1 running + 1 succeeded
    const res1 = await dashboardRouter.request("http://localhost/?project=HYDI");
    const html1 = await res1.text();
    expect(html1).toContain("1 Running");
    expect(html1).toContain("1 Succeeded");
    expect(html1).toContain("0 Queued");
    expect(html1).toContain("0 Failed");

    // With project=HYDI&hideDone=1, the succeeded/done ticket is excluded
    const res2 = await dashboardRouter.request("http://localhost/?project=HYDI&hideDone=1");
    const html2 = await res2.text();
    expect(html2).toContain("1 Running");
    expect(html2).toContain("0 Succeeded");
  });

  it("filters rows by selected status and marks the selected stat card", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI", status: "running" }),
      makeDispatchRun({ ticket_key: "HYDI-2", project_key: "HYDI", status: "failed" }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Progress", statusCategory: { key: "in-flight" } } },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/?project=HYDI&status=running");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(">HYDI-1</a>");
    expect(html).not.toContain(">HYDI-2</a>");
    expect(html).toContain(
      '<a href="/dashboard?project=HYDI" class="stat stat-link stat-selected" style="background:#3b82f6;color:#fff" role="button" aria-pressed="true">1 Running</a>'
    );
  });

  it("deselecting a selected status tag clears the filter and shows all project rows", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI", status: "running" }),
      makeDispatchRun({ ticket_key: "HYDI-2", project_key: "HYDI", status: "failed" }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Progress", statusCategory: { key: "in-flight" } } },
    });

    const { dashboardRouter } = await import("./dashboard.js");

    // Step 1: Request with status=running — only HYDI-1 should be visible
    const res1 = await dashboardRouter.request("http://localhost/?project=HYDI&status=running");
    const html1 = await res1.text();
    expect(html1).toContain(">HYDI-1</a>");
    expect(html1).not.toContain(">HYDI-2</a>");

    // The selected stat card's href should drop the status param (deselect target)
    const selectedMatch = html1.match(/<a href="([^"]+)"[^>]*class="stat stat-link stat-selected"/);
    expect(selectedMatch).not.toBeNull();
    const deselectHref = selectedMatch![1];
    expect(deselectHref).not.toContain("status=");

    // Step 2: Follow the deselect link — both project-filtered rows should reappear
    // The href targets /dashboard (app mount point), but the router handles / directly in tests
    const deselectUrl = deselectHref.replace(/^\/dashboard/, "");
    const res2 = await dashboardRouter.request(`http://localhost/${deselectUrl}`);
    const html2 = await res2.text();
    expect(res2.status).toBe(200);
    expect(html2).toContain(">HYDI-1</a>");
    expect(html2).toContain(">HYDI-2</a>");
  });

  it("shows a status-specific empty message when selected status has no rows after project filtering", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI", status: "running" }),
      makeDispatchRun({ ticket_key: "TEST-1", project_key: "TEST", status: "queued" }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Progress", statusCategory: { key: "in-flight" } } },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/?project=HYDI&status=queued");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("no queued tasks available");
    expect(html).not.toContain(">HYDI-1</a>");
    expect(html).not.toContain(">TEST-1</a>");
  });
});
