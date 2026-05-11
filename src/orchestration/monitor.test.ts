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
  githubPullGetMock,
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
  githubPullGetMock: vi.fn(),
}));

vi.mock("../config/env.js", () => ({
  env: {
    WARP_API_KEY: "test-key",
    GITHUB_TOKEN: "gh-token",
    MAX_RUN_DURATION_HOURS: 2,
  },
}));

vi.mock("../db/queries.js", () => ({
  getRunsByStatus: getRunsByStatusMock,
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
    agent = {
      runs: {
        retrieve: ozRetrieveMock,
        cancel: ozCancelMock,
      },
    };
  },
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    pulls = {
      get: githubPullGetMock,
    };
  },
}));

let fetchSpy: any;
let consoleWarnSpy: any;
let consoleErrorSpy: any;
let consoleLogSpy: any;

beforeEach(() => {
  vi.resetModules();
  fetchSpy = vi.spyOn(globalThis, "fetch");
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

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
  githubPullGetMock.mockReset();
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

describe("parseGithubPullRequestUrl", () => {
  it("parses owner, repo, and pull number for a valid pull URL", async () => {
    const { parseGithubPullRequestUrl } = await import("./monitor.js");
    expect(
      parseGithubPullRequestUrl("https://github.com/warp/hyper-dispatch/pull/123")
    ).toEqual({
      owner: "warp",
      repo: "hyper-dispatch",
      pullNumber: 123,
    });
  });

  it("returns null for a non-pull URL", async () => {
    const { parseGithubPullRequestUrl } = await import("./monitor.js");
    expect(
      parseGithubPullRequestUrl("https://github.com/warp/hyper-dispatch/issues/123")
    ).toBeNull();
  });

  it("returns null when pull number is missing", async () => {
    const { parseGithubPullRequestUrl } = await import("./monitor.js");
    expect(
      parseGithubPullRequestUrl("https://github.com/warp/hyper-dispatch/pull/")
    ).toBeNull();
  });

  it("returns null when pull number is non-numeric", async () => {
    const { parseGithubPullRequestUrl } = await import("./monitor.js");
    expect(
      parseGithubPullRequestUrl(
        "https://github.com/warp/hyper-dispatch/pull/not-a-number"
      )
    ).toBeNull();
  });

  it("returns null for malformed URLs", async () => {
    const { parseGithubPullRequestUrl } = await import("./monitor.js");
    expect(
      parseGithubPullRequestUrl("github.com/warp/hyper-dispatch/pull/123")
    ).toBeNull();
  });
});

describe("extractPrUrl", () => {
  it("returns null for undefined or empty artifacts", async () => {
    const { extractPrUrl } = await import("./monitor.js");
    expect(extractPrUrl(undefined)).toBeNull();
    expect(extractPrUrl([])).toBeNull();
  });

  it("returns PR URL when pull-request artifact includes url", async () => {
    const { extractPrUrl } = await import("./monitor.js");
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
    const { extractPrUrl } = await import("./monitor.js");
    const artifacts = [
      {
        artifact_type: "PULL_REQUEST",
        data: {},
      },
    ] as unknown as ArtifactItem[];

    expect(extractPrUrl(artifacts)).toBeNull();
  });

  it("filters out non-PR artifacts", async () => {
    const { extractPrUrl } = await import("./monitor.js");
    const artifacts = [
      {
        artifact_type: "SESSION_LINK",
        data: { url: "https://warp.dev/run/run_123" },
      },
    ] as unknown as ArtifactItem[];

    expect(extractPrUrl(artifacts)).toBeNull();
  });

  it("returns first matching pull request URL when multiple artifacts exist", async () => {
    const { extractPrUrl } = await import("./monitor.js");
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
    const { extractPrUrl } = await import("./monitor.js");
    const statusMessage =
      "Implemented HYDI-33 and opened draft PR https://github.com/warp/hyper-dispatch/pull/456.";

    expect(extractPrUrl(undefined, statusMessage)).toBe(
      "https://github.com/warp/hyper-dispatch/pull/456"
    );
  });

  it("prefers artifact pull request URL over status message fallback", async () => {
    const { extractPrUrl } = await import("./monitor.js");
    const artifacts = [
      {
        artifact_type: "PULL_REQUEST",
        data: { url: "https://github.com/warp/hyper-dispatch/pull/789" },
      },
    ] as unknown as ArtifactItem[];
    const statusMessage =
      "Opened draft PR https://github.com/warp/hyper-dispatch/pull/456 while running tests.";

    expect(extractPrUrl(artifacts, statusMessage)).toBe(
      "https://github.com/warp/hyper-dispatch/pull/789"
    );
  });

  it("falls back to status message when pull-request artifact URL is invalid", async () => {
    const { extractPrUrl } = await import("./monitor.js");
    const artifacts = [
      {
        artifact_type: "PULL_REQUEST",
        data: { url: "https://github.com/warp/hyper-dispatch/issues/456" },
      },
    ] as unknown as ArtifactItem[];
    const statusMessage =
      "Opened draft PR https://github.com/warp/hyper-dispatch/pull/456 while running tests.";

    expect(extractPrUrl(artifacts, statusMessage)).toBe(
      "https://github.com/warp/hyper-dispatch/pull/456"
    );
  });
});

describe("checkRuns", () => {
  it("does not initialize Oz client when there are no running runs and still executes merged sweep", async () => {
    getRunsByStatusMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(ozRetrieveMock).not.toHaveBeenCalled();
    expect(getRunsByStatusMock).toHaveBeenNthCalledWith(1, "running");
    expect(getRunsByStatusMock).toHaveBeenNthCalledWith(2, "succeeded");
  });

  it("skips runs with null run_id and continues loop", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-A",
          status: "running",
          run_id: null,
        }),
      ])
      .mockResolvedValueOnce([]);

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(ozRetrieveMock).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[monitor] Run for HYDI-34-A has no run_id, skipping."
    );
  });

  it("marks SUCCEEDED runs and tolerates In Review transition errors", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-B",
          status: "running",
          run_id: "run_success",
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
        session_link: "https://warp.dev/run/run_success",
      })
    );
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    jiraGetTransitionsMock.mockRejectedValue(
      new Error("jira transition lookup failed")
    );

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-34-B",
      expect.objectContaining({
        status: "succeeded",
        pr_url: "https://github.com/org/repo/pull/123",
        session_link: "https://warp.dev/run/run_success",
      })
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[monitor] Failed to transition HYDI-34-B to In Review:",
      expect.any(Error)
    );
  });

  it("marks SUCCEEDED runs even when no In Review transition exists", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-C",
          status: "running",
          run_id: "run_success_no_transition",
          project_key: "HYDI",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(makeOzRun({ state: "SUCCEEDED" }));
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "1", name: "In Progress" }],
    });

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-34-C",
      expect.objectContaining({ status: "succeeded" })
    );
    expect(jiraTransitionIssueMock).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("marks FAILED runs with explicit status message", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-D",
          status: "running",
          run_id: "run_failed",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(
      makeOzRun({
        state: "FAILED",
        status_message: { message: "Execution failed loudly" },
      })
    );

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-34-D",
      expect.objectContaining({
        status: "failed",
        error: "Execution failed loudly",
      })
    );
  });

  it("marks ERROR runs with fallback message when status_message is missing", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-E",
          status: "running",
          run_id: "run_error",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(
      makeOzRun({
        state: "ERROR",
        status_message: undefined,
      })
    );

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-34-E",
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
          ticket_key: "HYDI-34-F",
          status: "running",
          run_id: "run_cancelled",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(makeOzRun({ state: "CANCELLED" }));

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-34-F",
      expect.objectContaining({
        status: "stale",
        error: "Run was cancelled externally.",
      })
    );
  });

  it("leaves INPROGRESS runs within max duration unchanged", async () => {
    const recentSpawnedAt = new Date(Date.now() - 60 * 60 * 1000);
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-G",
          status: "running",
          run_id: "run_inprogress_fresh",
          spawned_at: recentSpawnedAt,
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(makeOzRun({ state: "INPROGRESS" }));

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(ozCancelMock).not.toHaveBeenCalled();
    expect(updateRunStatusMock).not.toHaveBeenCalled();
  });

  it("cancels and marks INPROGRESS runs stale when max duration is exceeded", async () => {
    const oldSpawnedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-H",
          status: "running",
          run_id: "run_inprogress_stale",
          spawned_at: oldSpawnedAt,
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(makeOzRun({ state: "INPROGRESS" }));

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(ozCancelMock).toHaveBeenCalledWith("run_inprogress_stale");
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-34-H",
      expect.objectContaining({
        status: "stale",
        error: "Run exceeded max duration of 2h.",
      })
    );
  });

  it("still marks stale when cancel fails for a stale INPROGRESS run", async () => {
    const oldSpawnedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-I",
          status: "running",
          run_id: "run_inprogress_cancel_fails",
          spawned_at: oldSpawnedAt,
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(makeOzRun({ state: "INPROGRESS" }));
    ozCancelMock.mockRejectedValue(new Error("already finished"));

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-34-I",
      expect.objectContaining({
        status: "stale",
      })
    );
  });

  it("logs BLOCKED/unknown states and leaves DB status unchanged", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-J",
          status: "running",
          run_id: "run_blocked",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(makeOzRun({ state: "BLOCKED" }));

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(updateRunStatusMock).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[monitor] HYDI-34-J is in state BLOCKED, waiting."
    );
  });

  it("catches retrieve errors and continues processing subsequent runs", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-K1",
          status: "running",
          run_id: "run_throw",
          project_key: "HYDI",
        }),
        makeDispatchRun({
          ticket_key: "HYDI-34-K2",
          status: "running",
          run_id: "run_succeeds",
          project_key: "HYDI",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock
      .mockRejectedValueOnce(new Error("retrieve failed"))
      .mockResolvedValueOnce(makeOzRun({ state: "SUCCEEDED" }));
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "22", name: "In Review" }],
    });

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[monitor] Error checking run for HYDI-34-K1:",
      expect.any(Error)
    );
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-34-K2",
      expect.objectContaining({ status: "succeeded" })
    );
  });
});

