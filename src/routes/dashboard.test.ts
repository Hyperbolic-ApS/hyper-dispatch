import { describe, expect, it, vi } from "vitest";
import { makeDispatchRun } from "../test/fixtures.js";

const getAllDispatchRunsMock = vi.fn();
const getRunCountsByStatusMock = vi.fn();
const getIssueMock = vi.fn();
const listWorkflowRunsForRepoMock = vi.fn();

vi.mock("../db/config-queries.js", () => ({
  getAllDispatchRuns: getAllDispatchRunsMock,
  getRunCountsByStatus: getRunCountsByStatusMock,
}));

vi.mock("../jira/client.js", () => ({
  getIssue: getIssueMock,
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    actions = {
      listWorkflowRunsForRepo: listWorkflowRunsForRepoMock,
    };
  },
}));

describe("dashboardRouter", () => {
  it("renders PR Status and preserves merge conflict fallback when no action is running", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/42",
        pr_has_conflicts: true,
      }),
    ]);
    getRunCountsByStatusMock.mockResolvedValue([{ status: "succeeded", count: "1" }]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Review", statusCategory: { key: "in-flight" } } },
    });
    listWorkflowRunsForRepoMock.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            name: "Oz PR Review Commenting",
            status: "completed",
            pull_requests: [{ number: 42 }],
          },
        ],
      },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<th>PR Status</th>");
    expect(html).toContain("Merge conflicts");
  });

  it("shows review running PR status when the review workflow is in progress", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/43",
        pr_has_conflicts: false,
      }),
    ]);
    getRunCountsByStatusMock.mockResolvedValue([{ status: "succeeded", count: "1" }]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Review", statusCategory: { key: "in-flight" } } },
    });
    listWorkflowRunsForRepoMock.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            name: "Oz PR Review Commenting",
            status: "in_progress",
            pull_requests: [{ number: 43 }],
          },
        ],
      },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Review running");
    expect(html).not.toContain("No conflicts");
  });

  it("shows revision running PR status when the revision workflow is in progress", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/44",
        pr_has_conflicts: false,
      }),
    ]);
    getRunCountsByStatusMock.mockResolvedValue([{ status: "succeeded", count: "1" }]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Review", statusCategory: { key: "in-flight" } } },
    });
    listWorkflowRunsForRepoMock.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            name: "Agent Revision on Review Feedback",
            status: "queued",
            pull_requests: [{ number: 44 }],
          },
        ],
      },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Revision running");
    expect(html).not.toContain("No conflicts");
  });
  it("includes an immediate refresh trigger when the tab becomes active", async () => {
    getAllDispatchRunsMock.mockResolvedValue([makeDispatchRun()]);
    getRunCountsByStatusMock.mockResolvedValue([{ status: "queued", count: "1" }]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "To Do", statusCategory: { key: "new" } } },
    });
    listWorkflowRunsForRepoMock.mockResolvedValue({
      data: { workflow_runs: [] },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("document.addEventListener(\"visibilitychange\"");
    expect(html).toContain("previousVisibilityState !== \"visible\"");
    expect(html).toContain("window.location.reload();");
  });
});
