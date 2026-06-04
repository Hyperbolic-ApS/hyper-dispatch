import { Octokit } from "@octokit/rest";
import { env } from "../config/env.js";
import type { DispatchRun as ConfigDispatchRun } from "../db/config-queries.js";

type DeploymentRecord = {
  commit?: string | null;
  git_commit_sha?: string | null;
  status?: string | null;
};

type DeploymentResponseEnvelope = {
  deployments?: DeploymentRecord[];
};

export type RunWithProdDeployment = ConfigDispatchRun & {
  deployed_to_prod: boolean | null;
};

const SUCCESSFUL_DEPLOYMENT_STATUSES = new Set([
  "finished",
  "successful",
  "success",
]);

function parseGithubPullRequestUrl(
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

function hasCoolifyConfig(): boolean {
  return Boolean(
    env.COOLIFY_BASE_URL &&
      env.COOLIFY_API_TOKEN &&
      env.COOLIFY_PRODUCTION_APP_UUID
  );
}

function normalizeDeploymentRecords(payload: unknown): DeploymentRecord[] {
  if (Array.isArray(payload)) {
    return payload as DeploymentRecord[];
  }
  if (payload && typeof payload === "object") {
    const maybeEnvelope = payload as DeploymentResponseEnvelope;
    if (Array.isArray(maybeEnvelope.deployments)) {
      return maybeEnvelope.deployments;
    }
  }
  return [];
}

async function getCoolifyDeployedCommitShas(): Promise<Set<string>> {
  const baseUrl = env.COOLIFY_BASE_URL!;
  const token = env.COOLIFY_API_TOKEN!;
  const appUuid = env.COOLIFY_PRODUCTION_APP_UUID!;

  const deploymentsUrl = new URL(
    `/api/v1/deployments/applications/${appUuid}`,
    baseUrl
  );
  deploymentsUrl.searchParams.set("take", "100");

  const response = await fetch(deploymentsUrl.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Coolify deployments request failed (${response.status} ${response.statusText})`
    );
  }

  const raw = (await response.json()) as unknown;
  const deployments = normalizeDeploymentRecords(raw);
  const deployedCommitShas = new Set<string>();

  for (const deployment of deployments) {
    const status = (deployment.status ?? "").toLowerCase();
    if (!SUCCESSFUL_DEPLOYMENT_STATUSES.has(status)) continue;
    const commitSha = deployment.commit ?? deployment.git_commit_sha ?? null;
    if (!commitSha) continue;
    deployedCommitShas.add(commitSha);
  }

  return deployedCommitShas;
}

export async function annotateRunsWithProdDeploymentStatus(
  runs: ConfigDispatchRun[]
): Promise<RunWithProdDeployment[]> {
  if (!hasCoolifyConfig()) {
    return runs.map((run) => ({ ...run, deployed_to_prod: null }));
  }

  const runsWithPr = runs.filter((run) => Boolean(run.pr_url));
  if (runsWithPr.length === 0) {
    return runs.map((run) => ({ ...run, deployed_to_prod: false }));
  }

  let deployedCommitShas: Set<string>;
  try {
    deployedCommitShas = await getCoolifyDeployedCommitShas();
  } catch (err) {
    console.warn("[coolify] Failed to fetch deployment data:", err);
    return runs.map((run) => ({ ...run, deployed_to_prod: null }));
  }

  const github = new Octokit({ auth: env.GITHUB_TOKEN });
  const deploymentByTicket = new Map<string, boolean | null>();

  await Promise.all(
    runsWithPr.map(async (run) => {
      const parsedPrUrl = run.pr_url ? parseGithubPullRequestUrl(run.pr_url) : null;
      if (!parsedPrUrl) {
        deploymentByTicket.set(run.ticket_key, null);
        return;
      }

      try {
        const { data: pullRequest } = await github.pulls.get({
          owner: parsedPrUrl.owner,
          repo: parsedPrUrl.repo,
          pull_number: parsedPrUrl.pullNumber,
        });
        const mergeCommitSha = pullRequest.merge_commit_sha;
        if (!mergeCommitSha) {
          deploymentByTicket.set(run.ticket_key, false);
          return;
        }
        deploymentByTicket.set(
          run.ticket_key,
          deployedCommitShas.has(mergeCommitSha)
        );
      } catch (err) {
        console.warn(
          `[coolify] Failed to fetch PR details for ${run.ticket_key}:`,
          err
        );
        deploymentByTicket.set(run.ticket_key, null);
      }
    })
  );

  return runs.map((run) => ({
    ...run,
    deployed_to_prod: run.pr_url
      ? (deploymentByTicket.get(run.ticket_key) ?? null)
      : false,
  }));
}
