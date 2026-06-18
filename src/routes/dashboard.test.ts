import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatchRun } from "../test/fixtures.js";

const getAllDispatchRunsMock = vi.fn();
const getDispatchRunsPageMock = vi.fn();
const countDispatchRunsMock = vi.fn();
const getStatusCountsMock = vi.fn();
const getDistinctRunProjectKeysMock = vi.fn();
const listProjectConfigsMock = vi.fn();
const deleteRunMock = vi.fn();
const annotateRunsWithProdDeploymentStatusMock = vi.fn();
const parseGithubPullRequestUrlMock = vi.fn();
const getPullRequestStateMock = vi.fn();
const listWorkflowRunsForRepoMock = vi.fn();
const octokitAuthTokens: string[] = [];
const workflowRunListRequests: Array<Record<string, unknown>> = [];

vi.mock("../db/config-queries.js", () => ({
  getAllDispatchRuns: getAllDispatchRunsMock,
  getDispatchRunsPage: getDispatchRunsPageMock,
  countDispatchRuns: countDispatchRunsMock,
  getStatusCounts: getStatusCountsMock,
  getDistinctRunProjectKeys: getDistinctRunProjectKeysMock,
  listProjectConfigs: listProjectConfigsMock,
  DEFAULT_DASHBOARD_PAGE_SIZE: 50,
}));
vi.mock("../db/queries.js", () => ({
  deleteRun: deleteRunMock,
}));
vi.mock("../github/pull-requests.js", () => ({
  parseGithubPullRequestUrl: parseGithubPullRequestUrlMock,
  getPullRequestState: getPullRequestStateMock,
}));
vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    constructor(config?: { auth?: string }) {
      octokitAuthTokens.push(config?.auth ?? "");
    }
    actions = {
      listWorkflowRunsForRepo: (params: Record<string, unknown>) => {
        workflowRunListRequests.push(params);
        return listWorkflowRunsForRepoMock(params);
      },
    };
  },
}));
vi.mock("../coolify/prod-deployment.js", () => ({
  annotateRunsWithProdDeploymentStatus: annotateRunsWithProdDeploymentStatusMock,
}));

