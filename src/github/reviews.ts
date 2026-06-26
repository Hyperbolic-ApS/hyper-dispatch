import type { Octokit } from "@octokit/rest";

interface PrRef {
  owner: string;
  repo: string;
  pullNumber: number;
}

/**
 * Find an issue comment containing `marker` and update its body, or create a
 * new comment if none exists. Suitable for a "sticky ledger" comment that is
 * updated in-place across multiple review cycles.
 */
export async function upsertStickyComment(
  octokit: Octokit,
  pr: PrRef,
  marker: string,
  body: string
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.pullNumber,
    per_page: 100,
  });
  const existing = comments.find((c) => (c.body ?? "").includes(marker));
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: pr.owner,
      repo: pr.repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.pullNumber,
      body,
    });
  }
}

/**
 * Dismiss all prior `CHANGES_REQUESTED` reviews on the PR except `keepReviewId`.
 * One failed dismissal (e.g. already-dismissed or permission error) does not
 * abort the loop.
 */
export async function dismissSupersededReviews(
  octokit: Octokit,
  pr: PrRef,
  keepReviewId: number
): Promise<void> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pullNumber,
    per_page: 100,
  });
  for (const r of reviews) {
    if (r.id !== keepReviewId && r.state === "CHANGES_REQUESTED") {
      await octokit.rest.pulls
        .dismissReview({
          owner: pr.owner,
          repo: pr.repo,
          pull_number: pr.pullNumber,
          review_id: r.id,
          message: "Superseded by a newer review.",
        })
        .catch(() => {});
    }
  }
}