describe("transitionMergedPrsToDone (via checkRuns)", () => {
  it("returns early when no succeeded runs exist and does not call GitHub", async () => {
    getRunsByStatusMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(githubPullGetMock).not.toHaveBeenCalled();
  });

  it("skips succeeded runs without pr_url", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-L",
          status: "succeeded",
          pr_url: null,
        }),
      ]);

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(githubPullGetMock).not.toHaveBeenCalled();
    expect(jiraGetIssueMock).not.toHaveBeenCalled();
  });

  it("skips runs already in done status category without GitHub calls", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-M",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/44",
        }),
      ]);
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "done" } } },
    });

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(githubPullGetMock).not.toHaveBeenCalled();
  });

  it("warns and skips when parseGithubPullRequestUrl returns null", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-N",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/issues/44",
        }),
      ]);
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "in-progress" } } },
    });

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(githubPullGetMock).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[monitor] Could not parse GitHub PR URL for HYDI-34-N: https://github.com/org/repo/issues/44"
    );
  });

  it("updates pr_has_conflicts for unmerged PRs and does not transition Jira", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-O",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/55",
        }),
      ]);
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "in-progress" } } },
    });
    githubPullGetMock.mockResolvedValue({
      data: { merged_at: null, mergeable_state: "dirty", mergeable: false },
    });

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith("HYDI-34-O", {
      pr_has_conflicts: true,
    });
    expect(jiraTransitionIssueMock).not.toHaveBeenCalled();
  });

  it("transitions to Done when PR is merged and Done transition exists", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-P",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/66",
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
      },
    });
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "100", name: "Done" }],
    });
    getRunsBlockedByMock.mockResolvedValue([]);

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(jiraTransitionIssueMock).toHaveBeenCalledWith("HYDI-34-P", "100");
  });

  it("warns and does not transition when no Done transition exists", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-Q",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/77",
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
      },
    });
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "101", name: "In Review" }],
    });

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(jiraTransitionIssueMock).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[monitor] No Done transition found for HYDI-34-Q"
    );
  });

  it("catches GitHub API errors and continues processing later succeeded runs", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-34-R1",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/88",
        }),
        makeDispatchRun({
          ticket_key: "HYDI-34-R2",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/89",
        }),
      ]);
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "in-progress" } } },
    });
    githubPullGetMock
      .mockRejectedValueOnce(new Error("GitHub exploded"))
      .mockResolvedValueOnce({
        data: { merged_at: null, mergeable_state: "clean", mergeable: true },
      });

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[monitor] Failed to process merged PR for HYDI-34-R1:",
      expect.any(Error)
    );
    expect(updateRunStatusMock).toHaveBeenCalledWith("HYDI-34-R2", {
      pr_has_conflicts: false,
    });
  });
});