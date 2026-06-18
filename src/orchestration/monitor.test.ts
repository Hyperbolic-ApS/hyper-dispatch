import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactItem } from "oz-agent-sdk/resources/agent/runs.js";
import {
  makeDispatchRun,
  makeOzRun,
  makeProjectConfig,
} from "../test/fixtures.js";

const {
  getRunsByStatusMock,
  updateRunStatusMock,
  getProjectConfigMock,
  getRunsBlockedByMock,
  removeBlockerMock,
  jiraGetTransitionsMock,
  jiraTransitionIssueMock,
  jiraGetIssueMock,
  ozRetrieveMock,
  ozCancelMock,
  ozApiConstructorMock,
  githubPullGetMock,
  listWorkflowRunsForRepoMock,
  getRunsWithActivePrMock,
} = vi.hoisted(() => ({
  getRunsByStatusMock: vi.fn(),
  updateRunStatusMock: vi.fn(),
  getProjectConfigMock: vi.fn(),
  getRunsBlockedByMock: vi.fn(),
  removeBlockerMock: vi.fn(),
  jiraGetTransitionsMock: vi.fn(),
  jiraTransitionIssueMock: vi.fn(),
  jiraGetIssueMock: vi.fn(),
  ozRetrieveMock: vi.fn(),
  ozCancelMock: vi.fn(),
  ozApiConstructorMock: vi.fn(),
  githubPullGetMock: vi.fn(),
  listWorkflowRunsForRepoMock: vi.fn(),
  getRunsWithActivePrMock: vi.fn(),
}));

vi.mock("../config/env.js", () => ({
  env: {
    WARP_API_KEY: "test-key",
    GITHUB_TOKEN: "gh-token",
    MAX_RUN_DURATION_HOURS: 2,
  },
  resolveProjectTokens: (config: { github_pat?: string | null; jira_api_token?: string | null; oz_api_key?: string | null }) => ({
    githubToken: config.github_pat ?? "gh-token",
    jiraApiToken: config.jira_api_token ?? "test-key",
    ozApiKey: config.oz_api_key ?? "test-key",
  }),
}));

vi.mock("../db/queries.js", () => ({
  getRunsByStatus: getRunsByStatusMock,
  getRunsWithActivePr: getRunsWithActivePrMock,
  updateRunStatus: updateRunStatusMock,
  getProjectConfig: getProjectConfigMock,
  getRunsBlockedBy: getRunsBlockedByMock,
  removeBlocker: removeBlockerMock,
}));

vi.mock("../jira/client.js", () => ({
  getTransitions: jiraGetTransitionsMock,
  transitionIssue: jiraTransitionIssueMock,
  getIssue: jiraGetIssueMock,
}));

vi.mock("oz-agent-sdk", () => ({
  default: class MockOzApi {
    constructor(options: unknown) {
      ozApiConstructorMock(options);
    }
    agent = {
      runs: {
        retrieve: ozRetrieveMock,
        cancel: ozCancelMock,
      },
    };
  },
}));

vi.mock("../github/octokit.js", () => ({
  createGithubClient: () => ({
    pulls: {
      get: githubPullGetMock,
    },
    actions: {
      listWorkflowRunsForRepo: listWorkflowRunsForRepoMock,
    },
  }),
}));

async function importMonitor() {
  return import("./monitor.js");
}

let fetchSpy: any;
let warnSpy: any;
let errorSpy: any;
let logSpy: any;

