import type { Octokit } from "@octokit/rest";
import { createGithubClient } from "./octokit.js";

export function parseGithubPullRequestUrl(
  prUrl: string
): { owner: string; repo: string; pullNumber: number } | null {
  try {
    const parsedUrl = new URL(prUrl);
    const parts = parsedUrl.pathname.split("/").filter(Boolean);
    if (parts.length < 4) return null;

    const [owner, repo, type, pullNumberRaw] = parts;
    if (!owner || !repo || type !== "pull" || !pullNumberRaw) return null;

    const pullNumber = Number.parseInt(pullNumberRaw, 10);
    if (!Number.isFinite(pullNumber)) return null;

    return { owner, repo, pullNumber };
  } catch {
    return null;
  }
}

export async function getPullRequestState(
  prUrl: string,
  githubToken: string
): Promise<"open" | "closed"> {
  const parsed = parseGithubPullRequestUrl(prUrl);
  if (!parsed) {
    throw new Error("Invalid GitHub pull request URL.");
  }

  const github = createGithubClient(githubToken);
  const { data: pullRequest } = await github.pulls.get({
    owner: parsed.owner,
    repo: parsed.repo,
    pull_number: parsed.pullNumber,
  });
  return pullRequest.state;
}

export type PullRequestDisplayState = "open" | "draft" | "merged" | "closed";
export function derivePullRequestDisplayState(pullRequest: {
  merged_at: string | null;
  state: "open" | "closed";
  draft?: boolean;
}): PullRequestDisplayState {
  if (pullRequest.merged_at) return "merged";
  if (pullRequest.state === "open" && pullRequest.draft) return "draft";
  if (pullRequest.state === "open") return "open";
  return "closed";
}

// GitHub's REST "Update a pull request" endpoint cannot change the `draft`
// field, so a draft PR can only be marked ready for review through the GraphQL
// `markPullRequestReadyForReview` mutation (the same capability as `gh pr
// ready`). It takes the PR's GraphQL node ID (`pull_request.node_id`).
const MARK_READY_FOR_REVIEW_MUTATION = `
  mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      pullRequest {
        id
        isDraft
      }
    }
  }
`;

/**
 * Mark a draft pull request ready for review via the GraphQL mutation.
 * Throws when the PR is not in the draft state (e.g. it is already ready), so
 * callers that treat readiness as best-effort should catch and reconcile.
 */
export async function markPullRequestReadyForReview(
  github: Octokit,
  pullRequestNodeId: string
): Promise<void> {
  await github.graphql(MARK_READY_FOR_REVIEW_MUTATION, {
    pullRequestId: pullRequestNodeId,
  });
}
