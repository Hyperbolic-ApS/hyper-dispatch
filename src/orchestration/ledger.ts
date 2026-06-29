import type { Octokit } from "@octokit/rest";
import { getOpenFindings, type FindingRow } from "../db/queries.js";
import { upsertStickyComment } from "../github/reviews.js";

const START = "<!-- review-ledger:start -->";
const END = "<!-- review-ledger:end -->";

export function renderLedger(rows: FindingRow[]): string {
  const header =
    "| key | severity | status | first | last | disposition |\n|---|---|---|---|---|---|";
  const body = rows
    .map(
      (r) =>
        `| ${r.finding_key.slice(0, 7)} | ${r.severity ?? "?"} | ${r.status} | ${r.first_seen_round} | ${r.last_seen_round} | ${r.disposition ?? "—"} |`
    )
    .join("\n");
  return `${START}\n## Review decisions ledger\n${header}\n${body || "| _none_ |  |  |  |  |  |"}\n${END}`;
}

export async function projectLedger(
  octokit: Octokit,
  pr: { owner: string; repo: string; pullNumber: number },
  prUrl: string
): Promise<void> {
  const rows = await getOpenFindings(prUrl);
  await upsertStickyComment(octokit, pr, START, renderLedger(rows));
}
