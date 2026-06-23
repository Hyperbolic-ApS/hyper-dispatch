import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatchRun, makeJiraIssue, makeProjectConfig } from "../test/fixtures.js";

const {
  getProjectConfigMock,
  getRunsByPrUrlMock,
  updateRunStatusMock,
  tryRecordRevisionEventMock,
  deleteRevisionEventMock,
  claimRevisionSlotMock,
  releaseRevisionSlotMock,
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
  tryRecordRevisionEventMock: vi.fn(),
  deleteRevisionEventMock: vi.fn(),
  claimRevisionSlotMock: vi.fn(),
  releaseRevisionSlotMock: vi.fn(),
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
  tryRecordRevisionEvent: tryRecordRevisionEventMock,
  deleteRevisionEvent: deleteRevisionEventMock,
  claimRevisionSlot: claimRevisionSlotMock,
  releaseRevisionSlot: releaseRevisionSlotMock,
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
    tryRecordRevisionEventMock.mockReset();
    deleteRevisionEventMock.mockReset();
    claimRevisionSlotMock.mockReset();
    releaseRevisionSlotMock.mockReset();
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
    updateRunStatusMock.mockResolvedValue(null);
    retrieveRunMock.mockResolvedValue({ session_link: "https://warp.dev/run_revision_1" });
    tryRecordRevisionEventMock.mockResolvedValue(true);
    deleteRevisionEventMock.mockResolvedValue(undefined);
    claimRevisionSlotMock.mockResolvedValue({
      claimed: true,
      previousStatus: "succeeded",
      previousRunId: "run-original-44",
      runRecordId: "revision-record-claimed",
    });
    releaseRevisionSlotMock.mockResolvedValue(undefined);
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
    expect(updateRunStatusMock).toHaveBeenCalledWith("HYDI-44", {
      run_record_id: "revision-record-claimed",
      run_type: "revision",
      run_id: "run_revision_1",
      model: "auto",
      spawned_at: expect.any(Date),
      session_link: "https://warp.dev/run_revision_1",
    });
    expect(tryRecordRevisionEventMock).toHaveBeenCalledWith({
      eventKey: "review:999",
      ticketKey: "HYDI-44",
      prUrl: "https://github.com/org/repo/pull/44",
    });
    expect(claimRevisionSlotMock).toHaveBeenCalledWith("HYDI-44");
    // Project config is fetched once (resolveTrackedRevisionContext); the spawn
    // reuses it rather than re-fetching.
    expect(getProjectConfigMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a duplicate submitted-review delivery without spawning", async () => {
    getRunsByPrUrlMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-44",
        project_key: "HYDI",
        pr_url: "https://github.com/org/repo/pull/44",
      }),
    ]);
    octokitPaginateMock.mockResolvedValue([
      { path: "src/orchestration/revision.ts", line: 120, body: "**[REV-001] Important**" },
    ]);
    tryRecordRevisionEventMock.mockResolvedValue(false);

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
        review: { id: 999, state: "COMMENTED", body: "1. [REV-001] Fix it." },
      },
    });

    expect(result).toEqual({
      action: "ignored",
      reason: "duplicate review delivery already processed",
    });
    expect(claimRevisionSlotMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
  });

  it("ignores a submitted review when a revision is already in progress", async () => {
    getRunsByPrUrlMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-44",
        project_key: "HYDI",
        pr_url: "https://github.com/org/repo/pull/44",
      }),
    ]);
    octokitPaginateMock.mockResolvedValue([
      { path: "src/orchestration/revision.ts", line: 120, body: "**[REV-001] Important**" },
    ]);
    claimRevisionSlotMock.mockResolvedValue({
      claimed: false,
      previousStatus: null,
      previousRunId: null,
      runRecordId: null,
    });

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
        review: { id: 1001, state: "COMMENTED", body: "1. [REV-001] Fix it." },
      },
    });

    expect(result).toEqual({
      action: "ignored",
      reason: "revision already in progress for this PR",
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("releases the slot and idempotency record when spawning fails", async () => {
    getRunsByPrUrlMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-44",
        project_key: "HYDI",
        pr_url: "https://github.com/org/repo/pull/44",
      }),
    ]);
    octokitPaginateMock.mockResolvedValue([
      { path: "src/orchestration/revision.ts", line: 120, body: "**[REV-001] Important**" },
    ]);
    runMock.mockRejectedValue(new Error("spawn failed"));

    const { handleGithubRevisionWebhook } = await import("./revision.js");
    await expect(
      handleGithubRevisionWebhook({
        event: "pull_request_review",
        payload: {
          action: "submitted",
          repository: { owner: { login: "org" }, name: "repo" },
          pull_request: {
            number: 44,
            html_url: "https://github.com/org/repo/pull/44",
            head: { ref: "agent/HYDI-44-pr-revision-webhook" },
          },
          review: { id: 999, state: "COMMENTED", body: "1. [REV-001] Fix it." },
        },
      })
    ).rejects.toThrow("spawn failed");

    expect(releaseRevisionSlotMock).toHaveBeenCalledWith(
      "HYDI-44",
      "succeeded",
      "run-original-44",
      "revision-record-claimed"
    );
    expect(deleteRevisionEventMock).toHaveBeenCalledWith("review:999");
  });

  it("does not spawn and remains single-spawn on retry when Jira lookup fails before spawn", async () => {
    getRunsByPrUrlMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-44",
        project_key: "HYDI",
        pr_url: "https://github.com/org/repo/pull/44",
      }),
    ]);
    octokitPaginateMock.mockResolvedValue([
      { path: "src/orchestration/revision.ts", line: 120, body: "**[REV-001] Important**" },
    ]);
    jiraGetIssueMock
      .mockRejectedValueOnce(new Error("jira lookup failed"))
      .mockResolvedValue(makeJiraIssue({ key: "HYDI-44" }));

    const { handleGithubRevisionWebhook } = await import("./revision.js");
    await expect(
      handleGithubRevisionWebhook({
        event: "pull_request_review",
        payload: {
          action: "submitted",
          repository: { owner: { login: "org" }, name: "repo" },
          pull_request: {
            number: 44,
            html_url: "https://github.com/org/repo/pull/44",
            head: { ref: "agent/HYDI-44-pr-revision-webhook" },
          },
          review: { id: 999, state: "COMMENTED", body: "1. [REV-001] Fix it." },
        },
      })
    ).rejects.toThrow("jira lookup failed");
    // Spawn failed before the external run starts, so no untracked Oz run exists.
    expect(runMock).not.toHaveBeenCalled();
    expect(releaseRevisionSlotMock).toHaveBeenCalledWith(
      "HYDI-44",
      "succeeded",
      "run-original-44",
      "revision-record-claimed"
    );
    expect(deleteRevisionEventMock).toHaveBeenCalledWith("review:999");

    const retry = await handleGithubRevisionWebhook({
      event: "pull_request_review",
      payload: {
        action: "submitted",
        repository: { owner: { login: "org" }, name: "repo" },
        pull_request: {
          number: 44,
          html_url: "https://github.com/org/repo/pull/44",
          head: { ref: "agent/HYDI-44-pr-revision-webhook" },
        },
        review: { id: 999, state: "COMMENTED", body: "1. [REV-001] Fix it." },
      },
    });

    expect(retry).toEqual({
      action: "spawned",
      mode: "auto_review_submitted",
      ticketKey: "HYDI-44",
      runId: "run_revision_1",
      actionItemCount: 1,
    });
    // Across initial pre-spawn failure + retry, only one external Oz run is started.
    expect(runMock).toHaveBeenCalledTimes(1);
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
          id: 9999,
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
    expect(tryRecordRevisionEventMock).toHaveBeenCalledWith({
      eventKey: "comment:9999",
      ticketKey: "HYDI-44",
      prUrl: "https://github.com/org/repo/pull/44",
    });
    // Project config is fetched once for the manual path; the spawn reuses it.
    expect(getProjectConfigMock).toHaveBeenCalledTimes(1);
  });

  it("ignores an issue_comment without a comment id so idempotency is not bypassed", async () => {
    const { handleGithubRevisionWebhook } = await import("./revision.js");
    const result = await handleGithubRevisionWebhook({
      event: "issue_comment",
      payload: {
        action: "created",
        repository: { owner: { login: "org" }, name: "repo" },
        issue: {
          number: 44,
          html_url: "https://github.com/org/repo/pull/44",
          pull_request: { html_url: "https://github.com/org/repo/pull/44" },
        },
        comment: { user: { login: "kasper" }, body: "/revise do the thing" },
      },
    });

    expect(result).toEqual({ action: "ignored", reason: "issue comment missing id" });
    expect(tryRecordRevisionEventMock).not.toHaveBeenCalled();
    expect(claimRevisionSlotMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
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

  it("ignores non-reply pull_request_review_comment events", async () => {
    const { handleGithubRevisionWebhook } = await import("./revision.js");
    const result = await handleGithubRevisionWebhook({
      event: "pull_request_review_comment",
      payload: {
        action: "created",
        comment: { body: "Some inline note" },
      },
    });

    expect(result).toEqual({
      action: "ignored",
      reason: "review comment events are ignored; wait for submitted review",
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("ignores a duplicate /revise comment delivery without spawning", async () => {
    getRunsByPrUrlMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-44",
        project_key: "HYDI",
        pr_url: "https://github.com/org/repo/pull/44",
      }),
    ]);
    octokitPullGetMock.mockResolvedValue({
      data: { head: { ref: "agent/HYDI-44-pr-revision-webhook" } },
    });
    tryRecordRevisionEventMock.mockResolvedValue(false);

    const { handleGithubRevisionWebhook } = await import("./revision.js");
    const result = await handleGithubRevisionWebhook({
      event: "issue_comment",
      payload: {
        action: "created",
        repository: { owner: { login: "org" }, name: "repo" },
        issue: {
          number: 44,
          html_url: "https://github.com/org/repo/pull/44",
          pull_request: { html_url: "https://github.com/org/repo/pull/44" },
        },
        comment: {
          id: 555,
          user: { login: "kasper" },
          body: "/revise tighten the guard",
        },
      },
    });

    expect(result).toEqual({
      action: "ignored",
      reason: "duplicate comment delivery already processed",
    });
    expect(tryRecordRevisionEventMock).toHaveBeenCalledWith({
      eventKey: "comment:555",
      ticketKey: "HYDI-44",
      prUrl: "https://github.com/org/repo/pull/44",
    });
    expect(runMock).not.toHaveBeenCalled();
  });
});
