import { Hono } from "hono";
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

  it("escapes the signed-in user's email in the header", async () => {
    getAllDispatchRunsMock.mockResolvedValue([makeDispatchRun()]);
    getRunCountsByStatusMock.mockResolvedValue([{ status: "queued", count: "1" }]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "To Do", statusCategory: { key: "new" } } },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const app = new Hono();
    app.use("*", async (c, next) => {
      (c as any).set("authUser", {
        id: "user-1",
        email: '<img src=x onerror=alert(1)>',
        role: "member",
      });
      await next();
    });
    app.route("/", dashboardRouter);

    const res = await app.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; (member)");
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});
