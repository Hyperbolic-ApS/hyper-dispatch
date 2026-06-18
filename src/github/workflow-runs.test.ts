import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  computePrActionState,
  getRepoWorkflowRuns,
  __clearWorkflowRunsCache,
  REVIEW_WORKFLOW_NAME,
  REVISION_WORKFLOW_NAME,
} from "./workflow-runs.js";

describe("computePrActionState", () => {
  it("flags review running when the review workflow is in-flight for the PR number", () => {
    const state = computePrActionState(
      [
        {
          name: REVIEW_WORKFLOW_NAME,
          status: "in_progress",
          pull_requests: [{ number: 42 }],
        },
      ],
      { pullNumber: 42, branchName: "agent/HYDI-42" }
    );
    expect(state).toEqual({ reviewRunning: true, revisionRunning: false });
  });

  it("flags revision running by head_branch when pull_requests is empty", () => {
    const state = computePrActionState(
      [
        {
          name: REVISION_WORKFLOW_NAME,
          status: "queued",
          pull_requests: [],
          head_branch: "agent/HYDI-7",
        },
      ],
      { pullNumber: 7, branchName: "agent/HYDI-7" }
    );
    expect(state).toEqual({ reviewRunning: false, revisionRunning: true });
  });

  it("ignores completed workflow runs", () => {
    const state = computePrActionState(
      [
        {
          name: REVIEW_WORKFLOW_NAME,
          status: "completed",
          pull_requests: [{ number: 42 }],
        },
      ],
      { pullNumber: 42, branchName: "agent/HYDI-42" }
    );
    expect(state).toEqual({ reviewRunning: false, revisionRunning: false });
  });

  it("ignores in-flight runs that belong to a different PR", () => {
    const state = computePrActionState(
      [
        {
          name: REVIEW_WORKFLOW_NAME,
          status: "in_progress",
          pull_requests: [{ number: 99 }],
          head_branch: "agent/OTHER-1",
        },
      ],
      { pullNumber: 42, branchName: "agent/HYDI-42" }
    );
    expect(state).toEqual({ reviewRunning: false, revisionRunning: false });
  });

  it("flags both review and revision when both are in-flight for the PR", () => {
    const state = computePrActionState(
      [
        {
          name: REVIEW_WORKFLOW_NAME,
          status: "in_progress",
          pull_requests: [{ number: 42 }],
        },
        {
          name: REVISION_WORKFLOW_NAME,
          status: "requested",
          pull_requests: [{ number: 42 }],
        },
      ],
      { pullNumber: 42, branchName: "agent/HYDI-42" }
    );
    expect(state).toEqual({ reviewRunning: true, revisionRunning: true });
  });
});

describe("getRepoWorkflowRuns", () => {
  beforeEach(() => {
    __clearWorkflowRunsCache();
  });

  function fullPageClient(): {
    client: Octokit;
    listWorkflowRunsForRepo: ReturnType<typeof vi.fn>;
  } {
    // Always returns a full page (100) so a naive walk would paginate forever.
    const listWorkflowRunsForRepo = vi.fn(
      async ({ page }: { owner: string; repo: string; per_page: number; page: number }) => ({
        data: {
          workflow_runs: Array.from({ length: 100 }, (_, i) => ({
            name: "x",
            status: "completed",
            pull_requests: [{ number: page * 1000 + i }],
          })),
        },
      })
    );
    const client = { actions: { listWorkflowRunsForRepo } } as unknown as Octokit;
    return { client, listWorkflowRunsForRepo };
  }

  it("caps pagination at the page limit instead of walking full history", async () => {
    const { client, listWorkflowRunsForRepo } = fullPageClient();

    const runs = await getRepoWorkflowRuns(
      client,
      "warp",
      "hyper-dispatch",
      "warp/hyper-dispatch::tok"
    );

    // 3-page cap × 100 runs/page.
    expect(listWorkflowRunsForRepo).toHaveBeenCalledTimes(3);
    expect(runs).toHaveLength(300);
    expect(listWorkflowRunsForRepo).toHaveBeenLastCalledWith(
      expect.objectContaining({ owner: "warp", repo: "hyper-dispatch", per_page: 100, page: 3 })
    );
  });

  it("stops early when a page is not full", async () => {
    const listWorkflowRunsForRepo = vi
      .fn()
      .mockResolvedValueOnce({
        data: { workflow_runs: Array.from({ length: 100 }, () => ({ name: "x", status: "completed" })) },
      })
      .mockResolvedValueOnce({ data: { workflow_runs: [{ name: "x", status: "completed" }] } });
    const client = { actions: { listWorkflowRunsForRepo } } as unknown as Octokit;

    const runs = await getRepoWorkflowRuns(client, "o", "r", "o/r::tok");

    expect(listWorkflowRunsForRepo).toHaveBeenCalledTimes(2);
    expect(runs).toHaveLength(101);
  });

  it("serves cached results within the TTL without re-fetching", async () => {
    const listWorkflowRunsForRepo = vi
      .fn()
      .mockResolvedValue({ data: { workflow_runs: [{ name: "x", status: "completed" }] } });
    const client = { actions: { listWorkflowRunsForRepo } } as unknown as Octokit;

    await getRepoWorkflowRuns(client, "o", "r", "o/r::tok");
    await getRepoWorkflowRuns(client, "o", "r", "o/r::tok");

    expect(listWorkflowRunsForRepo).toHaveBeenCalledTimes(1);
  });
});