describe("dashboardRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    octokitAuthTokens.length = 0;
    workflowRunListRequests.length = 0;
    getDispatchRunsPageMock.mockResolvedValue([]);
    countDispatchRunsMock.mockResolvedValue(0);
    getStatusCountsMock.mockResolvedValue([]);
    getDistinctRunProjectKeysMock.mockResolvedValue([]);
    listProjectConfigsMock.mockResolvedValue([]);
    getAllDispatchRunsMock.mockResolvedValue([]);
    listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [] } });
    annotateRunsWithProdDeploymentStatusMock.mockImplementation(async (runs: unknown[]) =>
      runs.map((run) => ({ ...(run as object), deployed_to_prod: null }))
    );
    parseGithubPullRequestUrlMock.mockImplementation((prUrl: string) => {
      const match = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
      if (!match) return null;
      return { owner: match[1], repo: match[2], pullNumber: Number.parseInt(match[3], 10) };
    });
  });

  // ─── Rendering from persisted DB state ─────────────────────────────────────

  it("renders rows from getDispatchRunsPage with ticket status read from persisted columns", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-1",
        status: "running",
        ticket_status_name: "In Progress",
        ticket_status_category: "in-flight",
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(">HYDI-1</a>");
    // Ticket-status badge text comes straight from the persisted column.
    expect(html).toContain(">In Progress</span>");
    expect(html).toContain("Agent Status");
  });

  it("does not run prod-deployment enrichment while its column is hidden", async () => {
    getDispatchRunsPageMock.mockResolvedValue([makeDispatchRun()]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(annotateRunsWithProdDeploymentStatusMock).not.toHaveBeenCalled();
    expect(html).not.toContain("Prod Deployment (Coolify)");
    expect(html).not.toContain("Not deployed");
  });

  it("renders Spawned At using dd/MM/YY HH:MM format", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({ spawned_at: new Date("2026-06-10T12:34:00.000Z") }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toMatch(/\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}/);
  });

  it("renders an error token in Agent Status when a run has error text", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-83",
        status: "failed",
        error: "Spawn failed: <bad-response>",
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("data-error-token-button");
    expect(html).toContain("Show error for HYDI-83");
    expect(html).toContain("Spawn failed: &lt;bad-response&gt;");
    expect(html).not.toContain("Spawn failed: <bad-response>");
  });

  it("does not render an error token when error text is absent", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-84",
        status: "failed",
        error: null,
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).not.toContain("Show error for HYDI-84");
  });

  // ─── Filter + pagination delegation to SQL ─────────────────────────────────

  it("passes project/status/hideDone filters and pagination offset to getDispatchRunsPage", async () => {
    const { dashboardRouter } = await import("./dashboard.js");
    await dashboardRouter.request(
      "http://localhost/?project=HYDI&status=running&hideDone=1&page=2"
    );

    expect(getDispatchRunsPageMock).toHaveBeenCalledWith(
      { projectKey: "HYDI", statuses: ["running"], hideDone: true },
      50,
      50
    );
  });

  it("maps the blocked status tag to both blocked and blocked_cycle statuses", async () => {
    const { dashboardRouter } = await import("./dashboard.js");
    await dashboardRouter.request("http://localhost/?status=blocked");

    expect(getDispatchRunsPageMock).toHaveBeenCalledWith(
      { projectKey: null, statuses: ["blocked", "blocked_cycle"], hideDone: false },
      50,
      0
    );
  });

  // ─── Stat bar (from getStatusCounts) ───────────────────────────────────────

  it("renders stat counts from getStatusCounts and sums blocked + blocked_cycle", async () => {
    getStatusCountsMock.mockResolvedValue([
      { status: "running", count: "3" },
      { status: "blocked", count: "1" },
      { status: "blocked_cycle", count: "2" },
      { status: "succeeded", count: "4" },
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain("3 Running");
    expect(html).toContain("3 Blocked");
    expect(html).toContain("4 Succeeded");
    expect(getStatusCountsMock).toHaveBeenCalledWith({ projectKey: null, hideDone: false });
  });

  it("marks the selected status stat card", async () => {
    getStatusCountsMock.mockResolvedValue([{ status: "running", count: "1" }]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/?status=running");
    const html = await res.text();

    expect(html).toContain('aria-pressed="true">1 Running</a>');
  });

  // ─── Pagination controls ───────────────────────────────────────────────────

  it("renders pagination controls when the total exceeds one page", async () => {
    getDispatchRunsPageMock.mockResolvedValue([makeDispatchRun({ ticket_key: "HYDI-1" })]);
    countDispatchRunsMock.mockResolvedValue(120);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain("Page 1 of 3 (120 total)");
    // On page 1, Prev is disabled and Next links to page 2.
    expect(html).toContain('<span class="disabled">← Prev</span>');
    expect(html).toContain('href="/dashboard?page=2">Next →</a>');
  });

  it("does not render pagination controls when everything fits on one page", async () => {
    getDispatchRunsPageMock.mockResolvedValue([makeDispatchRun({ ticket_key: "HYDI-1" })]);
    countDispatchRunsMock.mockResolvedValue(1);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).not.toContain("Page 1 of");
    expect(html).not.toContain('class="pagination"');
  });

  it("preserves filters in pagination links and enables Prev beyond page 1", async () => {
    getDispatchRunsPageMock.mockResolvedValue([makeDispatchRun({ ticket_key: "HYDI-1" })]);
    countDispatchRunsMock.mockResolvedValue(120);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/?project=HYDI&page=2");
    const html = await res.text();

    expect(html).toContain("Page 2 of 3 (120 total)");
    expect(html).toContain('href="/dashboard?project=HYDI">← Prev</a>');
    // Ampersand is escaped to &amp; so the href is well-formed HTML.
    expect(html).toContain('href="/dashboard?project=HYDI&amp;page=3">Next →</a>');
  });

  // ─── Project dropdown (from getDistinctRunProjectKeys) ─────────────────────

  it("renders a project dropdown from getDistinctRunProjectKeys and marks the selected project", async () => {
    getDistinctRunProjectKeysMock.mockResolvedValue(["HYDI", "TEST"]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/?project=HYDI");
    const html = await res.text();

    expect(html).toContain('<option value="">All Projects</option>');
    expect(html).toContain('<option value="HYDI" selected>HYDI</option>');
    expect(html).toContain('<option value="TEST">TEST</option>');
  });

  // ─── Empty states ──────────────────────────────────────────────────────────

  it("shows the generic empty message when there are no runs and no status filter", async () => {
    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain("No runs found for the current filter");
  });

  it("shows a status-specific empty message when the selected status has no rows", async () => {
    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/?status=queued");
    const html = await res.text();

    expect(html).toContain("no queued tasks available");
  });

  // ─── PR status badges (cached workflow-run enrichment) ─────────────────────

  it("renders PR Status and preserves merge conflict fallback when no action is running", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/42",
        pr_has_conflicts: true,
      }),
    ]);
    listWorkflowRunsForRepoMock.mockResolvedValue({
      data: {
        workflow_runs: [
          { name: "Oz PR Review Commenting", status: "completed", pull_requests: [{ number: 42 }] },
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
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/43",
        pr_has_conflicts: false,
      }),
    ]);
    listWorkflowRunsForRepoMock.mockResolvedValue({
      data: {
        workflow_runs: [
          { name: "Oz PR Review Commenting", status: "in_progress", pull_requests: [{ number: 43 }] },
        ],
      },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain("Review running");
    expect(html).not.toContain("No conflicts");
  });

  it("shows revision running PR status when the revision workflow is in progress", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/44",
        pr_has_conflicts: false,
      }),
    ]);
    listWorkflowRunsForRepoMock.mockResolvedValue({
      data: {
        workflow_runs: [
          { name: "Agent Revision on Review Feedback", status: "queued", pull_requests: [{ number: 44 }] },
        ],
      },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain("Revision running");
  });

  it("issues one workflow-run fetch per repo, not per PR", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-60", status: "succeeded", pr_url: "https://github.com/warp/hyper-dispatch/pull/60" }),
      makeDispatchRun({ ticket_key: "HYDI-61", status: "succeeded", pr_url: "https://github.com/warp/hyper-dispatch/pull/61" }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    await dashboardRouter.request("http://localhost/");

    expect(workflowRunListRequests).toHaveLength(1);
    expect(workflowRunListRequests[0]).toEqual({
      owner: "warp",
      repo: "hyper-dispatch",
      per_page: 100,
      page: 1,
    });
    // No `event` filter — adding one would silently hide non-PR-triggered runs.
    expect(workflowRunListRequests[0]).not.toHaveProperty("event");
  });

  it("detects review running via head_branch when pull_requests is empty", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-76",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/76",
        pr_has_conflicts: false,
      }),
    ]);
    listWorkflowRunsForRepoMock.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            name: "Oz PR Review Commenting",
            status: "in_progress",
            pull_requests: [],
            head_branch: "agent/HYDI-76",
          },
        ],
      },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain("Review running");
  });

  it("detects revision running via head_branch when pull_requests is empty", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-77",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/77",
        pr_has_conflicts: false,
      }),
    ]);
    listWorkflowRunsForRepoMock.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            name: "Agent Revision on Review Feedback",
            status: "in_progress",
            pull_requests: [],
            head_branch: "agent/HYDI-77",
          },
        ],
      },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain("Revision running");
  });

  it("separates workflow-run fetches by token when two projects share the same repo", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-80", project_key: "HYDI", status: "succeeded", pr_url: "https://github.com/warp/hyper-dispatch/pull/80" }),
      makeDispatchRun({ ticket_key: "TEST-81", project_key: "TEST", status: "succeeded", pr_url: "https://github.com/warp/hyper-dispatch/pull/81" }),
    ]);
    listProjectConfigsMock.mockResolvedValue([
      { project_key: "HYDI", github_pat: "token-hydi", active: true },
      { project_key: "TEST", github_pat: "token-test", active: true },
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");

    expect(res.status).toBe(200);
    expect(octokitAuthTokens).toEqual(expect.arrayContaining(["token-hydi", "token-test"]));
    expect(workflowRunListRequests).toHaveLength(2);
  });

  it("follows workflow-run pagination and finds in-flight runs on later pages", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-90", status: "succeeded", pr_url: "https://github.com/warp/hyper-dispatch/pull/90", pr_has_conflicts: false }),
    ]);
    const firstPageRuns = Array.from({ length: 100 }, (_, i) => ({
      name: "Oz PR Review Commenting",
      status: "completed",
      pull_requests: [{ number: i + 1000 }],
      head_branch: `agent/OTHER-${i}`,
    }));
    listWorkflowRunsForRepoMock
      .mockResolvedValueOnce({ data: { workflow_runs: firstPageRuns } })
      .mockResolvedValueOnce({
        data: {
          workflow_runs: [
            { name: "Oz PR Review Commenting", status: "in_progress", pull_requests: [], head_branch: "agent/HYDI-90" },
          ],
        },
      });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain("Review running");
    expect(workflowRunListRequests[0]).toMatchObject({ page: 1, per_page: 100 });
    expect(workflowRunListRequests[1]).toMatchObject({ page: 2, per_page: 100 });
  });

  // ─── PR link suffixes (from persisted pr_display_state) ────────────────────

  it("renders PR link with merged suffix when pull request is merged", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-54",
        status: "succeeded",
        pr_url: "https://github.com/org/repo/pull/54",
        pr_display_state: "merged",
      }),
    ]);
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 54 });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain('<a href="https://github.com/org/repo/pull/54" target="_blank">PR #54 (Merged)</a>');
  });

  it("renders PR link with closed suffix when pull request is closed and unmerged", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-55",
        status: "succeeded",
        pr_url: "https://github.com/org/repo/pull/55",
        pr_display_state: "closed",
      }),
    ]);
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 55 });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain('<a href="https://github.com/org/repo/pull/55" target="_blank">PR #55 (Closed)</a>');
  });

  // ─── Row actions / Force delete affordance ─────────────────────────────────

  it("renders a compact row actions menu with delete option", async () => {
    getDispatchRunsPageMock.mockResolvedValue([makeDispatchRun()]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain("data-row-menu-button");
    expect(html).toContain(">⋮</button>");
    expect(html).toContain(">Delete</button>");
  });

  it("shows Force delete only for the row whose delete previously failed", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", status: "succeeded" }),
      makeDispatchRun({ ticket_key: "HYDI-2", status: "succeeded" }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/?deleteFailed=HYDI-1");
    const html = await res.text();

    expect(html).toContain("Force delete HYDI-1?");
    expect(html).not.toContain("Force delete HYDI-2?");
  });

  // ─── Escaping ──────────────────────────────────────────────────────────────

  it("escapes notice content from query string", async () => {
    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request(
      "http://localhost/?noticeType=error&notice=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E"
    );
    const html = await res.text();

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("data-notice-dismiss");
    expect(html).toContain('aria-label="Dismiss notification"');
  });

  // ─── Polling script (replaces full-page meta refresh) ──────────────────────

  it("uses client-side polling of the fragment instead of a full-page meta refresh", async () => {
    getDispatchRunsPageMock.mockResolvedValue([makeDispatchRun()]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    // No full-page meta refresh anymore.
    expect(html).not.toContain('http-equiv="refresh"');
    // Centralized refresh + interval + visibility trigger that reuses it.
    expect(html).toContain("async function refreshDashboard()");
    expect(html).toContain('fetch("/dashboard/fragment"');
    expect(html).toContain("setInterval(refreshDashboard, 15000)");
    expect(html).toContain('document.addEventListener("visibilitychange"');
    expect(html).toContain("clearTransientDashboardQueryParams");
    expect(html).toContain('for (const key of ["notice", "noticeType", "deleteFailed"])');
    expect(html).toContain("window.history.replaceState(null, \"\", nextUrl)");
    expect(html).toContain('document.addEventListener("keydown", (event) => {');
    expect(html).toContain('event.key !== "Escape"');
    expect(html).toContain("data-error-token-button");
    expect(html).toContain('id="dashboard-content"');
    expect(html).toContain("⚙ Configure</a>");
  });

  // ─── Fragment route (used by the poll) ─────────────────────────────────────

  it("fragment route returns the table content without the full page shell", async () => {
    getDispatchRunsPageMock.mockResolvedValue([makeDispatchRun({ ticket_key: "HYDI-1" })]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/fragment");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<table");
    expect(html).toContain(">HYDI-1</a>");
    // Fragment must not include the document shell or the polling container.
    expect(html).not.toContain("<!DOCTYPE html>");
    expect(html).not.toContain('id="dashboard-content"');
  });

  // ─── Delete handler (unchanged contract) ───────────────────────────────────

  it("declines delete when linked PR is open", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-48", project_key: "HYDI", pr_url: "https://github.com/org/repo/pull/123" }),
    ]);
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 123 });
    getPullRequestStateMock.mockResolvedValue("open");

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/HYDI-48/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "project=HYDI",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("noticeType=error");
    expect(res.headers.get("location")).toContain("PR+%23123+is+open");
    expect(res.headers.get("location")).toContain("deleteFailed=HYDI-48");
    expect(deleteRunMock).not.toHaveBeenCalled();
  });

  it("declines delete when linked PR URL is invalid", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-49", project_key: "HYDI", pr_url: "not-a-valid-pr-url" }),
    ]);
    parseGithubPullRequestUrlMock.mockReturnValue(null);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/HYDI-49/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "project=HYDI",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("noticeType=error");
    expect(res.headers.get("location")).toContain("PR+URL+is+invalid");
    expect(res.headers.get("location")).toContain("deleteFailed=HYDI-49");
    expect(deleteRunMock).not.toHaveBeenCalled();
  });

  it("declines delete with an actionable message and logs when PR status lookup fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-48", project_key: "HYDI", pr_url: "https://github.com/org/repo/pull/123" }),
    ]);
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 123 });
    getPullRequestStateMock.mockRejectedValue(new Error("lookup failed"));

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/HYDI-48/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "project=HYDI",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("Use+Force+delete");
    expect(res.headers.get("location")).toContain("deleteFailed=HYDI-48");
    expect(deleteRunMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("force delete bypasses the PR check entirely and deletes the run", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-48", project_key: "HYDI", pr_url: "https://github.com/org/repo/pull/123" }),
    ]);
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 123 });
    getPullRequestStateMock.mockResolvedValue("open");

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/HYDI-48/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "project=HYDI&force=1",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("noticeType=success");
    expect(getPullRequestStateMock).not.toHaveBeenCalled();
    expect(deleteRunMock).toHaveBeenCalledWith("HYDI-48");
  });

  it("allows delete when linked PR is closed", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-48", project_key: "HYDI", pr_url: "https://github.com/org/repo/pull/123" }),
    ]);
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 123 });
    getPullRequestStateMock.mockResolvedValue("closed");

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/HYDI-48/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "project=HYDI",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("noticeType=success");
    expect(deleteRunMock).toHaveBeenCalledWith("HYDI-48");
  });
});
