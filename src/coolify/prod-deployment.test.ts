import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatchRun } from "../test/fixtures.js";

const githubPullGetMock = vi.fn();

vi.mock("../github/octokit.js", () => ({
  createGithubClient: () => ({
    pulls: {
      get: githubPullGetMock,
    },
  }),
}));

describe("annotateRunsWithProdDeploymentStatus", () => {
  const originalCoolifyBaseUrl = process.env.COOLIFY_BASE_URL;
  const originalCoolifyToken = process.env.COOLIFY_API_TOKEN;
  const originalCoolifyAppUuid = process.env.COOLIFY_PRODUCTION_APP_UUID;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    githubPullGetMock.mockReset();
    delete process.env.COOLIFY_BASE_URL;
    delete process.env.COOLIFY_API_TOKEN;
    delete process.env.COOLIFY_PRODUCTION_APP_UUID;
  });

  afterEach(() => {
    if (originalCoolifyBaseUrl == null) {
      delete process.env.COOLIFY_BASE_URL;
    } else {
      process.env.COOLIFY_BASE_URL = originalCoolifyBaseUrl;
    }
    if (originalCoolifyToken == null) {
      delete process.env.COOLIFY_API_TOKEN;
    } else {
      process.env.COOLIFY_API_TOKEN = originalCoolifyToken;
    }
    if (originalCoolifyAppUuid == null) {
      delete process.env.COOLIFY_PRODUCTION_APP_UUID;
    } else {
      process.env.COOLIFY_PRODUCTION_APP_UUID = originalCoolifyAppUuid;
    }
  });

  it("returns unknown deployment status when Coolify is not configured", async () => {
    const { annotateRunsWithProdDeploymentStatus } = await import(
      "./prod-deployment.js"
    );

    const result = await annotateRunsWithProdDeploymentStatus([makeDispatchRun()]);
    expect(result[0]?.deployed_to_prod).toBeNull();
  });

  it("marks run as deployed when PR merge commit exists in successful Coolify deployments", async () => {
    process.env.COOLIFY_BASE_URL = "https://coolify.example.com";
    process.env.COOLIFY_API_TOKEN = "coolify-token";
    process.env.COOLIFY_PRODUCTION_APP_UUID = "app-123";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        deployments: [
          { commit: "abc123", status: "finished" },
          { commit: "def456", status: "failed" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    githubPullGetMock.mockResolvedValue({
      data: { merge_commit_sha: "abc123" },
    });

    const { annotateRunsWithProdDeploymentStatus } = await import(
      "./prod-deployment.js"
    );

    const run = makeDispatchRun({
      ticket_key: "HYDI-37",
      pr_url: "https://github.com/hyperbolic-aps/hyper-dispatch/pull/37",
    });
    const result = await annotateRunsWithProdDeploymentStatus([run]);

    expect(result[0]?.deployed_to_prod).toBe(true);
  });

  it("marks runs with no PR as not deployed when Coolify integration is enabled", async () => {
    process.env.COOLIFY_BASE_URL = "https://coolify.example.com";
    process.env.COOLIFY_API_TOKEN = "coolify-token";
    process.env.COOLIFY_PRODUCTION_APP_UUID = "app-123";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ deployments: [] }),
      })
    );

    const { annotateRunsWithProdDeploymentStatus } = await import(
      "./prod-deployment.js"
    );

    const result = await annotateRunsWithProdDeploymentStatus([makeDispatchRun()]);
    expect(result[0]?.deployed_to_prod).toBe(false);
  });

  it("returns unknown deployment status when Coolify request fails", async () => {
    process.env.COOLIFY_BASE_URL = "https://coolify.example.com";
    process.env.COOLIFY_API_TOKEN = "coolify-token";
    process.env.COOLIFY_PRODUCTION_APP_UUID = "app-123";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })
    );

    const { annotateRunsWithProdDeploymentStatus } = await import(
      "./prod-deployment.js"
    );
    const result = await annotateRunsWithProdDeploymentStatus([
      makeDispatchRun({
        ticket_key: "HYDI-37",
        pr_url: "https://github.com/hyperbolic-aps/hyper-dispatch/pull/37",
      }),
    ]);
    expect(result[0]?.deployed_to_prod).toBeNull();
  });
});
