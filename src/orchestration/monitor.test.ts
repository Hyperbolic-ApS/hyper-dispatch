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

import { extractPrUrl, parseGithubPullRequestUrl } from "./monitor.js";

let fetchSpy: any;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
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
});

describe("parseGithubPullRequestUrl", () => {
  it("parses owner, repo, and pull number for a valid pull URL", () => {
    expect(
      parseGithubPullRequestUrl("https://github.com/warp/hyper-dispatch/pull/123")
    ).toEqual({
      owner: "warp",
      repo: "hyper-dispatch",
      pullNumber: 123,
    });
  });

  it("returns null for a non-pull URL", () => {
    expect(
      parseGithubPullRequestUrl("https://github.com/warp/hyper-dispatch/issues/123")
    ).toBeNull();
  });

  it("returns null when pull number is missing", () => {
    expect(parseGithubPullRequestUrl("https://github.com/warp/hyper-dispatch/pull/")).toBeNull();
  });

  it("returns null when pull number is non-numeric", () => {
    expect(
      parseGithubPullRequestUrl("https://github.com/warp/hyper-dispatch/pull/not-a-number")
    ).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(parseGithubPullRequestUrl("github.com/warp/hyper-dispatch/pull/123")).toBeNull();
  });
});

describe("extractPrUrl", () => {
  it("returns null for undefined or empty artifacts", () => {
    expect(extractPrUrl(undefined)).toBeNull();
    expect(extractPrUrl([])).toBeNull();
  });

  it("returns PR URL when pull-request artifact includes url", () => {
    const artifacts = [
      {
        artifact_type: "PULL_REQUEST",
        data: { url: "https://github.com/warp/hyper-dispatch/pull/456" },
      },
    ] as unknown as ArtifactItem[];

    expect(extractPrUrl(artifacts)).toBe("https://github.com/warp/hyper-dispatch/pull/456");
  });

  it("returns null when pull-request artifact has no url", () => {
    const artifacts = [
      {
        artifact_type: "PULL_REQUEST",
        data: {},
      },
    ] as unknown as ArtifactItem[];

    expect(extractPrUrl(artifacts)).toBeNull();
  });

  it("filters out non-PR artifacts", () => {
    const artifacts = [
      {
        artifact_type: "SESSION_LINK",
        data: { url: "https://warp.dev/run/run_123" },
      },
    ] as unknown as ArtifactItem[];

    expect(extractPrUrl(artifacts)).toBeNull();
  });

  it("returns first matching pull request URL when multiple artifacts exist", () => {
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

    expect(extractPrUrl(artifacts)).toBe("https://github.com/warp/hyper-dispatch/pull/789");
  });

  it("falls back to status message pull request URL when artifacts are missing", () => {
    const statusMessage =
      "Implemented HYDI-33 and opened draft PR https://github.com/warp/hyper-dispatch/pull/456.";

    expect(extractPrUrl(undefined, statusMessage)).toBe(
      "https://github.com/warp/hyper-dispatch/pull/456"
    );
  });

  it("prefers artifact pull request URL over status message fallback", () => {
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

  it("falls back to status message when pull-request artifact URL is invalid", () => {
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
  it("marks succeeded running runs and transitions Jira to In Review", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-1",
          status: "running",
          run_id: "run_1",
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
      })
    );
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "22", name: "In Review" }],
    });
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "in-progress" } } },
    });
    githubPullGetMock.mockResolvedValue({
      data: { merged_at: null, mergeable_state: "clean", mergeable: true },
    });

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-1",
      expect.objectContaining({
        status: "succeeded",
        pr_url: "https://github.com/org/repo/pull/123",
      })
    );
    expect(jiraTransitionIssueMock).toHaveBeenCalledWith("HYDI-1", "22");
  });

  it("marks failed and cancelled Oz runs correctly", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-2",
          status: "running",
          run_id: "run_2",
        }),
        makeDispatchRun({
          ticket_key: "HYDI-3",
          status: "running",
          run_id: "run_3",
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
      .mockResolvedValueOnce(makeOzRun({ state: "CANCELLED" }));

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-2",
      expect.objectContaining({
        status: "failed",
        error: "Execution failed",
      })
    );
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-3",
      expect.objectContaining({
        status: "stale",
        error: "Run was cancelled externally.",
      })
    );
  });

  it("marks long-running in-progress runs as stale and attempts cancel", async () => {
    const oldSpawnedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-4",
          status: "running",
          run_id: "run_4",
          spawned_at: oldSpawnedAt,
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(makeOzRun({ state: "INPROGRESS" }));

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(ozCancelMock).toHaveBeenCalledWith("run_4");
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-4",
      expect.objectContaining({
        status: "stale",
      })
    );
  });

  it("transitions succeeded tickets to done when PR is merged", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-9",
          status: "succeeded",
          pr_url: "https://github.com/org/repo/pull/44",
        }),
      ]);
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "in-progress" } } },
    });
    githubPullGetMock.mockResolvedValue({
      data: { merged_at: "2026-05-01T00:00:00.000Z", mergeable_state: "dirty", mergeable: false },
    });
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "100", name: "Done" }],
    });
    getRunsBlockedByMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-10",
        status: "blocked",
        blocked_by: ["HYDI-9"],
      }),
    ]);
    removeBlockerMock.mockResolvedValue(
      makeDispatchRun({
        ticket_key: "HYDI-10",
        status: "queued",
        blocked_by: [],
      })
    );

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-9",
      expect.objectContaining({ pr_has_conflicts: true })
    );
    expect(jiraTransitionIssueMock).toHaveBeenCalledWith("HYDI-9", "100");
    expect(getRunsBlockedByMock).toHaveBeenCalledWith("HYDI-9");
    expect(removeBlockerMock).toHaveBeenCalledWith("HYDI-10", "HYDI-9");
  });

  it("stores PR URL from status message when PR artifact is missing", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-33",
          status: "running",
          run_id: "run_33",
          project_key: "HYDI",
        }),
      ])
      .mockResolvedValueOnce([]);
    ozRetrieveMock.mockResolvedValue(
      makeOzRun({
        state: "SUCCEEDED",
        status_message: {
          message:
            "Implemented HYDI-33 and opened draft PR https://github.com/org/repo/pull/28.",
        },
        artifacts: [],
      })
    );
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "22", name: "In Review" }],
    });

    const { checkRuns } = await import("./monitor.js");
    await checkRuns();

    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-33",
      expect.objectContaining({
        status: "succeeded",
        pr_url: "https://github.com/org/repo/pull/28",
      })
    );
  });
});