beforeEach(() => {
  vi.resetModules();
  fetchSpy = vi.spyOn(globalThis, "fetch");
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  getRunsByStatusMock.mockReset();
  updateRunStatusMock.mockReset();
  getProjectConfigMock.mockReset();
  getRunsBlockedByMock.mockReset();
  removeBlockerMock.mockReset();
  jiraGetTransitionsMock.mockReset();
  jiraTransitionIssueMock.mockReset();
  jiraGetIssueMock.mockReset();
  ozRetrieveMock.mockReset();
  ozCancelMock.mockReset();
  ozApiConstructorMock.mockReset();
  githubPullGetMock.mockReset();
  listWorkflowRunsForRepoMock.mockReset();
  listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [] } });
  getRunsWithActivePrMock.mockReset();
  getRunsWithActivePrMock.mockResolvedValue([]);
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe("parseGithubPullRequestUrl", () => {
  it("parses owner, repo, and pull number for a valid pull URL", async () => {
    const { parseGithubPullRequestUrl } = await importMonitor();
    expect(
      parseGithubPullRequestUrl("https://github.com/warp/hyper-dispatch/pull/123")
    ).toEqual({
      owner: "warp",
      repo: "hyper-dispatch",
      pullNumber: 123,
    });
  });

  it("returns null for a non-pull URL", async () => {
    const { parseGithubPullRequestUrl } = await importMonitor();
    expect(
      parseGithubPullRequestUrl("https://github.com/warp/hyper-dispatch/issues/123")
    ).toBeNull();
  });

  it("returns null when pull number is missing", async () => {
    const { parseGithubPullRequestUrl } = await importMonitor();
    expect(
      parseGithubPullRequestUrl("https://github.com/warp/hyper-dispatch/pull/")
    ).toBeNull();
  });

  it("returns null when pull number is non-numeric", async () => {
    const { parseGithubPullRequestUrl } = await importMonitor();
    expect(
      parseGithubPullRequestUrl(
        "https://github.com/warp/hyper-dispatch/pull/not-a-number"
      )
    ).toBeNull();
  });

  it("returns null for malformed URLs", async () => {
    const { parseGithubPullRequestUrl } = await importMonitor();
    expect(
      parseGithubPullRequestUrl("github.com/warp/hyper-dispatch/pull/123")
    ).toBeNull();
  });
});

describe("extractPrUrl", () => {
  it("returns null for undefined or empty artifacts", async () => {
    const { extractPrUrl } = await importMonitor();
    expect(extractPrUrl(undefined)).toBeNull();
    expect(extractPrUrl([])).toBeNull();
  });

  it("returns PR URL when pull-request artifact includes url", async () => {
    const { extractPrUrl } = await importMonitor();
    const artifacts = [
      {
        artifact_type: "PULL_REQUEST",
        data: { url: "https://github.com/warp/hyper-dispatch/pull/456" },
      },
    ] as unknown as ArtifactItem[];

    expect(extractPrUrl(artifacts)).toBe(
      "https://github.com/warp/hyper-dispatch/pull/456"
    );
  });

  it("returns null when pull-request artifact has no url", async () => {
    const { extractPrUrl } = await importMonitor();
    const artifacts = [
      {
        artifact_type: "PULL_REQUEST",
        data: {},
      },
    ] as unknown as ArtifactItem[];

    expect(extractPrUrl(artifacts)).toBeNull();
  });

  it("filters out non-PR artifacts", async () => {
    const { extractPrUrl } = await importMonitor();
    const artifacts = [
      {
        artifact_type: "SESSION_LINK",
        data: { url: "https://warp.dev/run/run_123" },
      },
    ] as unknown as ArtifactItem[];

    expect(extractPrUrl(artifacts)).toBeNull();
  });

  it("returns first matching pull request URL when multiple artifacts exist", async () => {
    const { extractPrUrl } = await importMonitor();
    const artifacts = [
      { artifact_type: "SESSION_LINK", data: { url: "https://warp.dev/run/1" } },
      {
        artifact_type: "PULL_REQUEST",
        data: { url: "https://github.com/warp/hyper-dispatch/pull/789" },
      },
      {
        artifact_type: "PULL_REQUEST",
        data: { url: "https://github.com/warp/hyper-dispatch/pull/999" },
      },
    ] as unknown as ArtifactItem[];

    expect(extractPrUrl(artifacts)).toBe(
      "https://github.com/warp/hyper-dispatch/pull/789"
    );
  });

  it("falls back to status message pull request URL when artifacts are missing", async () => {
    const { extractPrUrl } = await importMonitor();
    const statusMessage =
      "Implemented HYDI-33 and opened PR https://github.com/warp/hyper-dispatch/pull/456.";

    expect(extractPrUrl(undefined, statusMessage)).toBe(
      "https://github.com/warp/hyper-dispatch/pull/456"
    );
  });

  it("prefers artifact pull request URL over status message fallback", async () => {
    const { extractPrUrl } = await importMonitor();
    const artifacts = [
      {
        artifact_type: "PULL_REQUEST",
        data: { url: "https://github.com/warp/hyper-dispatch/pull/789" },
      },
    ] as unknown as ArtifactItem[];
    const statusMessage =
      "Opened PR https://github.com/warp/hyper-dispatch/pull/456 while running tests.";

    expect(extractPrUrl(artifacts, statusMessage)).toBe(
      "https://github.com/warp/hyper-dispatch/pull/789"
    );
  });

  it("falls back to status message when pull-request artifact URL is invalid", async () => {
    const { extractPrUrl } = await importMonitor();
    const artifacts = [
      {
        artifact_type: "PULL_REQUEST",
        data: { url: "https://github.com/warp/hyper-dispatch/issues/456" },
      },
    ] as unknown as ArtifactItem[];
    const statusMessage =
      "Opened PR https://github.com/warp/hyper-dispatch/pull/456 while running tests.";

    expect(extractPrUrl(artifacts, statusMessage)).toBe(
      "https://github.com/warp/hyper-dispatch/pull/456"
    );
  });
});

