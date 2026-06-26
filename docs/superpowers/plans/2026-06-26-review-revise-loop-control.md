# Review/Revise Loop Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the unbounded review→revise loop (BOMA-71 churned 12 commits / 10 reviews / 5 CI failures and never converged) by giving the reviewer, the reviser, and the dispatch harness one shared contract with a terminating signal, a revision budget, severity-gated auto-action, and a capability-matched reviser model.

**Architecture:** Three actors share one contract: a severity taxonomy (only `Major+` is actionable), a terminal verdict (GitHub `APPROVE` ends the loop), and content-addressed finding IDs tracked in an append-only DB ledger that is *projected* to one sticky PR comment. The reviewer emits the verdict + severity-tagged findings and applies YAGNI/scope discipline; the reviser triages each finding (fix / defer / reject) instead of blindly implementing all; the harness gates auto-revision on `review.state` + severity + a per-PR budget, escalates to `needs-human` when the budget is spent or findings stop converging, and runs the reviser at a model tier matched to (and escalating above) the review tier.

**Tech Stack:** TypeScript (Node ≥ 20, ESM), Hono webhook service, `postgres` (`postgres-js`) via `src/db`, `@octokit/rest`, `oz-agent-sdk`, Vitest. Reviewer/reviser behavior is an Oz hosted skill (`pr-review-commenting`) + an inline prompt in `src/orchestration/revision.ts`. CI model selection is `.github/scripts/select-review-tier.py` + `.github/review-tiers.yml`.

## Global Constraints

- **Repo for harness/CI/DB changes:** `hyper-dispatch` (this checkout). Plan-doc paths below are relative to the repo root.
- **Reviewer skill source:** `pr-review-commenting` is a **hosted Oz skill**, not in this repo. Its prompt/contract edits (Phase 2) are made wherever that skill is authored (the Warp/Oz skills registry the team controls). The plan specifies the exact contract text to add; the implementer applies it at the skill source.
- **Severity taxonomy (verbatim, shared by all three actors):** `Blocking` > `Major` > `Minor` > `Nit`. **Only `Blocking` and `Major` are "actionable"** (carry action-item markers and may trigger auto-revision). `Minor`/`Nit` are advisory-only.
- **Terminal signal:** a GitHub review submitted with state `APPROVED`. The reviewer MUST submit `APPROVED` when zero actionable findings remain. A GitHub review's state is immutable after submission — verdicts are therefore append-only (new review per round); superseded `CHANGES_REQUESTED` reviews are **dismissed**, never edited.
- **Auto-revision trigger (all must hold):** `review.state == "changes_requested"` AND ≥1 actionable finding AND budget remaining AND PR is `open`. `commented` reviews never auto-revise. `approved` reviews terminate the loop.
- **Default revision budget:** `2` auto-revision rounds per PR. Configurable per project later; hardcode the default this plan.
- **Finding identity:** content-addressed `finding_key = sha1(normalizedPath + ":" + ruleOrTitleSlug)` — stable across rounds, independent of line drift. Never re-number per round.
- **Reviser model:** floored at the review tier selected for the PR (`select-review-tier.py` output) and escalated one tier when any finding repeats across rounds ("escalate-on-repeat").
- **No new gratitude/performative copy** in any prompt (receiving-code-review rule): reviser states fixes/pushbacks technically; no "You're absolutely right" / "Thanks".
- **Migrations are additive and idempotent** — follow the existing `ADD COLUMN IF NOT EXISTS` pattern in `src/db/migrate.ts`; never rewrite existing columns.
- **Test command:** `npm test` (Vitest). Single file: `npx vitest run src/path/file.test.ts`.

---

## File Structure

**Created:**
- `docs/contract/review-revise-contract.md` — the shared contract (severity, verdict, finding IDs, ledger), referenced by reviewer skill, reviser prompt, and harness.
- `src/orchestration/review-gate.ts` — pure decision logic: given `review.state`, parsed findings, current round, budget, PR state → `{ action: "revise" | "approve_terminal" | "escalate_human" | "ignore", ... }`. Unit-tested in isolation.
- `src/orchestration/review-gate.test.ts`
- `src/orchestration/findings.ts` — parse severity-tagged action items + compute `finding_key`; build the reviser triage feedback block.
- `src/orchestration/findings.test.ts`
- `src/orchestration/ledger.ts` — upsert findings to DB, detect repeats, render + upsert the sticky ledger PR comment.
- `src/orchestration/ledger.test.ts`
- `src/github/reviews.ts` — `dismissSupersededReviews()` + `upsertStickyComment()` Octokit helpers.
- `src/github/reviews.test.ts`

**Modified:**
- `src/db/migrate.ts` — add `dispatch_runs` budget/round/needs_human columns + `review_findings` table + `review_tier` column.
- `src/db/queries.ts` — round/budget/needs_human accessors; `review_findings` upsert/select; `review_tier` read/write.
- `src/orchestration/revision.ts` — replace the "action items present?" gate with `review-gate.ts`; rewrite `buildPrompt` to the triage flow; record findings + project ledger after spawn.
- `src/orchestration/spawner.ts` — `resolveModel` gains a `floorTier`/`escalate` path for revisions.
- `.github/workflows/oz-pr-review-commenting.yml` — persist the selected tier onto the PR (so the harness can floor the reviser model) and pass the contract to the reviewer prompt.
- `.github/review-tiers.yml` — no model changes; add a comment cross-referencing the contract (reviewer must read it).
- `pr-review-commenting` hosted skill (external) — verdict + severity + YAGNI/scope + stable IDs + thin-verdict/dismiss/resolve behavior.

