import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactItem } from "oz-agent-sdk/resources/agent/runs.js";

vi.mock("../config/env.js", () => ({
  env: {
    WARP_API_KEY: "test-key",
    GITHUB_TOKEN: "gh-token",
    MAX_RUN_DURATION_HOURS: 2,
  },
}));

vi.mock("../jira/client.js", () => ({}));
vi.mock("../db/queries.js", () => ({
  getRunsByStatus: vi.fn(),
  updateRunStatus: vi.fn(),
  getProjectConfig: vi.fn(),
}));

import { extractPrUrl, parseGithubPullRequestUrl } from "./monitor.js";
let fetchSpy: any;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
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
});
