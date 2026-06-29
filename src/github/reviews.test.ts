import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { upsertStickyComment, dismissSupersededReviews } from "./reviews.js";

const pr = { owner: "warp", repo: "hyper-dispatch", pullNumber: 42 };

function mockOctokitWithComment(existingBody: string | null): Octokit {
  const listComments = vi.fn();
  const updateComment = vi.fn().mockResolvedValue({});
  const createComment = vi.fn().mockResolvedValue({});
  const comments = existingBody !== null ? [{ id: 1, body: existingBody }] : [];
  const paginate = vi.fn().mockResolvedValue(comments);
  return {
    paginate,
    rest: {
      issues: { listComments, updateComment, createComment },
    },
  } as unknown as Octokit;
}

describe("upsertStickyComment", () => {
  it("edits the existing sticky comment when marker present", async () => {
    const octokit = mockOctokitWithComment("<!-- review-ledger:start -->old");
    await upsertStickyComment(octokit, pr, "<!-- review-ledger:start -->", "new");
    expect(octokit.rest.issues.updateComment).toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("creates a sticky comment when none exists", async () => {
    const octokit = mockOctokitWithComment(null);
    await upsertStickyComment(octokit, pr, "<!-- review-ledger:start -->", "new");
    expect(octokit.rest.issues.createComment).toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });
});

describe("dismissSupersededReviews", () => {
  function mockOctokitWithReviews(
    reviews: Array<{ id: number; state: string }>
  ): Octokit {
    const listReviews = vi.fn();
    const dismissReview = vi.fn().mockResolvedValue({});
    const paginate = vi.fn().mockResolvedValue(reviews);
    return {
      paginate,
      rest: {
        pulls: { listReviews, dismissReview },
      },
    } as unknown as Octokit;
  }

  it("dismisses only CHANGES_REQUESTED reviews that are not the kept id", async () => {
    const reviews = [
      { id: 1, state: "CHANGES_REQUESTED" }, // should be dismissed
      { id: 2, state: "CHANGES_REQUESTED" }, // keepReviewId — should NOT be dismissed
      { id: 3, state: "APPROVED" },           // should NOT be dismissed
      { id: 4, state: "COMMENTED" },          // should NOT be dismissed
    ];
    const octokit = mockOctokitWithReviews(reviews);
    await dismissSupersededReviews(octokit, pr, 2);
    expect(octokit.rest.pulls.dismissReview).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({ review_id: 1 })
    );
  });
});
