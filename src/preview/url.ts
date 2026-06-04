/**
 * Build a Coolify-style per-PR preview URL.
 * Returns null if either input is missing or the PR URL cannot be parsed.
 */
export function buildPreviewUrl(
  prUrl: string | null | undefined,
  deploymentUrl: string | null | undefined
): string | null {
  if (!prUrl || !deploymentUrl) return null;

  const match = prUrl.match(/\/pull\/(\d+)(?:\b|\/|$)/);
  if (!match) return null;

  const prNumber = match[1];
  const host = deploymentUrl.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!host) return null;

  return `https://${prNumber}.${host}`;
}

/**
 * Extract { owner, repo, prNumber } from a GitHub PR URL.
 * Returns null if the URL doesn't match the expected shape.
 */
export function parseGitHubPrUrl(
  prUrl: string
): { owner: string; repo: string; prNumber: number } | null {
  const match = prUrl.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i
  );
  if (!match) return null;

  return {
    owner: match[1]!,
    repo: match[2]!,
    prNumber: parseInt(match[3]!, 10),
  };
}
