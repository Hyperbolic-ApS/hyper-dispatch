import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatchRun, makeOzRun, makeProjectConfig } from "../test/fixtures.js";

const {
  getRunsByStatusMock,
  updateRunStatusMock,
  getProjectConfigMock,
  jiraGetTransitionsMock,
  jiraTransitionIssueMock,
  jiraAddCommentToIssueMock,
  ozRetrieveMock,
  ozApiConstructorMock,
} = vi.hoisted(() => ({
  getRunsByStatusMock: vi.fn(),
  updateRunStatusMock: vi.fn(),
  getProjectConfigMock: vi.fn(),
  jiraGetTransitionsMock: vi.fn(),
  jiraTransitionIssueMock: vi.fn(),
  jiraAddCommentToIssueMock: vi.fn(),
  ozRetrieveMock: vi.fn(),
  ozApiConstructorMock: vi.fn(),
}));

vi.mock("../config/env.js", () => ({
  env: {
    WARP_API_KEY: "test-key",
    GITHUB_TOKEN: "gh-token",
    MAX_RUN_DURATION_HOURS: 2,
  },
  resolveProjectTokens: (
    config: { github_pat?: string | null; jira_api_token?: string | null; oz_api_key?: string | null }
  ) => ({
    githubToken: config.github_pat ?? "gh-token",
    jiraApiToken: config.jira_api_token ?? "jira-token",
    ozApiKey: config.oz_api_key ?? "test-key",
  }),
}));

vi.mock("../db/queries.js", () => ({
  getRunsByStatus: getRunsByStatusMock,
  updateRunStatus: updateRunStatusMock,
  getProjectConfig: getProjectConfigMock,
}));

vi.mock("../jira/client.js", () => ({
  getTransitions: jiraGetTransitionsMock,
  transitionIssue: jiraTransitionIssueMock,
  addCommentToIssue: jiraAddCommentToIssueMock,
}));

vi.mock("oz-agent-sdk", () => ({
  default: class MockOzApi {
    constructor(options: unknown) {
      ozApiConstructorMock(options);
    }
    agent = {
      runs: {
        retrieve: ozRetrieveMock,
      },
    };
  },
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    pulls = {
      get: vi.fn(),
    };
  },
}));

async function importMonitor() {
  return import("./monitor.js");
}

let fetchSpy: any;
let warnSpy: any;

beforeEach(() => {
  vi.resetModules();
  fetchSpy = vi.spyOn(globalThis, "fetch");
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  getRunsByStatusMock.mockReset();
  updateRunStatusMock.mockReset();
  getProjectConfigMock.mockReset();
  jiraGetTransitionsMock.mockReset();
  jiraTransitionIssueMock.mockReset();
  jiraAddCommentToIssueMock.mockReset();
  ozRetrieveMock.mockReset();
  ozApiConstructorMock.mockReset();
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("checkRuns Jira PR comment", () => {
  it("adds a Jira comment with the PR URL after a successful run", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-77",
          status: "running",
          run_id: "run_77",
          project_key: "HYDI",
        }),
      ])
      .mockResolvedValueOnce([]);
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    ozRetrieveMock.mockResolvedValue(
      makeOzRun({
        state: "SUCCEEDED",
        artifacts: [
          {
            artifact_type: "PULL_REQUEST",
            data: { url: "https://github.com/org/repo/pull/77" },
          },
        ],
      })
    );
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "42", name: "In Review" }],
    });

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(jiraAddCommentToIssueMock).toHaveBeenCalledWith(
      "HYDI-77",
      "Opened pull request: https://github.com/org/repo/pull/77"
    );
    expect(jiraTransitionIssueMock).toHaveBeenCalledWith("HYDI-77", "42");
  });

  it("warns and continues when posting the Jira PR comment fails", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-77",
          status: "running",
          run_id: "run_77",
          project_key: "HYDI",
        }),
      ])
      .mockResolvedValueOnce([]);
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    ozRetrieveMock.mockResolvedValue(
      makeOzRun({
        state: "SUCCEEDED",
        artifacts: [
          {
            artifact_type: "PULL_REQUEST",
            data: { url: "https://github.com/org/repo/pull/77" },
          },
        ],
      })
    );
    jiraAddCommentToIssueMock.mockRejectedValue(new Error("jira down"));
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "42", name: "In Review" }],
    });

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(warnSpy).toHaveBeenCalledWith(
      "[monitor] Failed to add PR comment for HYDI-77:",
      expect.any(Error)
    );
    expect(updateRunStatusMock).toHaveBeenCalledWith(
      "HYDI-77",
      expect.objectContaining({
        status: "succeeded",
      })
    );
  });

  it("does not add a Jira comment when no PR URL is available", async () => {
    getRunsByStatusMock
      .mockResolvedValueOnce([
        makeDispatchRun({
          ticket_key: "HYDI-77",
          status: "running",
          run_id: "run_77",
          project_key: "HYDI",
        }),
      ])
      .mockResolvedValueOnce([]);
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    ozRetrieveMock.mockResolvedValue(
      makeOzRun({
        state: "SUCCEEDED",
        artifacts: [],
      })
    );
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "42", name: "In Review" }],
    });

    const { checkRuns } = await importMonitor();
    await checkRuns();

    expect(jiraAddCommentToIssueMock).not.toHaveBeenCalled();
  });
});
