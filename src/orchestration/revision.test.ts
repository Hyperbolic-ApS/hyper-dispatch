import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatchRun, makeJiraIssue, makeProjectConfig } from "../test/fixtures.js";

const {
  getProjectConfigMock,
  getRunsByPrUrlMock,
  updateRunStatusMock,
  jiraGetIssueMock,
  resolveProjectTokensMock,
  resolveModelMock,
  runMock,
  retrieveRunMock,
  octokitPaginateMock,
  octokitPullGetMock,
} = vi.hoisted(() => ({
  getProjectConfigMock: vi.fn(),
  getRunsByPrUrlMock: vi.fn(),
  updateRunStatusMock: vi.fn(),
  jiraGetIssueMock: vi.fn(),
  resolveProjectTokensMock: vi.fn(),
  resolveModelMock: vi.fn(),
  runMock: vi.fn(),
  retrieveRunMock: vi.fn(),
  octokitPaginateMock: vi.fn(),
  octokitPullGetMock: vi.fn(),
}));

vi.mock("../db/queries.js", () => ({
  getProjectConfig: getProjectConfigMock,
  getRunsByPrUrl: getRunsByPrUrlMock,
  updateRunStatus: updateRunStatusMock,
}));

vi.mock("../jira/client.js", () => ({
  getIssue: jiraGetIssueMock,
}));

vi.mock("../config/env.js", () => ({
  resolveProjectTokens: resolveProjectTokensMock,
}));

vi.mock("./spawner.js", () => ({
  resolveModel: resolveModelMock,
}));

vi.mock("./oz-client.js", () => ({
  getOzClient: vi.fn(() => ({
    agent: {
      run: runMock,
      runs: {
        retrieve: retrieveRunMock,
      },
    },
  })),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    rest = {
      pulls: {
        listCommentsForReview: vi.fn(),
        get: octokitPullGetMock,
      },
    };
    paginate = octokitPaginateMock;
  },
}));

describe("handleGithubRevisionWebhook", () => {
  beforeEach(() => {
    getProjectConfigMock.mockReset();
    getRunsByPrUrlMock.mockReset();
    updateRunStatusMock.mockReset();
    jiraGetIssueMock.mockReset();
    resolveProjectTokensMock.mockReset();
    resolveModelMock.mockReset();
    runMock.mockReset();
    retrieveRunMock.mockReset();
    octokitPaginateMock.mockReset();
    octokitPullGetMock.mockReset();

    const config = makeProjectConfig({
      project_key: "HYDI",
      oz_env_id: "env_123",
      mcp_servers: null,
      oz_agent_identity_uid: null,
    });
    getProjectConfigMock.mockResolvedValue(config);
    resolveProjectTokensMock.mockReturnValue({
      githubToken: "gh-token",
      jiraApiToken: "jira-token",
      ozApiKey: "oz-token",
    });
    jiraGetIssueMock.mockResolvedValue(makeJiraIssue({ key: "HYDI-44" }));
    resolveModelMock.mockReturnValue("auto");
    runMock.mockResolvedValue({ run_id: "run_revision_1" });
    retrieveRunMock.mockResolvedValue({ session_link: "https://warp.dev/run_revision_1" });
  });

  it("spawns a revision run when submitted review contains action items", async () => {
    getRunsByPrUrlMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-44",
        project_key: "HYDI",
        pr_url: "https://github.com/org/repo/pull/44",
      }),
    ]);
    octokitPaginateMock.mockResolvedValue([
      {
        path: "src/orchestration/revision.ts",
        line: 120,
        body: "**[REV-001] Important — tighten gating**",
      },
    ]);

    const { handleGithubRevisionWebhook } = await import("./revision.js");
    const result = await handleGithubRevisionWebhook({
      event: "pull_request_review",
      payload: {
        action: "submitted",
        repository: { owner: { login: "org" }, name: "repo" },
        pull_request: {
          number: 44,
          html_url: "https://github.com/org/repo/pull/44",
          head: { ref: "agent/HYDI-44-pr-revision-webhook" },
        },
        review: {
          id: 999,
          state: "COMMENTED",
          body: "### Action Plan For Implementing Agent\n1. [REV-001] Fix the handler.",
        },
      },
    });

    expect(result).toEqual({
      action: "spawned",
      mode: "auto_review_submitted",
      ticketKey: "HYDI-44",
      runId: "run_revision_1",
      actionItemCount: 1,
    });
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-44",
      expect.objectContaining({
        status: "running",
        run_id: "run_revision_1",
        model: "auto",
      })
    );
  });

  it("skips spawning when submitted review has no action items", async () => {
    getRunsByPrUrlMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-44",
        project_key: "HYDI",
        pr_url: "https://github.com/org/repo/pull/44",
      }),
    ]);
    octokitPaginateMock.mockResolvedValue([
      {
        path: "src/orchestration/revision.ts",
        line: 120,
        body: "Looks good overall.",
      },
    ]);

    const { handleGithubRevisionWebhook } = await import("./revision.js");
    const result = await handleGithubRevisionWebhook({
      event: "pull_request_review",
      payload: {
        action: "submitted",
        repository: { owner: { login: "org" }, name: "repo" },
        pull_request: {
          number: 44,
          html_url: "https://github.com/org/repo/pull/44",
          head: { ref: "agent/HYDI-44-pr-revision-webhook" },
        },
        review: {
          id: 999,
          state: "COMMENTED",
          body: "No blocking issues.",
        },
      },
    });

    expect(result).toEqual({
      action: "ignored",
      reason: "review has no action items",
    });
    expect(runMock).not.toHaveBeenCalled();
    expect(updateRunStatusMock).not.toHaveBeenCalled();
  });

  it("spawns manual revision from /revise comment using comment instructions", async () => {
    getRunsByPrUrlMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-44",
        project_key: "HYDI",
        pr_url: "https://github.com/org/repo/pull/44",
      }),
    ]);
    octokitPullGetMock.mockResolvedValue({
      data: {
        head: { ref: "agent/HYDI-44-pr-revision-webhook" },
      },
    });

    const { handleGithubRevisionWebhook } = await import("./revision.js");
    const result = await handleGithubRevisionWebhook({
      event: "issue_comment",
      payload: {
        action: "created",
        repository: { owner: { login: "org" }, name: "repo" },
        issue: {
          number: 44,
          html_url: "https://github.com/org/repo/pull/44",
          pull_request: {
            html_url: "https://github.com/org/repo/pull/44",
          },
        },
        comment: {
          user: { login: "kasper" },
          body: "/revise focus on the failing webhook action parsing",
        },
      },
    });

    expect(result).toEqual({
      action: "spawned",
      mode: "manual_comment",
      ticketKey: "HYDI-44",
      runId: "run_revision_1",
      actionItemCount: 1,
    });
    expect(jiraGetIssueMock).toHaveBeenCalledWith("HYDI-44");
    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("focus on the failing webhook action parsing"),
      })
    );
  });

  it("ignores pull_request_review_comment reply events", async () => {
    const { handleGithubRevisionWebhook } = await import("./revision.js");
    const result = await handleGithubRevisionWebhook({
      event: "pull_request_review_comment",
      payload: {
        action: "created",
        comment: { in_reply_to_id: 12345 },
      },
    });

    expect(result).toEqual({
      action: "ignored",
      reason: "review comment reply does not trigger revision",
    });
    expect(runMock).not.toHaveBeenCalled();
  });
});