describe("checkRuns", () => {
  it("does not call Oz when no runs are running and still invokes merged-PR sweep", async () => {
    getRunsByStatusMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(getRunsByStatusMock).toHaveBeenNthCalledWith(1, "running");
    expect(getRunsByStatusMock).toHaveBeenNthCalledWith(2, "succeeded");
    expect(ozRetrieveMock).not.toHaveBeenCalled();
    expect(githubPullGetMock).not.toHaveBeenCalled();
  });

  it("warns and skips runs with null run_id while continuing the loop", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-1",
          status: "running",
          run_id: null,
        }),
        makeDispatchRun({
          ticket_key: "HYDI-2",
          status: "running",
          run_id: "run_2",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(
      makeOzRun({
        state: "FAILED",
        status_message: { message: "boom" },
      })
    );

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(warnSpy).toHaveBeenCalledWith(
      "[monitor] Run for HYDI-1 has no run_id, skipping."
    );
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-2",
      expect.objectContaining({
        status: "failed",
      })
    );
  });

  it("constructs Oz client with project oz_api_key for running run checks", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-KEY",
          status: "running",
          run_id: "run_key",
          project_key: "HYDI",
        }),
      ])
      .mockResolvedValueOnce([]);
    getProjectConfigMock.mockResolvedValue(
      makeProjectConfig({ oz_api_key: "project-oz-key" })
    );
    ozRetrieveMock.mockResolvedValue(makeOzRun({ state: "BLOCKED" }));

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(ozApiConstructorMock).toHaveBeenCalledWith({ apiKey: "project-oz-key" });
  });

  it("marks SUCCEEDED runs and swallows In Review transition errors", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-3",
          status: "running",
          run_id: "run_3",
          project_key: "HYDI",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(
      makeOzRun({
        state: "SUCCEEDED",
        artifacts: [
          {
            artifact_type: "PULL_REQUEST",
            data: { url: "https://github.com/org/repo/pull/123" },
          },
        ],
        session_link: "https://warp.dev/sessions/abc",
      })
    );
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "22", name: "In Review" }],
    });
    jiraTransitionIssueMock.mockRejectedValue(new Error("transition failed"));

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-3",
      expect.objectContaining({
        status: "succeeded",
        pr_url: "https://github.com/org/repo/pull/123",
        session_link: "https://warp.dev/sessions/abc",
      })
    );
    expect(jiraTransitionIssueMock).toHaveBeenCalledWith("HYDI-3", "22");
    expect(warnSpy).toHaveBeenCalledWith(
      "[monitor] Failed to transition HYDI-3 to In Review:",
      expect.any(Error)
    );
  });

  it("still marks SUCCEEDED runs when no In Review transition exists", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-4",
          status: "running",
          run_id: "run_4",
          project_key: "HYDI",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(
      makeOzRun({
        state: "SUCCEEDED",
        artifacts: [],
      })
    );
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "44", name: "Something Else" }],
    });

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-4",
      expect.objectContaining({ status: "succeeded" })
    );
    expect(jiraTransitionIssueMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("marks FAILED and ERROR runs as failed and uses fallback error text", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-5",
          status: "running",
          run_id: "run_5",
        }),
        makeDispatchRun({
          ticket_key: "HYDI-6",
          status: "running",
          run_id: "run_6",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock
      .mockResolvedValueOnce(
        makeOzRun({
          state: "FAILED",
          status_message: { message: "Execution failed" },
        })
      )
      .mockResolvedValueOnce(
        makeOzRun({
          state: "ERROR",
          status_message: undefined,
        })
      );

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-5",
      expect.objectContaining({
        status: "failed",
        error: "Execution failed",
      })
    );
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-6",
      expect.objectContaining({
        status: "failed",
        error: "Run ended with state: ERROR",
      })
    );
  });

  it("marks CANCELLED runs as stale with cancellation message", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-7",
          status: "running",
          run_id: "run_7",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(makeOzRun({ state: "CANCELLED" }));

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-7",
      expect.objectContaining({
        status: "stale",
        error: "Run was cancelled externally.",
      })
    );
  });

  it("leaves INPROGRESS runs alone when within max duration", async () => {
    const freshSpawnedAt = new Date(Date.now() - 30 * 60 * 1000);
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-8",
          status: "running",
          run_id: "run_8",
          spawned_at: freshSpawnedAt,
          session_link: "https://warp.dev/run/run_8",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(makeOzRun({ state: "INPROGRESS" }));

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(ozCancelMock).not.toHaveBeenCalled();
    expect(updateRunStatusMock).not.toHaveBeenCalled();
  });

  it("backfills session_link for INPROGRESS runs when missing", async () => {
    const freshSpawnedAt = new Date(Date.now() - 30 * 60 * 1000);
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-14",
          status: "running",
          run_id: "run_14",
          spawned_at: freshSpawnedAt,
          session_link: null,
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(
      makeOzRun({
        state: "INPROGRESS",
        session_link: "https://warp.dev/run/run_14",
      })
    );

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledTimes(1);
    expect(updateRunStatusMock).toHaveBeenCalledWith("HYDI-14", {
      session_link: "https://warp.dev/run/run_14",
    });
  });

  it("backfills session_link for BLOCKED runs when missing", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-15",
          status: "running",
          run_id: "run_15",
          session_link: null,
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(
      makeOzRun({
        state: "BLOCKED",
        session_link: "https://warp.dev/run/run_15",
      })
    );

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledTimes(1);
    expect(updateRunStatusMock).toHaveBeenCalledWith("HYDI-15", {
      session_link: "https://warp.dev/run/run_15",
    });
  });

  it("does not backfill session_link when Oz has not exposed one yet", async () => {
    const freshSpawnedAt = new Date(Date.now() - 30 * 60 * 1000);
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-16",
          status: "running",
          run_id: "run_16",
          spawned_at: freshSpawnedAt,
          session_link: null,
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(
      makeOzRun({ state: "INPROGRESS", session_link: null })
    );

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(updateRunStatusMock).not.toHaveBeenCalled();
  });

  it("does not re-write session_link when already stored", async () => {
    const freshSpawnedAt = new Date(Date.now() - 30 * 60 * 1000);
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-17",
          status: "running",
          run_id: "run_17",
          spawned_at: freshSpawnedAt,
          session_link: "https://warp.dev/run/run_17",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(
      makeOzRun({
        state: "INPROGRESS",
        session_link: "https://warp.dev/run/run_17",
      })
    );

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(updateRunStatusMock).not.toHaveBeenCalled();
  });

  it("marks stale and tolerates cancel errors for overlong INPROGRESS runs", async () => {
    const oldSpawnedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-9",
          status: "running",
          run_id: "run_9",
          spawned_at: oldSpawnedAt,
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(makeOzRun({ state: "INPROGRESS" }));
    ozCancelMock.mockRejectedValue(new Error("already finished"));

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(ozCancelMock).toHaveBeenCalledWith("run_9");
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-9",
      expect.objectContaining({
        status: "stale",
        error: "Run exceeded max duration of 2h.",
      })
    );
  });

  it("logs BLOCKED runs and leaves them unchanged", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-10",
          status: "running",
          run_id: "run_10",
          session_link: "https://warp.dev/run/run_10",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(makeOzRun({ state: "BLOCKED" }));

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(logSpy).toHaveBeenCalledWith(
      "[monitor] HYDI-10 is in state BLOCKED, waiting."
    );
    expect(updateRunStatusMock).not.toHaveBeenCalled();
  });

  it("continues to next run when retrieve throws", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-11",
          status: "running",
          run_id: "run_11",
        }),
        makeDispatchRun({
          ticket_key: "HYDI-12",
          status: "running",
          run_id: "run_12",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(makeOzRun({ state: "CANCELLED" }));

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(errorSpy).toHaveBeenCalledWith(
      "[monitor] Error checking run for HYDI-11:",
      expect.any(Error)
    );
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-12",
      expect.objectContaining({ status: "stale" })
    );
  });

  it("returns immediately from merged-PR sweep when no succeeded runs exist", async () => {
    getRunsByStatusMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(githubPullGetMock).not.toHaveBeenCalled();
  });

  it("skips succeeded runs with no pr_url", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-13",
          status: "succeeded",
          pr_url: null,
        }),
      ]);

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(jiraGetIssueMock).not.toHaveBeenCalled();
    expect(githubPullGetMock).not.toHaveBeenCalled();
  });

  it("reconciles PR display state when Jira issue is already done without transitioning", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-14",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/14",
        }),
      ]);
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "done" } } },
    });
    githubPullGetMock.mockResolvedValue({
      data: {
        merged_at: "2026-05-01T00:00:00.000Z",
        mergeable_state: "clean",
        mergeable: true,
        state: "closed",
        draft: false,
      },
    });

    const { checkRuns } = await importMonitor();
    await checkRuns();

    // Backfill/reconcile still runs even when the Jira issue is already done.
    expect(githubPullGetMock).toHaveBeenCalled();
    expect(updateRunStatusMock).toHaveBeenCalledWith("HYDI-14", {
      pr_has_conflicts: false,
      pr_display_state: "merged",
    });
    // ...but the Jira transition is gated on the Done check.
    expect(jiraTransitionIssueMock).not.toHaveBeenCalled();
  });

  it("skips the GitHub PR lookup for succeeded runs already in a terminal PR display state", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-30",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/30",
          pr_display_state: "merged",
        }),
        makeDispatchRun({
          ticket_key: "HYDI-31",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/31",
          pr_display_state: "closed",
        }),
      ]);

    const { checkRuns } = await importMonitor();
    await checkRuns();

    // Terminal-state PRs must not be re-fetched or re-written on every sweep.
    expect(githubPullGetMock).not.toHaveBeenCalled();
    expect(updateRunStatusMock).not.toHaveBeenCalled();
    expect(jiraGetIssueMock).not.toHaveBeenCalled();
  });

  it("warns and skips when succeeded run has unparsable PR URL", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-15",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/issues/15",
        }),
      ]);
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "in-progress" } } },
    });

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(warnSpy).toHaveBeenCalledWith(
      "[monitor] Could not parse GitHub PR URL for HYDI-15: https://github.com/org/repo/issues/15"
    );
    expect(githubPullGetMock).not.toHaveBeenCalled();
  });

  it("updates pr_has_conflicts and does not transition Jira when PR is not merged", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-16",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/16",
        }),
      ]);
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "in-progress" } } },
    });
    githubPullGetMock.mockResolvedValue({
      data: {
        merged_at: null,
        mergeable_state: "dirty",
        mergeable: false,
        state: "open",
        draft: false,
      },
    });

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith("HYDI-16", {
      pr_has_conflicts: true,
      pr_display_state: "open",
    });
    expect(jiraTransitionIssueMock).not.toHaveBeenCalled();
  });

  it("reconciles pr_display_state as closed for a closed, unmerged PR", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-22",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/22",
        }),
      ]);
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "in-progress" } } },
    });
    githubPullGetMock.mockResolvedValue({
      data: {
        merged_at: null,
        mergeable_state: "clean",
        mergeable: true,
        state: "closed",
        draft: false,
      },
    });

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith("HYDI-22", {
      pr_has_conflicts: false,
      pr_display_state: "closed",
    });
    expect(jiraTransitionIssueMock).not.toHaveBeenCalled();
  });

  it("transitions issue to Done when succeeded PR is merged", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-17",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/17",
        }),
      ]);
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "in-progress" } } },
    });
    githubPullGetMock.mockResolvedValue({
      data: {
        merged_at: "2026-05-01T00:00:00.000Z",
        mergeable_state: "clean",
        mergeable: true,
        state: "closed",
        draft: false,
      },
    });
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "200", name: "Done" }],
    });
    getRunsBlockedByMock.mockResolvedValue([]);

    const { checkRuns } = await importMonitor();
    await checkRuns();
    expect(updateRunStatusMock).toHaveBeenCalledWith("HYDI-17", {
      pr_has_conflicts: false,
      pr_display_state: "merged",
    });

    expect(jiraTransitionIssueMock).toHaveBeenCalledWith("HYDI-17", "200");
  });

  it("transitions to custom Done column name when configured", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-21",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/21",
          project_key: "HYDI",
        }),
      ]);
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "in-progress" } } },
    });
    githubPullGetMock.mockResolvedValue({
      data: {
        merged_at: "2026-05-01T00:00:00.000Z",
        mergeable_state: "clean",
        mergeable: true,
        state: "closed",
        draft: false,
      },
    });
    getProjectConfigMock.mockResolvedValue(
      makeProjectConfig({ done_column_name: "Completed" })
    );
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [
        { id: "201", name: "Done" },
        { id: "202", name: "Completed" },
      ],
    });
    getRunsBlockedByMock.mockResolvedValue([]);

    const { checkRuns } = await importMonitor();
    await checkRuns();

    // Should use the configured "Completed" transition, not the hard-coded "Done"
    expect(jiraTransitionIssueMock).toHaveBeenCalledWith("HYDI-21", "202");
  });

  it("warns without transitioning when no Done transition is available", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-18",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/18",
        }),
      ]);
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "in-progress" } } },
    });
    githubPullGetMock.mockResolvedValue({
      data: {
        merged_at: "2026-05-01T00:00:00.000Z",
        mergeable_state: "clean",
        mergeable: true,
        state: "closed",
        draft: false,
      },
    });
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "201", name: "QA" }],
    });

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(warnSpy).toHaveBeenCalledWith(
      "[monitor] No Done transition found for HYDI-18"
    );
    expect(jiraTransitionIssueMock).not.toHaveBeenCalled();
  });

  it("catches GitHub errors during merged-PR sweep and continues to next run", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-19",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/19",
        }),
        makeDispatchRun({
          ticket_key: "HYDI-20",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/20",
        }),
      ]);
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "in-progress" } } },
    });
    githubPullGetMock
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce({
        data: {
          merged_at: null,
          mergeable_state: "clean",
          mergeable: true,
          state: "open",
          draft: true,
        },
      });

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(warnSpy).toHaveBeenCalledWith(
      "[monitor] Failed to process merged PR for HYDI-19:",
      expect.any(Error)
    );
    expect(updateRunStatusMock).toHaveBeenCalledWith("HYDI-20", {
      pr_has_conflicts: false,
      pr_display_state: "draft",
    });
  });
});

