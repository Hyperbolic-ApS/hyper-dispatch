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
