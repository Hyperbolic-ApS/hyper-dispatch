import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatchRun } from "../test/fixtures.js";

const getAllDispatchRunsMock = vi.fn();
const getDispatchRunsPageMock = vi.fn();
const countDispatchRunsMock = vi.fn();
const getStatusCountsMock = vi.fn();
const getDistinctRunProjectKeysMock = vi.fn();
const getRunHistoryForTicketsMock = vi.fn();
const listProjectConfigsMock = vi.fn();
const deleteRunMock = vi.fn();
const getProjectConfigMock = vi.fn();
const updateRunStatusMock = vi.fn();
const annotateRunsWithProdDeploymentStatusMock = vi.fn();
const parseGithubPullRequestUrlMock = vi.fn();
const getPullRequestStateMock = vi.fn();
const ozRunRetrieveMock = vi.fn();

vi.mock("../db/config-queries.js", () => ({
  getAllDispatchRuns: getAllDispatchRunsMock,
  getDispatchRunsPage: getDispatchRunsPageMock,
  countDispatchRuns: countDispatchRunsMock,
  getStatusCounts: getStatusCountsMock,
  getDistinctRunProjectKeys: getDistinctRunProjectKeysMock,
  getRunHistoryForTickets: getRunHistoryForTicketsMock,
  listProjectConfigs: listProjectConfigsMock,
  DEFAULT_DASHBOARD_PAGE_SIZE: 50,
}));
vi.mock("../db/queries.js", () => ({
  deleteRun: deleteRunMock,
  getProjectConfig: getProjectConfigMock,
  updateRunStatus: updateRunStatusMock,
}));
vi.mock("../github/pull-requests.js", () => ({
  parseGithubPullRequestUrl: parseGithubPullRequestUrlMock,
  getPullRequestState: getPullRequestStateMock,
}));
vi.mock("../coolify/prod-deployment.js", () => ({
  annotateRunsWithProdDeploymentStatus: annotateRunsWithProdDeploymentStatusMock,
}));
vi.mock("../orchestration/oz-client.js", () => ({
  getOzClient: vi.fn(() => ({
    agent: {
      runs: {
        retrieve: ozRunRetrieveMock,
      },
    },
  })),
}));

