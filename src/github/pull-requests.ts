import { Octokit } from "@octokit/rest";

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

  const github = new Octokit({ auth: githubToken });
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

export async function getPullRequestDisplayState(
  prUrl: string,
  githubToken: string
): Promise<PullRequestDisplayState> {
  const parsed = parseGithubPullRequestUrl(prUrl);
  if (!parsed) {
    throw new Error("Invalid GitHub pull request URL.");
  }

  const github = new Octokit({ auth: githubToken });
  const { data: pullRequest } = await github.pulls.get({
    owner: parsed.owner,
    repo: parsed.repo,
    pull_number: parsed.pullNumber,
  });
  return derivePullRequestDisplayState({
    merged_at: pullRequest.merged_at,
    state: pullRequest.state,
    draft: pullRequest.draft,
  });
}