---

## Phase 0 — Shared contract

### Task 0: Author the shared contract doc

**Files:**
- Create: `docs/contract/review-revise-contract.md`

**Interfaces:**
- Produces: the canonical strings every later task references — severity names, verdict mapping, `finding_key` formula, action-item marker format, ledger comment markers.

- [ ] **Step 1: Write the contract doc**

````markdown
# Review / Revise Contract

This contract is binding for THREE actors: the `pr-review-commenting` reviewer
skill, the dispatch reviser prompt (`buildPrompt`), and the dispatch harness
(`review-gate.ts`). Changing any rule here requires updating all three.

## Severity
`Blocking` > `Major` > `Minor` > `Nit`.
- **Actionable** = `Blocking` or `Major`. Only these may carry action-item
  markers and only these can trigger an auto-revision.
- `Minor` / `Nit` are advisory-only: list them under a non-blocking heading,
  NEVER with an action-item marker.

## Action-item marker format (machine-readable, one per actionable finding)
`<!-- finding key="<sha1>" severity="Major|Blocking" path="<repo/rel/path>" -->`
followed by a human-readable title line. The reviewer computes:
`key = sha1(lower(path) + ":" + slug(ruleOrTitle))`.
Stable across rounds — do NOT renumber. A finding that persists keeps its key.

## Verdict (GitHub review state)
- `APPROVED` — zero actionable findings remain. The reviewer MUST approve here;
  remaining `Minor`/`Nit` items do NOT justify withholding approval.
- `CHANGES_REQUESTED` — ≥1 actionable finding.
- `COMMENTED` — advisory only (never triggers auto-revision).
Verdict bodies are THIN: the verdict line + a link to the sticky ledger comment.
Superseded `CHANGES_REQUESTED` reviews are dismissed by the harness, not edited.
Inline findings are resolved (reply + resolve thread) when fixed, never reposted.

## YAGNI / scope (reviewer AND reviser)
Do not suggest or add features, hardening, or abstractions beyond the PR's
stated scope (ticket acceptance criteria). Before asking for something to be
"done properly," verify it is actually used/needed. Out-of-scope observations
go under a non-blocking "Future work" heading, never as an actionable finding.

## Reviser triage (per finding)
fix (correct + in-scope + actionable) | defer (out-of-scope/speculative →
reply on thread "out of scope for this slice", no code) | reject (wrong for
this codebase → reply with technical reasoning). No performative agreement.

## Sticky ledger comment
Single PR comment, upserted each round, delimited by:
`<!-- review-ledger:start -->` ... `<!-- review-ledger:end -->`
Projection of the authoritative `review_findings` DB rows. Columns:
key (short) | severity | status | first round | last round | disposition.
````

- [ ] **Step 2: Commit**

```bash
git add docs/contract/review-revise-contract.md
git commit -m "docs: add shared review/revise contract"
```

---

## Phase 1 — Harness: verdict + severity + budget gating, human escalation

> Ships value immediately and is backward-compatible: if the reviewer hasn't adopted the new markers yet (pre-Phase 2), findings parse with `severity=undefined` and are treated as actionable (current behavior preserved), while the budget cap + `approved`-terminates still apply.

### Task 1: DB migration — round, budget, needs_human, review_tier, findings table

**Files:**
- Modify: `src/db/migrate.ts:27-35` (extend the `dispatch_runs` ALTER and add a new table)
- Test: `src/db/queries.integration.test.ts` (extend; runs against `scripts/test-db.sh` Postgres)

**Interfaces:**
- Produces: `dispatch_runs.revision_round INT`, `dispatch_runs.revision_budget INT`, `dispatch_runs.needs_human BOOLEAN`, `dispatch_runs.review_tier TEXT`; table `review_findings(finding_key, ticket_key, pr_url, severity, title, status, disposition, first_seen_round, last_seen_round, updated_at)`.

- [ ] **Step 1: Add the migration SQL**

In `src/db/migrate.ts`, after the existing `dispatch_runs` ALTER block (line 35), add:

```ts
  await sql.unsafe(`
    ALTER TABLE dispatch_runs
      ADD COLUMN IF NOT EXISTS revision_round  INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS revision_budget INTEGER NOT NULL DEFAULT 2,
      ADD COLUMN IF NOT EXISTS needs_human     BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS review_tier     TEXT;
  `);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS review_findings (
      finding_key      TEXT NOT NULL,
      ticket_key       TEXT NOT NULL,
      pr_url           TEXT NOT NULL,
      severity         TEXT,
      title            TEXT,
      status           TEXT NOT NULL DEFAULT 'open',
      disposition      TEXT,
      first_seen_round INTEGER NOT NULL,
      last_seen_round  INTEGER NOT NULL,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (pr_url, finding_key)
    );
  `);