describe("dashboardRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDispatchRunsPageMock.mockResolvedValue([]);
    countDispatchRunsMock.mockResolvedValue(0);
    getStatusCountsMock.mockResolvedValue([]);
    getDistinctRunProjectKeysMock.mockResolvedValue([]);
    getRunHistoryForTicketsMock.mockResolvedValue([]);
    listProjectConfigsMock.mockResolvedValue([]);
    getAllDispatchRunsMock.mockResolvedValue([]);
    getProjectConfigMock.mockResolvedValue(null);
    updateRunStatusMock.mockResolvedValue(null);
    ozRunRetrieveMock.mockReset();
    annotateRunsWithProdDeploymentStatusMock.mockImplementation(async (runs: unknown[]) =>
      runs.map((run) => ({ ...(run as object), deployed_to_prod: null }))
    );
    parseGithubPullRequestUrlMock.mockImplementation((prUrl: string) => {
      const match = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
      if (!match) return null;
      return { owner: match[1], repo: match[2], pullNumber: Number.parseInt(match[3], 10) };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(html).toContain("<code>agent/HYDI-1-default-fixture-summary</code>");
    // Ticket-status badge text comes straight from the persisted column.
    expect(html).toContain(">In Progress</span>");
    expect(html).toContain("Agent Status");
  });

  it("falls back to ticket-only branch name when summary slug normalizes to empty", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-101",
        summary: "!!!",
        status: "running",
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<code>agent/HYDI-101</code>");
    expect(html).not.toContain("<code>agent/HYDI-101-</code>");
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

  it('renders "Now" when spawned_at is within the last minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:34:30.000Z"));
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({ spawned_at: new Date(Date.now() - 30_000) }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(">Now</td>");
  });

  it('renders "Today at HH:MM" when spawned_at is earlier today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:34:30.000Z"));
    const now = new Date();
    const spawnedToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      8,
      5,
      0,
      0
    );
    getDispatchRunsPageMock.mockResolvedValue([makeDispatchRun({ spawned_at: spawnedToday })]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toMatch(/Today at \d{2}:\d{2}/);
  });

  it('renders "Yesterday at HH:MM" when spawned_at is on the previous day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:34:30.000Z"));
    const now = new Date();
    const spawnedYesterday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      23,
      45,
      0,
      0
    );
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({ spawned_at: spawnedYesterday }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toMatch(/Yesterday at \d{2}:\d{2}/);
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

  it("renders a clickable run-history toggle so single-row popovers can be pinned", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-130",
        status: "running",
      }),
    ]);
    getRunHistoryForTicketsMock.mockResolvedValue([
      makeDispatchRun({
        id: "run-history-130",
        ticket_key: "HYDI-130",
        run_type: "implementation",
        status: "running",
        created_at: new Date("2026-06-10T12:34:00.000Z"),
        session_link: "https://oz.warp.dev/runs/run-history-130",
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("data-run-history-toggle");
    expect(html).toContain('aria-label="Toggle run history for HYDI-130"');
    expect(html).toContain('data-run-history-pin data-ticket-key="HYDI-130"');
    expect(html).toContain("const runHistoryToggle = target.closest(\"[data-run-history-toggle]\")");
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

  // ─── PR status badges (from persisted columns) ─────────────────────────────

  it("renders PR Status and preserves merge conflict fallback when no action is running", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/42",
        pr_has_conflicts: true,
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<th>PR Status</th>");
    expect(html).toContain("Merge conflicts");
  });

  it("shows review running PR status from the persisted pr_review_running column", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/43",
        pr_has_conflicts: false,
        pr_review_running: true,
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain("Review running");
    expect(html).not.toContain("No conflicts");
  });

  it("shows revision running PR status from the persisted pr_revision_running column", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/44",
        pr_has_conflicts: false,
        pr_revision_running: true,
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain("Revision running");
  });

  it("shows review + revision running when both persisted columns are set", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/45",
        pr_has_conflicts: false,
        pr_review_running: true,
        pr_revision_running: true,
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain("Review + revision running");
  });

  it("renders no-wrap inline styles across agent, PR, and ticket status badges", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-89",
        status: "running",
        ticket_status_name: "In Progress",
        ticket_status_category: "in-flight",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/89",
        pr_review_running: true,
      }),
      makeDispatchRun({
        ticket_key: "HYDI-90",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/90",
        pr_has_conflicts: true,
      }),
      makeDispatchRun({
        ticket_key: "HYDI-91",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/91",
        pr_review_running: true,
        pr_revision_running: true,
      }),
      makeDispatchRun({
        ticket_key: "HYDI-92",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/92",
        pr_has_conflicts: false,
      }),
      makeDispatchRun({
        ticket_key: "HYDI-93",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/93",
      }),
      makeDispatchRun({
        ticket_key: "HYDI-94",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/94",
        pr_revision_running: true,
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toMatch(/\.agent-status-cell\b[^}]*white-space:\s*nowrap/);
    expect(html).toMatch(
      /<span style="(?=[^"]*white-space:\s*nowrap)(?=[^"]*background:#3b82f6;color:#fff)[^"]*">running<\/span>/i
    );
    expect(html).toMatch(
      /<span style="(?=[^"]*white-space:\s*nowrap)(?=[^"]*background:#ef4444;color:#fff)[^"]*">Merge conflicts<\/span>/i
    );
    expect(html).toMatch(
      /<span style="(?=[^"]*white-space:\s*nowrap)(?=[^"]*background:#22c55e;color:#fff)[^"]*">No conflicts<\/span>/i
    );
    expect(html).toMatch(
      /<span style="(?=[^"]*white-space:\s*nowrap)(?=[^"]*background:#e5e7eb;color:#111)[^"]*">Unknown<\/span>/i
    );
    expect(html).toMatch(
      /<span style="(?=[^"]*white-space:\s*nowrap)(?=[^"]*background:#2563eb;color:#fff)[^"]*">Review running<\/span>/i
    );
    expect(html).toMatch(
      /<span style="(?=[^"]*white-space:\s*nowrap)(?=[^"]*background:#ea580c;color:#fff)[^"]*">Revision running<\/span>/i
    );
    expect(html).toMatch(
      /<span style="(?=[^"]*white-space:\s*nowrap)(?=[^"]*background:#7c3aed;color:#fff)[^"]*">Review \+ revision running<\/span>/i
    );
    expect(html).toMatch(
      /<span style="(?=[^"]*white-space:\s*nowrap)(?=[^"]*background:#3b82f6;color:#fff)[^"]*">In Progress<\/span>/i
    );
  });

  it("ignores stale running flags once the PR is merged", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/47",
        pr_display_state: "merged",
        pr_review_running: true,
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(html).not.toContain("Review running");
  });

  it("performs no live GitHub workflow lookups on the render path", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/46",
        pr_review_running: true,
      }),
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    await res.text();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
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
    expect(html).toContain(">Resync from Oz</button>");
    expect(html).toContain(">Delete</button>");
    expect(html.indexOf(">Resync from Oz</button>")).toBeLessThan(
      html.indexOf(">Delete</button>")
    );
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

  it("escapes ticket status names sourced from persisted Jira data", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-93",
        status: "running",
        ticket_status_name: "<script>alert(1)</script>",
        ticket_status_category: "in-flight",
      }),
      makeDispatchRun({
        ticket_key: "HYDI-92",
        status: "running",
        ticket_status_name: "<b>R&amp;D</b>",
        ticket_status_category: "in-flight",
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;b&gt;R&amp;amp;D&lt;/b&gt;");
    expect(html).not.toContain("<b>R&amp;D</b>");
  });

  it("escapes ticket summary text sourced from persisted Jira data", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-94",
        summary: "<img src=x onerror=alert(1)>",
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("escapes blocked-by ticket values sourced from persisted Jira data", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-95",
        status: "blocked",
        blocked_by: ["<script>alert(1)</script>"],
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Blocked by: &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("Blocked by: <script>alert(1)</script>");
  });

  it("escapes ticket_key in link text and aria-label attributes", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI'<img>",
        summary: "!!!",
        error: "failure",
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request(
      "http://localhost/?deleteFailed=HYDI%27%3Cimg%3E"
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(">HYDI&#39;&lt;img&gt;</a>");
    expect(html).toContain('aria-label="Open actions for HYDI&#39;&lt;img&gt;"');
    expect(html).toContain('aria-label="Show error for HYDI&#39;&lt;img&gt;"');
    expect(html).toContain(
      "data-confirm-message=\"Force delete HYDI&#39;&lt;img&gt;? This skips the open-PR safety check and removes this ticket entry (and run history) from the dashboard.\""
    );
    expect(html).toContain('action="/dashboard/HYDI%27%3Cimg%3E/delete"');
    expect(html).toContain("<code>agent/HYDI&#39;&lt;img&gt;</code>");
    expect(html).not.toContain("<code>agent/HYDI'<img></code>");
    expect(html).toContain('data-copy-branch="agent/HYDI&#39;&lt;img&gt;"');
    expect(html).not.toContain(">HYDI'<img></a>");
  });

  it("escapes project_key text sourced from persisted Jira data", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-96",
        project_key: "<b>PRJ</b>",
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<td>&lt;b&gt;PRJ&lt;/b&gt;</td>");
    expect(html).not.toContain("<td><b>PRJ</b></td>");
  });

  it("escapes session_link and pr_url href attributes in rendered links", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-97",
        status: "running",
        session_link: "https://oz.warp.dev/runs/abc?a=1&b=2",
      }),
      makeDispatchRun({
        ticket_key: "HYDI-98",
        status: "succeeded",
        pr_url: "https://github.com/org/repo/pull/98?a=1&b=2",
      }),
    ]);
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 98 });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('href=\"https://oz.warp.dev/runs/abc?a=1&amp;b=2\" target=\"_blank\">Session</a>');
    expect(html).toContain(
      'href="https://github.com/org/repo/pull/98?a=1&amp;b=2" target="_blank">PR #98</a>'
    );
  });

  it("omits links when session_link or pr_url use unsafe protocols", async () => {
    getDispatchRunsPageMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-99",
        status: "running",
        session_link: "javascript:alert(1)",
      }),
      makeDispatchRun({
        ticket_key: "HYDI-100",
        status: "succeeded",
        pr_url: "data:text/html,boom",
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).not.toContain('href="javascript:alert(1)"');
    expect(html).not.toContain('href="data:text/html,boom"');
    expect(html).not.toContain(">Open</a>");
    expect(html).not.toContain(">Session</a>");
    expect(html).not.toContain(">PR</a>");
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
    expect(html).toContain('if (!form.closest("[data-row-menu]")) return;');
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

  // ─── Resync from Oz handler ────────────────────────────────────────────────

  it("resyncs a failed row to running when Oz reports INPROGRESS", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-120",
        project_key: "HYDI",
        run_id: "run_120",
        status: "failed",
      }),
    ]);
    ozRunRetrieveMock.mockResolvedValue({
      state: "INPROGRESS",
      session_link: "https://oz.warp.dev/runs/run_120",
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/HYDI-120/resync", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "project=HYDI",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("noticeType=success");
    expect(res.headers.get("location")).toContain("Resynced+HYDI-120+from+Oz");
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-120",
      expect.objectContaining({
        status: "running",
        completed_at: null,
        error: null,
        session_link: "https://oz.warp.dev/runs/run_120",
      })
    );
  });

  it("resyncs a row to failed when Oz reports FAILED", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-121",
        project_key: "HYDI",
        run_id: "run_121",
        status: "running",
      }),
    ]);
    ozRunRetrieveMock.mockResolvedValue({
      state: "FAILED",
      status_message: { message: "Out of credits" },
      session_link: "https://oz.warp.dev/runs/run_121",
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/HYDI-121/resync", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "project=HYDI",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("noticeType=success");
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-121",
      expect.objectContaining({
        status: "failed",
        error: "Out of credits",
        session_link: "https://oz.warp.dev/runs/run_121",
      })
    );
  });

  it("shows an error notice when trying to resync a row with no run_id", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-122",
        project_key: "HYDI",
        run_id: null,
        status: "failed",
      }),
    ]);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/HYDI-122/resync", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "project=HYDI",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("noticeType=error");
    expect(res.headers.get("location")).toContain("has+no+run_id");
    expect(updateRunStatusMock).not.toHaveBeenCalled();
    expect(ozRunRetrieveMock).not.toHaveBeenCalled();
  });
});
