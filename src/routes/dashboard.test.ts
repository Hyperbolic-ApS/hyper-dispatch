import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatchRun } from "../test/fixtures.js";

const getAllDispatchRunsMock = vi.fn();
const listProjectConfigsMock = vi.fn();
const getIssueMock = vi.fn();
const getIssuesByKeysMock = vi.fn();
const annotateRunsWithProdDeploymentStatusMock = vi.fn();
const deleteRunMock = vi.fn();
const parseGithubPullRequestUrlMock = vi.fn();
const getPullRequestDisplayStateMock = vi.fn();
const getPullRequestStateMock = vi.fn();
const listWorkflowRunsForRepoMock = vi.fn();
const octokitAuthTokens: string[] = [];
const workflowRunListRequests: Array<Record<string, unknown>> = [];

vi.mock("../db/config-queries.js", () => ({
  getAllDispatchRuns: getAllDispatchRunsMock,
  listProjectConfigs: listProjectConfigsMock,
}));
vi.mock("../db/queries.js", () => ({
  deleteRun: deleteRunMock,
}));

vi.mock("../jira/client.js", () => ({
  getIssue: getIssueMock,
  getIssuesByKeys: getIssuesByKeysMock,
}));
vi.mock("../github/pull-requests.js", () => ({
  parseGithubPullRequestUrl: parseGithubPullRequestUrlMock,
  getPullRequestDisplayState: getPullRequestDisplayStateMock,
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
    listProjectConfigsMock.mockResolvedValue([]);
    listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [] } });
    annotateRunsWithProdDeploymentStatusMock.mockImplementation(async (runs: unknown[]) =>
      runs.map((run) => ({ ...(run as object), deployed_to_prod: null }))
    );
    parseGithubPullRequestUrlMock.mockImplementation((prUrl: string) => {
      const match = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
      if (!match) return null;
      return { owner: match[1], repo: match[2], pullNumber: Number.parseInt(match[3], 10) };
    });
    // The dashboard now resolves ticket statuses via the batched getIssuesByKeys. By
    // default, delegate to each test's getIssue mock per key so existing status setups
    // (including rejections) keep driving the batched code path with no per-test changes.
    getIssuesByKeysMock.mockImplementation(async (keys: string[]) => {
      const issues: Array<{ key: string }> = [];
      for (const key of keys) {
        const issue = await getIssueMock(key, ["status"]);
        if (issue) issues.push({ key, ...issue });
      }
      return issues;
    });
  });
  it("renders PR Status and preserves merge conflict fallback when no action is running", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/42",
        pr_has_conflicts: true,
      }),
    ]);
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

  it("shows combined PR status when review and revision workflows are both in progress", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/45",
        pr_has_conflicts: false,
      }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Review", statusCategory: { key: "in-flight" } } },
    });
    listWorkflowRunsForRepoMock.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            name: "Oz PR Review Commenting",
            status: "in_progress",
            pull_requests: [{ number: 45 }],
          },
          {
            name: "Agent Revision on Review Feedback",
            status: "queued",
            pull_requests: [{ number: 45 }],
          },
        ],
      },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Review + revision running");
  });

  it("detects review running via head_branch when pull_requests is empty", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-50",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/50",
        pr_has_conflicts: false,
      }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Review", statusCategory: { key: "in-flight" } } },
    });
    listWorkflowRunsForRepoMock.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            name: "Oz PR Review Commenting",
            status: "in_progress",
            pull_requests: [],
            head_branch: "agent/HYDI-50",
          },
        ],
      },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Review running");
  });

  it("detects revision running via head_branch when pull_requests is empty", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-51",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/51",
        pr_has_conflicts: false,
      }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Review", statusCategory: { key: "in-flight" } } },
    });
    listWorkflowRunsForRepoMock.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            name: "Agent Revision on Review Feedback",
            status: "queued",
            pull_requests: [],
            head_branch: "agent/HYDI-51",
          },
        ],
      },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Revision running");
  });

  it("issues one workflow-run fetch per repo, not per PR", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-60",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/60",
      }),
      makeDispatchRun({
        ticket_key: "HYDI-61",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/61",
      }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Review", statusCategory: { key: "in-flight" } } },
    });
    listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [] } });

    const { dashboardRouter } = await import("./dashboard.js");
    await dashboardRouter.request("http://localhost/");

    expect(workflowRunListRequests).toHaveLength(1);
    expect(workflowRunListRequests[0]).toEqual({
      owner: "warp",
      repo: "hyper-dispatch",
      per_page: 100,
      page: 1,
    });
  });

  it("uses per-project GitHub token and does not constrain workflow lookup by event", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-77",
        project_key: "HYDI",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/77",
      }),
    ]);
    listProjectConfigsMock.mockResolvedValue([
      {
        project_key: "HYDI",
        github_pat: "project-token-123",
        active: true,
      },
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Review", statusCategory: { key: "in-flight" } } },
    });
    listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [] } });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");

    expect(res.status).toBe(200);
    expect(octokitAuthTokens).toContain("project-token-123");
    expect(workflowRunListRequests[0]).toEqual({
      owner: "warp",
      repo: "hyper-dispatch",
      per_page: 100,
      page: 1,
    });
    expect(workflowRunListRequests[0]).not.toHaveProperty("event");
  });

  it("separates workflow-run fetches by token when two projects share the same repo", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-80",
        project_key: "HYDI",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/80",
      }),
      makeDispatchRun({
        ticket_key: "TEST-81",
        project_key: "TEST",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/81",
      }),
    ]);
    listProjectConfigsMock.mockResolvedValue([
      { project_key: "HYDI", github_pat: "token-hydi", active: true },
      { project_key: "TEST", github_pat: "token-test", active: true },
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Review", statusCategory: { key: "in-flight" } } },
    });
    listWorkflowRunsForRepoMock
      .mockResolvedValueOnce({ data: { workflow_runs: [] } })
      .mockResolvedValueOnce({ data: { workflow_runs: [] } });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");

    expect(res.status).toBe(200);
    expect(octokitAuthTokens).toEqual(expect.arrayContaining(["token-hydi", "token-test"]));
    expect(workflowRunListRequests).toHaveLength(2);
  });

  it("follows pagination and finds in-flight workflow runs on later pages", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-90",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/90",
        pr_has_conflicts: false,
      }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Review", statusCategory: { key: "in-flight" } } },
    });

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
            {
              name: "Oz PR Review Commenting",
              status: "in_progress",
              pull_requests: [],
              head_branch: "agent/HYDI-90",
            },
          ],
        },
      });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Review running");
    expect(workflowRunListRequests[0]).toMatchObject({ page: 1, per_page: 100 });
    expect(workflowRunListRequests[1]).toMatchObject({ page: 2, per_page: 100 });
  });
  it("includes an immediate refresh trigger when the tab becomes active", async () => {
    getAllDispatchRunsMock.mockResolvedValue([makeDispatchRun()]);
    annotateRunsWithProdDeploymentStatusMock.mockImplementation(async (runs) =>
      runs.map((run: ReturnType<typeof makeDispatchRun>) => ({
        ...run,
        deployed_to_prod: false,
      }))
    );
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
    expect(html).toContain("Agent Status");
    expect(html).not.toContain("Prod Deployment (Coolify)");
    expect(html).not.toContain("Not deployed");
  });

  it("renders Spawned At using dd/MM/YY HH:MM format", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        spawned_at: new Date("2026-06-10T12:34:00.000Z"),
      }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "To Do", statusCategory: { key: "new" } } },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toMatch(/\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}/);
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

  it("renders a compact row actions menu with delete option", async () => {
    getAllDispatchRunsMock.mockResolvedValue([makeDispatchRun()]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "To Do", statusCategory: { key: "new" } } },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("data-row-menu-button");
    expect(html).toContain(">⋮</button>");
    expect(html).toContain(">Delete</button>");
  });

  it("escapes notice content from query string", async () => {
    getAllDispatchRunsMock.mockResolvedValue([makeDispatchRun()]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "To Do", statusCategory: { key: "new" } } },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request(
      "http://localhost/?noticeType=error&notice=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E"
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("escapes hidden input values derived from query filters", async () => {
    const maliciousProject = 'HYDI"><script>alert(1)</script>';
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ project_key: maliciousProject, status: "running" }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "To Do", statusCategory: { key: "new" } } },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request(
      `http://localhost/?project=${encodeURIComponent(maliciousProject)}&status=running`
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(
      'name="project" value="HYDI&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'
    );
    expect(html).not.toContain('name="project" value="HYDI"><script>alert(1)</script>"');
  });

  it("declines delete when linked PR is open", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-48",
        project_key: "HYDI",
        pr_url: "https://github.com/org/repo/pull/123",
      }),
    ]);
    listProjectConfigsMock.mockResolvedValue([]);
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
    expect(getPullRequestStateMock).toHaveBeenCalledWith(
      "https://github.com/org/repo/pull/123",
      expect.any(String)
    );
    expect(deleteRunMock).not.toHaveBeenCalled();
  });

  it("declines delete when linked PR URL is invalid", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-48",
        project_key: "HYDI",
        pr_url: "not-a-valid-pr-url",
      }),
    ]);
    listProjectConfigsMock.mockResolvedValue([]);
    parseGithubPullRequestUrlMock.mockReturnValue(null);

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/HYDI-48/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "project=HYDI",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("noticeType=error");
    expect(res.headers.get("location")).toContain("PR+URL+is+invalid");
    expect(res.headers.get("location")).toContain("deleteFailed=HYDI-48");
    expect(getPullRequestStateMock).not.toHaveBeenCalled();
    expect(deleteRunMock).not.toHaveBeenCalled();
  });

  it("declines delete with an accurate, actionable message and logs when PR status lookup fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-48",
        project_key: "HYDI",
        pr_url: "https://github.com/org/repo/pull/123",
      }),
    ]);
    listProjectConfigsMock.mockResolvedValue([]);
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 123 });
    getPullRequestStateMock.mockRejectedValue(new Error("lookup failed"));

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/HYDI-48/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "project=HYDI",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("noticeType=error");
    // Message must no longer claim the PR is open; it should point to Force delete.
    expect(res.headers.get("location")).not.toContain("Close+the+PR");
    expect(res.headers.get("location")).toContain("Use+Force+delete");
    expect(res.headers.get("location")).toContain("deleteFailed=HYDI-48");
    expect(deleteRunMock).not.toHaveBeenCalled();
    // The swallowed error must be logged so the failure is debuggable.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("force delete bypasses the PR check entirely and deletes the run", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-48",
        project_key: "HYDI",
        pr_url: "https://github.com/org/repo/pull/123",
      }),
    ]);
    listProjectConfigsMock.mockResolvedValue([]);
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 123 });
    // Even an open PR must not block a forced delete.
    getPullRequestStateMock.mockResolvedValue("open");

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/HYDI-48/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "project=HYDI&force=1",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("noticeType=success");
    // Force delete must skip the GitHub lookup altogether.
    expect(getPullRequestStateMock).not.toHaveBeenCalled();
    expect(deleteRunMock).toHaveBeenCalledWith("HYDI-48");
  });

  it("force delete removes the run even when the PR status lookup would fail", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-48",
        project_key: "HYDI",
        pr_url: "https://github.com/org/repo/pull/123",
      }),
    ]);
    listProjectConfigsMock.mockResolvedValue([]);
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 123 });
    getPullRequestStateMock.mockRejectedValue(new Error("rate limited"));

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
      makeDispatchRun({
        ticket_key: "HYDI-48",
        project_key: "HYDI",
        pr_url: "https://github.com/org/repo/pull/123",
      }),
    ]);
    listProjectConfigsMock.mockResolvedValue([]);
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

  it("renders PR link with pull request number when available", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-51",
        status: "succeeded",
        pr_url: "https://github.com/org/repo/pull/123",
        pr_display_state: "open",
      }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "Done", statusCategory: { key: "done" } } },
    });
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 123 });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<a href="https://github.com/org/repo/pull/123" target="_blank">PR #123</a>');
  });

  it("renders PR link with merged suffix when pull request is merged", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-54",
        status: "succeeded",
        pr_url: "https://github.com/org/repo/pull/54",
        pr_display_state: "merged",
      }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "Done", statusCategory: { key: "done" } } },
    });
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 54 });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(
      '<a href="https://github.com/org/repo/pull/54" target="_blank">PR #54 (Merged)</a>'
    );
  });

  it("renders PR link with draft suffix when pull request is draft", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-54",
        status: "succeeded",
        pr_url: "https://github.com/org/repo/pull/54",
        pr_display_state: "draft",
      }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Review", statusCategory: { key: "in-flight" } } },
    });
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 54 });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(
      '<a href="https://github.com/org/repo/pull/54" target="_blank">PR #54 (Draft)</a>'
    );
  });

  it("renders PR link with closed suffix when pull request is closed and unmerged", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-54",
        status: "succeeded",
        pr_url: "https://github.com/org/repo/pull/54",
        pr_display_state: "closed",
      }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Review", statusCategory: { key: "in-flight" } } },
    });
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 54 });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(
      '<a href="https://github.com/org/repo/pull/54" target="_blank">PR #54 (Closed)</a>'
    );
  });

  it("does not call getPullRequestDisplayState while rendering dashboard rows", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-60",
        status: "succeeded",
        pr_url: "https://github.com/org/repo/pull/60",
        pr_display_state: "merged",
      }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "In Review", statusCategory: { key: "in-flight" } } },
    });
    parseGithubPullRequestUrlMock.mockReturnValue({ owner: "org", repo: "repo", pullNumber: 60 });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<a href="https://github.com/org/repo/pull/60" target="_blank">PR #60 (Merged)</a>');
    expect(getPullRequestDisplayStateMock).not.toHaveBeenCalled();
  });

  it("logs a warning but still renders the row when the Jira status lookup fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-61", project_key: "HYDI", status: "running" }),
    ]);
    getIssueMock.mockRejectedValue(new Error("jira down"));

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    // The row still renders (no ticket-status badge), and the swallowed failure is logged.
    expect(res.status).toBe(200);
    expect(html).toContain(">HYDI-61</a>");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("shows Force delete only for the row whose delete previously failed", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI", status: "succeeded" }),
      makeDispatchRun({ ticket_key: "HYDI-2", project_key: "HYDI", status: "succeeded" }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "Done", statusCategory: { key: "done" } } },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/?deleteFailed=HYDI-1");
    const html = await res.text();

    expect(res.status).toBe(200);
    // Force delete is offered for the failed row only.
    expect(html).toContain("Force delete HYDI-1?");
    expect(html).not.toContain("Force delete HYDI-2?");
  });

  it("does not show Force delete when no delete has failed", async () => {
    getAllDispatchRunsMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-1", project_key: "HYDI", status: "succeeded" }),
    ]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "Done", statusCategory: { key: "done" } } },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(">HYDI-1</a>");
    expect(html).not.toContain("Force delete");
  });

  it("does not run prod-deployment enrichment while its column is hidden", async () => {
    getAllDispatchRunsMock.mockResolvedValue([makeDispatchRun()]);
    getIssueMock.mockResolvedValue({
      fields: { status: { name: "To Do", statusCategory: { key: "new" } } },
    });

    const { dashboardRouter } = await import("./dashboard.js");
    const res = await dashboardRouter.request("http://localhost/");

    // The Coolify/GitHub enrichment must be skipped entirely when the column is hidden,
    // otherwise it performs one GitHub PR lookup per run on every 15s auto-refresh.
    expect(res.status).toBe(200);
    expect(annotateRunsWithProdDeploymentStatusMock).not.toHaveBeenCalled();
  });
});