```

- [ ] **Step 2: Run the migration test**

Run: `scripts/test-db.sh && npx vitest run src/db/queries.integration.test.ts`
Expected: PASS (existing tests still green; migration applies without error).

- [ ] **Step 3: Commit**

```bash
git add src/db/migrate.ts
git commit -m "feat(db): add revision budget/round/needs_human + review_findings ledger"
```

### Task 2: Query accessors for round/budget/needs_human/tier and findings

**Files:**
- Modify: `src/db/queries.ts` (add exports near the other `dispatch_runs` helpers)
- Test: `src/db/queries.integration.test.ts`

**Interfaces:**
- Produces:
  - `getRevisionState(ticketKey): Promise<{ round: number; budget: number; needsHuman: boolean; reviewTier: string | null } | null>`
  - `incrementRevisionRound(ticketKey): Promise<number>` (returns new round)
  - `setNeedsHuman(ticketKey, value: boolean): Promise<void>`
  - `setReviewTier(prUrl: string, tier: string): Promise<void>`
  - `upsertFindings(prUrl, ticketKey, round, findings: ParsedFinding[]): Promise<{ repeated: string[] }>` (returns keys whose `first_seen_round < round`)
  - `getOpenFindings(prUrl): Promise<FindingRow[]>`
  - `markFindingsResolved(prUrl, keys: string[]): Promise<void>`
- Consumes: `ParsedFinding` from Task 4 (`{ key, severity, title, path }`).

- [ ] **Step 1: Write failing tests**

```ts
// in src/db/queries.integration.test.ts
it("tracks revision round and budget", async () => {
  await upsertRun({ ticketKey: "T-1", projectKey: "P", prUrl: "u" });
  const before = await getRevisionState("T-1");
  expect(before).toMatchObject({ round: 0, budget: 2, needsHuman: false });
  expect(await incrementRevisionRound("T-1")).toBe(1);
});