describe("reconcilePrActionStates", () => {
  it("persists review/revision flags resolved from workflow runs for active PRs", async () => {
    getRunsWithActivePrMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-90",
        project_key: "HYDI",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/90",
        pr_review_running: null,
        pr_revision_running: null,
      }),
    ]);
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    listWorkflowRunsForRepoMock.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            name: "Oz PR Review Commenting",
            status: "in_progress",
            pull_requests: [{ number: 90 }],
          },
        ],
      },
    });

    const { reconcilePrActionStates } = await importMonitor();
    await reconcilePrActionStates();

    expect(updateRunStatusMock).toHaveBeenCalledWith("HYDI-90", {
      pr_review_running: true,
      pr_revision_running: false,
    });
  });

  it("does not write when the resolved flags are unchanged", async () => {
    getRunsWithActivePrMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-91",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/91",
        pr_review_running: false,
        pr_revision_running: false,
      }),
    ]);
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [] } });

    const { reconcilePrActionStates } = await importMonitor();
    await reconcilePrActionStates();

    expect(updateRunStatusMock).not.toHaveBeenCalled();
  });

  it("fetches workflow runs once per repo when multiple PRs share it", async () => {
    getRunsWithActivePrMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-1",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/1",
        pr_review_running: false,
        pr_revision_running: false,
      }),
      makeDispatchRun({
        ticket_key: "HYDI-2",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/2",
        pr_review_running: false,
        pr_revision_running: false,
      }),
    ]);
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [] } });

    const { reconcilePrActionStates } = await importMonitor();
    await reconcilePrActionStates();

    expect(listWorkflowRunsForRepoMock).toHaveBeenCalledTimes(1);
  });

  it("fetches workflow runs separately per token when two projects share a repo", async () => {
    getRunsWithActivePrMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-10",
        project_key: "HYDI",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/10",
        pr_review_running: false,
        pr_revision_running: false,
      }),
      makeDispatchRun({
        ticket_key: "TEST-11",
        project_key: "TEST",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/11",
        pr_review_running: false,
        pr_revision_running: false,
      }),
    ]);
    getProjectConfigMock.mockImplementation(async (key: string) =>
      key === "HYDI"
        ? makeProjectConfig({ project_key: "HYDI", github_pat: "token-hydi" })
        : makeProjectConfig({ project_key: "TEST", github_pat: "token-test" })
    );
    listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [] } });

    const { reconcilePrActionStates } = await importMonitor();
    await reconcilePrActionStates();

    // Same owner/repo but different project tokens => two credential boundaries
    // => two separate fetches. This guards the token-isolation grouping key.
    expect(listWorkflowRunsForRepoMock).toHaveBeenCalledTimes(2);
  });

  it("writes a definite false over a null flag on the first pass", async () => {
    getRunsWithActivePrMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-92",
        status: "succeeded",
        pr_url: "https://github.com/warp/hyper-dispatch/pull/92",
        pr_review_running: null,
        pr_revision_running: null,
      }),
    ]);
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [] } });

    const { reconcilePrActionStates } = await importMonitor();
    await reconcilePrActionStates();

    expect(updateRunStatusMock).toHaveBeenCalledWith("HYDI-92", {
      pr_review_running: false,
      pr_revision_running: false,
    });
  });

  it("logs rejected repo groups without blocking the others", async () => {
    getRunsWithActivePrMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-A",
        project_key: "HYDI",
        status: "succeeded",
        pr_url: "https://github.com/warp/repo-a/pull/1",
        pr_review_running: null,
        pr_revision_running: null,
      }),
      makeDispatchRun({
        ticket_key: "HYDI-B",
        project_key: "HYDI",
        status: "succeeded",
        pr_url: "https://github.com/warp/repo-b/pull/2",
        pr_review_running: null,
        pr_revision_running: null,
      }),
    ]);
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [] } });
    // One repo group's DB write fails; the other must still be processed, and
    // the rejection must be logged (not silently swallowed by allSettled).
    updateRunStatusMock.mockImplementation(async (ticketKey: string) => {
      if (ticketKey === "HYDI-A") throw new Error("db down");
      return undefined;
    });

    const { reconcilePrActionStates } = await importMonitor();
    await reconcilePrActionStates();

    expect(errorSpy).toHaveBeenCalledWith(
      "[monitor] reconcilePrActionStates failed for a repo group:",
      expect.any(Error)
    );
    // Both groups were attempted despite one failing.
    expect(updateRunStatusMock).toHaveBeenCalledTimes(2);
  });
});
