import { Octokit } from "@octokit/rest";
import { env } from "../config/env.js";

export interface SkillEntry {
  name: string;
  path: string;
  spec: string;
}

const SKILL_PREFIXES = [
  ".warp/skills/",
  ".agents/skills/",
  ".claude/skills/",
  ".codex/skills/",
];

export async function discoverSkills(
  owner: string,
  repo: string,
  branch = "main",
  githubToken?: string
): Promise<SkillEntry[]> {
  const octokit = new Octokit({ auth: githubToken ?? env.GITHUB_TOKEN });

  const { data } = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: branch,
    recursive: "1",
  });

  const skills: SkillEntry[] = [];

  for (const item of data.tree) {
    const path = item.path;
    if (!path) continue;
    if (!path.endsWith("/SKILL.md")) continue;

    const matchedPrefix = SKILL_PREFIXES.find((prefix) =>
      path.startsWith(prefix)
    );
    if (!matchedPrefix) continue;

    // Extract skill name from parent directory: prefix/<name>/SKILL.md
    const afterPrefix = path.slice(matchedPrefix.length);
    const parts = afterPrefix.split("/");
    if (parts.length < 2) continue;
    const skillName = parts[0];
    if (!skillName) continue;

    skills.push({
      name: skillName,
      path,
      spec: `${owner}/${repo}:${skillName}`,
    });
  }

  return skills;
}