it("flags repeated findings across rounds", async () => {
  const f = { key: "k1", severity: "Major", title: "x", path: "a.ts" };
  await upsertFindings("u2", "T-2", 1, [f]);
  const r = await upsertFindings("u2", "T-2", 2, [f]);
  expect(r.repeated).toEqual(["k1"]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/db/queries.integration.test.ts`
Expected: FAIL ("getRevisionState is not a function").

- [ ] **Step 3: Implement the accessors**

```ts
// src/db/queries.ts
export interface ParsedFinding { key: string; severity?: string; title: string; path: string; }
export interface FindingRow { finding_key: string; severity: string | null; title: string | null; status: string; disposition: string | null; first_seen_round: number; last_seen_round: number; }

export async function getRevisionState(ticketKey: string) {
  const rows = await sql<{ revision_round: number; revision_budget: number; needs_human: boolean; review_tier: string | null }[]>`
    SELECT revision_round, revision_budget, needs_human, review_tier
    FROM dispatch_runs WHERE ticket_key = ${ticketKey}`;
  const r = rows[0];
  return r ? { round: r.revision_round, budget: r.revision_budget, needsHuman: r.needs_human, reviewTier: r.review_tier } : null;
}

export async function incrementRevisionRound(ticketKey: string): Promise<number> {
  const rows = await sql<{ revision_round: number }[]>`
    UPDATE dispatch_runs SET revision_round = revision_round + 1
    WHERE ticket_key = ${ticketKey} RETURNING revision_round`;
  return rows[0]?.revision_round ?? 0;
}

export async function setNeedsHuman(ticketKey: string, value: boolean): Promise<void> {
  await sql`UPDATE dispatch_runs SET needs_human = ${value} WHERE ticket_key = ${ticketKey}`;
}

export async function setReviewTier(prUrl: string, tier: string): Promise<void> {
  await sql`UPDATE dispatch_runs SET review_tier = ${tier} WHERE pr_url = ${prUrl}`;
}

export async function upsertFindings(prUrl: string, ticketKey: string, round: number, findings: ParsedFinding[]): Promise<{ repeated: string[] }> {
  const repeated: string[] = [];
  for (const f of findings) {
    const rows = await sql<{ first_seen_round: number }[]>`
      INSERT INTO review_findings (finding_key, ticket_key, pr_url, severity, title, first_seen_round, last_seen_round)
      VALUES (${f.key}, ${ticketKey}, ${prUrl}, ${f.severity ?? null}, ${f.title}, ${round}, ${round})
      ON CONFLICT (pr_url, finding_key) DO UPDATE
        SET last_seen_round = ${round}, status = 'open', updated_at = NOW()
      RETURNING first_seen_round`;
    if ((rows[0]?.first_seen_round ?? round) < round) repeated.push(f.key);
  }
  return { repeated };
}

export async function getOpenFindings(prUrl: string): Promise<FindingRow[]> {
  return sql<FindingRow[]>`
    SELECT finding_key, severity, title, status, disposition, first_seen_round, last_seen_round
    FROM review_findings WHERE pr_url = ${prUrl} ORDER BY first_seen_round, finding_key`;
}

export async function markFindingsResolved(prUrl: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await sql`UPDATE review_findings SET status = 'resolved', updated_at = NOW()
    WHERE pr_url = ${prUrl} AND finding_key = ANY(${keys})`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/db/queries.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries.ts src/db/queries.integration.test.ts
git commit -m "feat(db): revision-state + findings-ledger query accessors"
```

### Task 3: Finding parser (`findings.ts`)

**Files:**
- Create: `src/orchestration/findings.ts`
- Test: `src/orchestration/findings.test.ts`

**Interfaces:**
- Produces: `parseFindings(texts: string[]): ParsedFinding[]` (reads the contract's HTML-comment markers; falls back to legacy `[REV-\d+]` as `severity=undefined`), and `actionableFindings(f: ParsedFinding[]): ParsedFinding[]` (severity `Major`/`Blocking`, or `undefined` for legacy back-compat).
- Consumes: `ParsedFinding` (Task 2).

- [ ] **Step 1: Write failing tests**

```ts
import { parseFindings, actionableFindings } from "./findings.js";

it("parses contract markers with stable keys", () => {
  const body = `<!-- finding key="abc123" severity="Major" path="src/a.ts" -->\nFix the thing`;
  const f = parseFindings([body]);
  expect(f).toEqual([{ key: "abc123", severity: "Major", title: "Fix the thing", path: "src/a.ts" }]);
});

it("treats legacy REV markers as actionable", () => {
  const f = parseFindings(["[REV-001] do x"]);
  expect(actionableFindings(f)).toHaveLength(1);
});

it("drops Minor findings from actionable set", () => {
  const body = `<!-- finding key="k" severity="Minor" path="a.ts" -->\nnit`;
  expect(actionableFindings(parseFindings([body]))).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/orchestration/findings.test.ts`
Expected: FAIL ("Cannot find module './findings.js'").

- [ ] **Step 3: Implement**

```ts
// src/orchestration/findings.ts
import type { ParsedFinding } from "../db/queries.js";

const MARKER = /<!--\s*finding\s+key="([^"]+)"\s+severity="([^"]+)"\s+path="([^"]+)"\s*-->\s*\n?\s*(.*)/gi;
const LEGACY = /\[(REV-\d+)\]\s*(.*)/gi;

export function parseFindings(texts: string[]): ParsedFinding[] {
  const out = new Map<string, ParsedFinding>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(MARKER)) {
      out.set(m[1]!, { key: m[1]!, severity: m[2], title: (m[4] ?? "").trim(), path: m[3]! });
    }
    if (!MARKER.test(text)) {
      for (const m of text.matchAll(LEGACY)) {
        const key = m[1]!.toUpperCase();
        if (!out.has(key)) out.set(key, { key, title: (m[2] ?? "").trim(), path: "" });
      }
    }
  }
  return [...out.values()];
}

export function actionableFindings(f: ParsedFinding[]): ParsedFinding[] {
  return f.filter((x) => x.severity === undefined || /^(major|blocking)$/i.test(x.severity));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/orchestration/findings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/findings.ts src/orchestration/findings.test.ts
git commit -m "feat(orchestration): severity-aware finding parser"
```

### Task 4: Pure gate decision (`review-gate.ts`)

**Files:**
- Create: `src/orchestration/review-gate.ts`
- Test: `src/orchestration/review-gate.test.ts`

**Interfaces:**
- Produces: `decideReviewAction(input): GateDecision` where
  `input = { reviewState: string; actionableCount: number; round: number; budget: number; prState: string | null; needsHuman: boolean }`
  and `GateDecision = { action: "revise" } | { action: "approve_terminal" } | { action: "escalate_human"; reason: string } | { action: "ignore"; reason: string }`.

- [ ] **Step 1: Write failing tests**

```ts
import { decideReviewAction } from "./review-gate.js";
const base = { reviewState: "changes_requested", actionableCount: 1, round: 0, budget: 2, prState: "open", needsHuman: false };

it("revises when changes requested, under budget, actionable", () => {
  expect(decideReviewAction(base)).toEqual({ action: "revise" });
});
it("terminates on approval", () => {
  expect(decideReviewAction({ ...base, reviewState: "approved" })).toEqual({ action: "approve_terminal" });
});
it("ignores commented reviews", () => {
  expect(decideReviewAction({ ...base, reviewState: "commented" }).action).toBe("ignore");
});
it("escalates when budget spent", () => {
  expect(decideReviewAction({ ...base, round: 2 }).action).toBe("escalate_human");
});
it("ignores closed/merged PRs", () => {
  expect(decideReviewAction({ ...base, prState: "merged" }).action).toBe("ignore");
});
it("ignores once already flagged for human", () => {
  expect(decideReviewAction({ ...base, needsHuman: true }).action).toBe("ignore");
});
it("ignores changes_requested with no actionable findings", () => {
  expect(decideReviewAction({ ...base, actionableCount: 0 }).action).toBe("ignore");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/orchestration/review-gate.test.ts`
Expected: FAIL ("Cannot find module './review-gate.js'").

- [ ] **Step 3: Implement**

```ts
// src/orchestration/review-gate.ts
export interface GateInput {
  reviewState: string; actionableCount: number; round: number;
  budget: number; prState: string | null; needsHuman: boolean;
}
export type GateDecision =
  | { action: "revise" }
  | { action: "approve_terminal" }
  | { action: "escalate_human"; reason: string }
  | { action: "ignore"; reason: string };

export function decideReviewAction(i: GateInput): GateDecision {
  if (i.prState === "merged" || i.prState === "closed") return { action: "ignore", reason: "PR is merged/closed" };
  if (i.needsHuman) return { action: "ignore", reason: "PR already escalated to human" };
  const state = i.reviewState.toLowerCase();
  if (state === "approved") return { action: "approve_terminal" };
  if (state !== "changes_requested") return { action: "ignore", reason: `review state ${state} is advisory` };
  if (i.actionableCount === 0) return { action: "ignore", reason: "no actionable (Major+) findings" };
  if (i.round >= i.budget) return { action: "escalate_human", reason: `revision budget (${i.budget}) exhausted` };
  return { action: "revise" };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/orchestration/review-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/review-gate.ts src/orchestration/review-gate.test.ts
git commit -m "feat(orchestration): pure review-gate decision logic"
```

### Task 5: Wire the gate into `handleGithubRevisionWebhook` + escalation

**Files:**
- Modify: `src/orchestration/revision.ts:339-406` (the `pull_request_review` branch)
- Modify: `src/orchestration/revision.ts` (add `escalateToHuman()` helper using `setNeedsHuman` + an Octokit comment + Jira transition)
- Test: `src/orchestration/revision.test.ts`

**Interfaces:**
- Consumes: `decideReviewAction` (Task 4), `parseFindings`/`actionableFindings` (Task 3), `getRevisionState`/`incrementRevisionRound`/`setNeedsHuman`/`upsertFindings` (Task 2).
- Produces: extends `RevisionDecision` with `{ action: "approve_terminal" }` and `{ action: "escalated_human"; reason: string }`.

- [ ] **Step 1: Write failing tests** (mock the DB + Octokit per existing `revision.test.ts` patterns)

```ts
it("does not spawn when review is approved", async () => {
  // payload.review.state = "approved"
  const res = await handleGithubRevisionWebhook({ event: "pull_request_review", payload: approvedPayload });
  expect(res.action).toBe("approve_terminal");
});
it("escalates instead of spawning once budget is exhausted", async () => {
  // getRevisionState → { round: 2, budget: 2, ... }
  const res = await handleGithubRevisionWebhook({ event: "pull_request_review", payload: changesRequestedPayload });
  expect(res.action).toBe("escalated_human");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/orchestration/revision.test.ts`
Expected: FAIL (current code returns `spawned`/`ignored`, never `approve_terminal`).

- [ ] **Step 3: Implement the rewrite**

Replace the action-item gate (revision.ts lines 372-378) and spawn block with:

```ts
import { decideReviewAction } from "./review-gate.js";
import { parseFindings, actionableFindings } from "./findings.js";
import { getRevisionState, incrementRevisionRound, setNeedsHuman, upsertFindings } from "../db/queries.js";

// ...after resolveTrackedRevisionContext and listReviewComments...
const findings = parseFindings([reviewBody, ...inlineReviewComments.map((c) => c.body)]);
const actionable = actionableFindings(findings);
const state = await getRevisionState(context.ticketKey);
const prState = await getPrDisplayState(context); // reads dispatch_runs.pr_display_state for this PR

const decision = decideReviewAction({
  reviewState,
  actionableCount: actionable.length,
  round: state?.round ?? 0,
  budget: state?.budget ?? 2,
  prState,
  needsHuman: state?.needsHuman ?? false,
});

if (decision.action === "approve_terminal") {
  return { action: "approve_terminal" } as RevisionDecision;
}
if (decision.action === "ignore") {
  return { action: "ignored", reason: decision.reason };
}
if (decision.action === "escalate_human") {
  await escalateToHuman(context, decision.reason, findings);
  return { action: "escalated_human", reason: decision.reason } as RevisionDecision;
}

// decision.action === "revise"
await upsertFindings(context.pr.htmlUrl, context.ticketKey, (state?.round ?? 0) + 1, actionable);
await incrementRevisionRound(context.ticketKey);
const feedback = buildAutoFeedback(reviewBody, inlineReviewComments);
const outcome = await recordAndSpawnRevision({ /* unchanged */ });
```

Add the helper (escalation = stop auto-revising + visible human handoff):

```ts
async function escalateToHuman(
  ctx: TrackedRevisionContext, reason: string,
  findings: { title: string; severity?: string }[]
): Promise<void> {
  await setNeedsHuman(ctx.ticketKey, true);
  const octokit = new Octokit({ auth: ctx.githubToken });
  const open = findings.map((f) => `- [${f.severity ?? "?"}] ${f.title}`).join("\n");
  await octokit.rest.issues.createComment({
    owner: ctx.pr.owner, repo: ctx.pr.repo, issue_number: ctx.pr.pullNumber,
    body: `⚠️ **Auto-revision stopped — needs human review**\n\nReason: ${reason}\n\nRemaining findings:\n${open}\n\nReply with \`/revise\` to resume auto-revision after triaging.`,
  });
  await jira.transitionIssue(ctx.ticketKey, ctx.projectConfig.in_review_column_name).catch(() => {});
}
```

(If `transitionIssue` / `getPrDisplayState` don't exist with these names, add thin wrappers in `src/jira/client.ts` and `src/db/queries.ts` respectively — `getPrDisplayState` = `SELECT pr_display_state FROM dispatch_runs WHERE pr_url = $1`.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/orchestration/revision.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/revision.ts src/orchestration/revision.test.ts src/jira/client.ts src/db/queries.ts
git commit -m "feat(orchestration): verdict+severity+budget gate with human escalation"
```

---

## Phase 2 — Reviewer skill: terminal verdict, severity, YAGNI, stable IDs

> Applied at the `pr-review-commenting` hosted-skill source (external to this repo) + the workflow that invokes it.

### Task 6: Rewrite the reviewer skill contract

**Files:**
- Modify: `pr-review-commenting` hosted skill prompt (external skill source)
- Reference: `docs/contract/review-revise-contract.md` (Task 0)

**Interfaces:**
- Produces: reviews that (a) submit a real GitHub state (`APPROVE`/`REQUEST_CHANGES`/`COMMENT`), (b) tag actionable findings with the contract's HTML-comment marker + stable `finding_key`, (c) keep `Minor`/`Nit` non-actionable, (d) obey YAGNI/scope, (e) emit a THIN verdict body.

- [ ] **Step 1: Add the verdict + severity rules to the skill prompt** (verbatim block)

```
Submit your review with an explicit GitHub review state:
- APPROVE when zero Blocking/Major findings remain. You MUST approve here even
  if Minor/Nit nits exist — "I could still find nits" is NOT grounds to withhold.
- REQUEST_CHANGES when ≥1 Blocking/Major finding exists.
- COMMENT for advisory-only passes.
Classify every finding as Blocking | Major | Minor | Nit. Only Blocking/Major
are actionable. Tag each actionable finding with EXACTLY this marker on its own
line, then the title:
<!-- finding key="<sha1(lower(path)+':'+slug(title))>" severity="Major" path="<repo/rel/path>" -->
Reuse the SAME key for a finding that persists across rounds — never renumber.
List Minor/Nit under a "## Non-blocking" heading with NO marker.
Keep the review BODY thin: the verdict line + "See the ledger comment for status."
```

- [ ] **Step 2: Add the YAGNI / scope guard** (verbatim block)

```
Scope discipline (binding):
- Review against the ticket's acceptance criteria (fetch via jira-view <KEY>).
- Do NOT suggest adding features, hardening, abstractions, or "do it properly"
  beyond that scope. Before requesting something be added, confirm it is
  actually used/needed in this PR.
- Out-of-scope observations go under "## Future work (non-blocking)" — never as
  an actionable finding. Do not re-raise items already listed as deferred in the
  ledger comment.
- If a finding concerns code a prior revision added in response to YOUR earlier
  feedback, either confirm it is resolved or state your prior suggestion was
  wrong. Do not raise a renamed variant of the same point.
```

- [ ] **Step 3: Validate on a scratch PR**

Open a tiny throwaway PR; confirm the review (a) submits a real state, (b) emits markers with stable keys, (c) puts nits under Non-blocking, (d) approves when only nits remain. Record the run link in the PR description.

- [ ] **Step 4: Commit** (at the skill source repo)

```bash
git commit -am "feat(reviewer): terminal verdict, severity markers, YAGNI/scope, stable finding ids"
```

### Task 7: Persist the selected review tier onto the PR

**Files:**
- Modify: `.github/workflows/oz-pr-review-commenting.yml:88-116`

**Interfaces:**
- Produces: a label or PR property `review-tier:<tier>` the harness reads to floor the reviser model (consumed in Phase 5). Chosen mechanism: a PR label (visible, simple).

- [ ] **Step 1: Add a label step after tier selection**

After the `Select review tier` step (line 36), add:

```yaml
      - name: Record review tier on PR
        env:
          GH_TOKEN: ${{ github.token }}
          TIER: ${{ steps.tier.outputs.tier }}
        run: |
          gh pr edit ${{ github.event.pull_request.number }} \
            --repo ${{ github.repository }} \
            --add-label "review-tier:${TIER}" || true
```

- [ ] **Step 2: Pass the contract into the reviewer prompt**

In the `Run PR review commenting skill` step's `prompt:` block (line 103), append:

```
            Follow the binding contract at docs/contract/review-revise-contract.md
            (severity taxonomy, verdict states, finding-marker format, YAGNI/scope).
```

- [ ] **Step 3: Validate**

Push a commit to the scratch PR; confirm a `review-tier:<tier>` label appears and the reviewer prompt references the contract in its run log.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/oz-pr-review-commenting.yml
git commit -m "ci: record review tier on PR and pass contract to reviewer"
```

---

## Phase 3 — Reviser: receiving-code-review triage flow

### Task 8: Rewrite `buildPrompt` to the triage flow

**Files:**
- Modify: `src/orchestration/revision.ts:131-158` (`buildPrompt`)
- Test: `src/orchestration/revision.test.ts` (assert the prompt contains the triage contract, not "Address ALL")

**Interfaces:**
- Consumes: existing `buildPrompt` params (unchanged signature).
- Produces: a prompt instructing fix/defer/reject triage, push-back standing, comment-and-move-on for out-of-scope, one-at-a-time + test-each, no performative agreement.

- [ ] **Step 1: Write failing test**

```ts
it("builds a triage prompt, not blind 'address all'", () => {
  const p = (buildPromptForTest as any)({ mode: "auto_review_submitted", ticketKey: "T-1", prUrl: "u", branch: "b", reviewState: "changes_requested", feedback: "x" });
  expect(p).not.toContain("Address ALL");
  expect(p).toMatch(/fix.*defer.*reject/is);
  expect(p).toContain("out of scope for this slice");
});
```

(Export `buildPrompt` as `buildPromptForTest` or test via the spawn path's captured prompt — match existing test style.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/orchestration/revision.test.ts`
Expected: FAIL (current prompt contains "Address ALL").

- [ ] **Step 3: Implement the new prompt body**

```ts
function buildPrompt(params: {
  mode: RevisionMode; ticketKey: string; prUrl: string; branch: string;
  reviewState: string; feedback: string;
}): string {
  return `You are triaging PR review feedback for ${params.ticketKey}.

PR: ${params.prUrl}
Branch: ${params.branch}
Trigger: ${params.mode}
Review state: ${params.reviewState}

Review feedback (only Blocking/Major items are actionable):

${params.feedback}

This is the binding contract: docs/contract/review-revise-contract.md.
External review feedback is a set of SUGGESTIONS TO EVALUATE, not orders. For
EACH finding, decide and act:
  - FIX: correct, in-scope, and Blocking/Major → implement it.
  - DEFER: out-of-scope or speculative ("do it properly", future hardening) →
    do NOT write code. Reply on the thread: "Out of scope for this slice."
  - REJECT: technically wrong for this codebase/stack → reply with the technical
    reason. Verify against the code before rejecting; if a thing is unused, say
    so (YAGNI) rather than building it.
Procedure:
1. Read all feedback first. If any item is unclear, do not guess — note it.
2. Verify each item against the actual code before changing anything.
3. Implement in order: Blocking → simple → complex. Test after EACH change.
4. Do not add features/abstractions beyond the ticket's scope to satisfy a
   suggestion. Match the existing code's conventions.
5. No performative agreement in replies — state the fix or the pushback.
6. Commit: "${params.ticketKey}: Address review feedback

Co-Authored-By: Oz <oz-agent@warp.dev>"
7. Push to the existing branch (do NOT open a new PR).`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/orchestration/revision.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/revision.ts src/orchestration/revision.test.ts
git commit -m "feat(reviser): receiving-code-review triage prompt (fix/defer/reject)"
```

---

## Phase 4 — Ledger projection (sticky PR comment)

### Task 9: Octokit sticky-comment + dismiss helpers

**Files:**
- Create: `src/github/reviews.ts`
- Test: `src/github/reviews.test.ts`

**Interfaces:**
- Produces:
  - `upsertStickyComment(octokit, pr, marker: string, body: string): Promise<void>` — finds an existing issue comment containing `marker`, edits it; else creates it.
  - `dismissSupersededReviews(octokit, pr, keepReviewId: number): Promise<void>` — dismisses prior `CHANGES_REQUESTED` reviews by the bot author except `keepReviewId`.

- [ ] **Step 1: Write failing tests** (mock Octokit)

```ts
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
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/github/reviews.test.ts`
Expected: FAIL ("Cannot find module './reviews.js'").

- [ ] **Step 3: Implement**

```ts
// src/github/reviews.ts
import type { Octokit } from "@octokit/rest";
interface PrRef { owner: string; repo: string; pullNumber: number; }

export async function upsertStickyComment(octokit: Octokit, pr: PrRef, marker: string, body: string): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: pr.owner, repo: pr.repo, issue_number: pr.pullNumber, per_page: 100,
  });
  const existing = comments.find((c) => (c.body ?? "").includes(marker));
  if (existing) {
    await octokit.rest.issues.updateComment({ owner: pr.owner, repo: pr.repo, comment_id: existing.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner: pr.owner, repo: pr.repo, issue_number: pr.pullNumber, body });
  }
}

export async function dismissSupersededReviews(octokit: Octokit, pr: PrRef, keepReviewId: number): Promise<void> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: pr.owner, repo: pr.repo, pull_number: pr.pullNumber, per_page: 100,
  });
  for (const r of reviews) {
    if (r.id !== keepReviewId && r.state === "CHANGES_REQUESTED") {
      await octokit.rest.pulls.dismissReview({
        owner: pr.owner, repo: pr.repo, pull_number: pr.pullNumber,
        review_id: r.id, message: "Superseded by a newer review.",
      }).catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/github/reviews.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/github/reviews.ts src/github/reviews.test.ts
git commit -m "feat(github): sticky-comment upsert + dismiss-superseded-reviews helpers"
```

### Task 10: Render + project the ledger after each gate decision

**Files:**
- Create: `src/orchestration/ledger.ts`
- Test: `src/orchestration/ledger.test.ts`
- Modify: `src/orchestration/revision.ts` (call `projectLedger` after `revise` and inside `escalateToHuman`; call `dismissSupersededReviews` with the current `reviewId`)

**Interfaces:**
- Consumes: `getOpenFindings` (Task 2), `upsertStickyComment` (Task 9).
- Produces: `renderLedger(rows: FindingRow[]): string` (table between contract markers) and `projectLedger(octokit, pr, prUrl): Promise<void>`.

- [ ] **Step 1: Write failing test**

```ts
import { renderLedger } from "./ledger.js";
it("renders a ledger table with the contract markers", () => {
  const out = renderLedger([{ finding_key: "abc1234", severity: "Major", title: "x", status: "open", disposition: null, first_seen_round: 1, last_seen_round: 2 }] as any);
  expect(out).toContain("<!-- review-ledger:start -->");
  expect(out).toContain("<!-- review-ledger:end -->");
  expect(out).toMatch(/Major/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/orchestration/ledger.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/orchestration/ledger.ts
import type { Octokit } from "@octokit/rest";
import { getOpenFindings, type FindingRow } from "../db/queries.js";
import { upsertStickyComment } from "../github/reviews.js";

const START = "<!-- review-ledger:start -->";
const END = "<!-- review-ledger:end -->";

export function renderLedger(rows: FindingRow[]): string {
  const header = "| key | severity | status | first | last | disposition |\n|---|---|---|---|---|---|";
  const body = rows.map((r) =>
    `| ${r.finding_key.slice(0, 7)} | ${r.severity ?? "?"} | ${r.status} | ${r.first_seen_round} | ${r.last_seen_round} | ${r.disposition ?? "—"} |`
  ).join("\n");
  return `${START}\n## Review decisions ledger\n${header}\n${body || "| _none_ |  |  |  |  |  |"}\n${END}`;
}

export async function projectLedger(octokit: Octokit, pr: { owner: string; repo: string; pullNumber: number }, prUrl: string): Promise<void> {
  const rows = await getOpenFindings(prUrl);
  await upsertStickyComment(octokit, pr, START, renderLedger(rows));
}
```

- [ ] **Step 4: Wire into revision.ts**

In the `revise` branch (after `upsertFindings`) and inside `escalateToHuman`, add:

```ts
const octokit = new Octokit({ auth: context.githubToken });
await dismissSupersededReviews(octokit, context.pr, reviewId);
await projectLedger(octokit, context.pr, context.pr.htmlUrl);
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/ledger.ts src/orchestration/ledger.test.ts src/orchestration/revision.ts
git commit -m "feat(orchestration): project findings ledger to sticky PR comment + dismiss superseded"
```

---

## Phase 5 — Match-tier reviser model + escalate-on-repeat

### Task 11: Tier-floored, repeat-escalated reviser model

**Files:**
- Modify: `src/orchestration/spawner.ts` (`resolveModel`)
- Modify: `src/orchestration/revision.ts` (pass `reviewTier` + `repeated` into model resolution)
- Test: `src/orchestration/spawner.test.ts`

**Interfaces:**
- Consumes: `review_tier` from `getRevisionState`, `repeated` from `upsertFindings`.
- Produces: `resolveRevisionModel(issue, config, opts: { floorTier: string | null; escalate: boolean }): string | null` returning the higher of (per-ticket/default model, floor tier), bumped one tier when `escalate`.

- [ ] **Step 1: Write failing tests**

```ts
const ORDER = ["auto-open", "auto-efficient", "auto", "auto-genius"];
it("floors the reviser model at the review tier", () => {
  expect(resolveRevisionModel(issueNoModel, configNoDefault, { floorTier: "auto", escalate: false })).toBe("auto");
});
it("escalates one tier when a finding repeated", () => {
  expect(resolveRevisionModel(issueNoModel, configNoDefault, { floorTier: "auto-efficient", escalate: true })).toBe("auto");
});
it("never downgrades below the ticket/default model", () => {
  expect(resolveRevisionModel(issueNoModel, configDefaultGenius, { floorTier: "auto-open", escalate: false })).toBe("auto-genius");
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/orchestration/spawner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/orchestration/spawner.ts
const TIER_MODELS = ["auto-open", "auto-efficient", "auto", "auto-genius"] as const;
function rank(model: string | null): number {
  const i = TIER_MODELS.indexOf((model ?? "") as typeof TIER_MODELS[number]);
  return i < 0 ? -1 : i;
}
export function resolveRevisionModel(
  issue: JiraIssue, config: ProjectConfig,
  opts: { floorTier: string | null; escalate: boolean }
): string | null {
  const base = resolveModel(issue, config); // existing per-ticket/default resolution
  let idx = Math.max(rank(base), rank(opts.floorTier));
  if (opts.escalate) idx = Math.min(idx + 1, TIER_MODELS.length - 1);
  if (idx < 0) return base; // both unranked → leave Oz default
  return TIER_MODELS[idx]!;
}
```

In `revision.ts` `spawnRevisionRun`, replace `const model = resolveModel(issue, config);` for the revision path with:

```ts
const model = resolveRevisionModel(issue, config, {
  floorTier: params.reviewTier ?? null,
  escalate: params.escalate ?? false,
});
```

Thread `reviewTier` (from `getRevisionState`) and `escalate` (`repeated.length > 0` from `upsertFindings`) through `SpawnRevisionParams` and `recordAndSpawnRevision`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/spawner.ts src/orchestration/spawner.test.ts src/orchestration/revision.ts
git commit -m "feat(orchestration): tier-floored reviser model with escalate-on-repeat"
```

---

## Self-Review

**Spec coverage:**
- Terminal `APPROVE` → Tasks 4 (gate), 6 (reviewer submits it). ✓
- Auto-with-budget (2) → Tasks 1 (column), 4 (gate), 5 (increment + escalate). ✓
- Major+ gate → Tasks 3 (parse/filter), 4 (gate). ✓
- Comment-and-move-on for out-of-scope → Tasks 6 (reviewer Future-work), 8 (reviser DEFER). ✓
- YAGNI on both sides → Tasks 6 (reviewer), 8 (reviser). ✓
- Stable finding IDs + ledger → Tasks 1/2 (DB), 3 (parse), 6 (emit), 10 (project). ✓
- Ledger in DB, projected to sticky comment → Tasks 1/2 (authoritative rows), 9/10 (projection). ✓
- Thin append-only verdicts + dismiss superseded + resolve inline → Tasks 6 (thin/resolve), 9 (dismiss). ✓
- Match-tier reviser + escalate-on-repeat → Tasks 7 (persist tier), 11 (resolve). ✓
- Human escalation when stuck → Task 5 (`escalateToHuman` + `needs_human`). ✓

**Open items requiring a quick read at execution time (not placeholders — concrete wrappers):**
- `getPrDisplayState(prUrl)` and `jira.transitionIssue(key, column)` — confirm exact existing names in `src/db/queries.ts` / `src/jira/client.ts`; add thin wrappers if absent (SQL + body given in Task 5).
- `resolveModel` signature in `spawner.ts` — confirm it accepts `(issue, config)`; Task 11 wraps it without changing it.
- Reviewer skill source location — `pr-review-commenting` is hosted (not in this repo); Tasks 6/7 content is exact, applied at the skill source.

**Type consistency:** `ParsedFinding` (queries.ts) used identically in Tasks 2/3/5. `FindingRow` shared by Tasks 2/10. `GateDecision.action` strings match the switch in Task 5. `TIER_MODELS` order identical in Tasks 7-context and 11. ✓
