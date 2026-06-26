# Task 13 Handler Report — Tasks 5, 8, and 10

## What Was Applied

### Task 10 (sub-step 2a/2b): Create `src/orchestration/ledger.ts` + `ledger.test.ts`

Copied verbatim from `agent/HYDI-44-pr-revision-webhook`. The two exports:
- `renderLedger(rows: FindingRow[]): string` — builds a markdown table between `<!-- review-ledger:start -->` / `<!-- review-ledger:end -->` markers; truncates `finding_key` to 7 chars.
- `projectLedger(octokit, pr, prUrl): Promise<void>` — fetches open findings via `getOpenFindings`, renders, upserts via `upsertStickyComment`.

Both depend on `getOpenFindings` (queries.ts) and `upsertStickyComment` (github/reviews.ts), which already exist on this branch.

### Task 8 (sub-step 2c, buildPrompt only): Update `buildPrompt` in `revision.ts`

Replaced the "Address ALL" blind-implementation body with the triage prompt:
- Opens with "You are **triaging** PR review feedback"
- References `docs/contract/review-revise-contract.md`
- Three-way decision per finding: FIX / DEFER / REJECT
- DEFER reply: "out of scope for this slice" (lowercase, no code)
- Procedure: verify before change, Blocking-first ordering, test after each change
- No performative agreement
- Commit instruction preserved: `<ticket>: Address review feedback` + Co-Authored-By

### Task 5 + Task 10 (sub-step 2c, full gate + escalation): Update `revision.ts` handler

**New imports added:**
- `getRevisionState`, `setNeedsHuman`, `upsertFindings` from `../db/queries.js`
- `DispatchRun` type from `../db/queries.js`
- `dismissSupersededReviews` from `../github/reviews.js`
- `actionableFindings`, `parseFindings` from `./findings.js`
- `projectLedger` from `./ledger.js`
- `decideReviewAction` from `./review-gate.js`

**`TrackedRevisionContext` interface:** Added `prDisplayState: DispatchRun["pr_display_state"]`, populated from `trackedRun.pr_display_state` in `resolveTrackedRevisionContext`.

**`RevisionDecision` union:** Added `{ action: "approve_terminal" }` and `{ action: "escalated_human"; reason: string }`.

**`pull_request_review` branch gate replacement:** The old `extractActionItemIds` + "no action items" short-circuit is replaced by:
1. `parseFindings([reviewBody, ...inlineComments])` → structured findings (contract markers or legacy `[REV-N]`)
2. `actionableFindings(findings)` → filter to Major+/Blocking (severity=undefined treated as actionable for legacy back-compat)
3. `getRevisionState(context.ticketKey)` → `{ round, budget, needsHuman, reviewTier }` (round derived from revision-run count)
4. `decideReviewAction({ reviewState, actionableCount, round, budget, prState, needsHuman })` → gate decision

Gate decision mapping:
- `approve_terminal` → return `{ action: "approve_terminal" }` (no spawn, no ledger)
- `ignore` → return `{ action: "ignored", reason: decision.reason }`
- `escalate_human` → `escalateToHuman(...)` → return `{ action: "escalated_human", reason }`
- `revise` → `recordAndSpawnRevision(...)` first, then (on `spawned`): `upsertFindings` + `dismissSupersededReviews` + `projectLedger`

**`escalateToHuman` helper (Task 5 + 10):**
```
setNeedsHuman(ticketKey, true)
→ octokit.rest.issues.createComment (body lists remaining findings + reason, "budget" word in body)
→ jira.getTransitions / find by in_review_column_name / jira.transitionIssue (in try/catch)
→ projectLedger(octokit, pr, pr.htmlUrl).catch(...)
```
No `dismissSupersededReviews` in escalation (only in the revise path).

**`extractActionItemIds`:** Kept exported (backward compat, tests still reference it).

**`issue_comment` `/revise` path:** Unchanged.

**Idempotency/concurrency:** `recordAndSpawnRevision` call order preserved — spawn first, then findings/ledger writes only after confirmed spawn.

## No-Increment Adaptation

The old branch (`agent/HYDI-44-pr-revision-webhook`) called `incrementRevisionRound(ticketKey)` after the spawn. This function **does not exist** on this branch.

Adaptation: `incrementRevisionRound` is omitted entirely. The revision round is derived at query time in `getRevisionState` as `COUNT(*) FROM dispatch_runs WHERE ticket_key=$1 AND run_type='revision'`. Each `claimRevisionSlot` call inserts one such row (with `run_type='revision'`), so the round increments automatically when the run is spawned — no explicit increment needed.

The `upsertFindings` call uses `(state?.round ?? 0) + 1` as the round number, which correctly reflects the round that will exist after the spawn row is counted.

## Test Evidence

### `src/orchestration/ledger.test.ts` (3 tests, all new)
- Renders ledger table with contract markers (start/end) and severity
- Renders `_none_` placeholder when no findings
- Truncates `finding_key` to 7 characters

### `src/orchestration/revision.test.ts` (14 tests total, 293 total suite)

**New tests added:**
- `returns approve_terminal when the review is approved` — approved state, no spawn, no upsertFindings
- `escalates to human when revision budget is exhausted` — round=2/budget=2, setNeedsHuman called, createComment body contains "budget", no spawn, projectLedger called
- `builds a triage prompt (fix/defer/reject) not 'address all'` — captures prompt via runMock, asserts `/fix.*defer.*reject/is` and "out of scope for this slice", not "Address ALL"

**Updated tests (breaking change: COMMENTED → changes_requested):**
The old tests used `state: "COMMENTED"` which is now ignored by `decideReviewAction` (advisory-only). Updated to `state: "changes_requested"` + added `pr_display_state: "open"` to `makeDispatchRun`. New mock defaults in `beforeEach`:
- `getRevisionStateMock` → `{ round: 0, budget: 2, needsHuman: false, reviewTier: null }`
- `upsertFindingsMock` → `{ repeated: [] }`
- `projectLedgerMock`, `dismissSupersededReviewsMock`, `octokitCreateCommentMock` → all stubs
- `jiraGetTransitionsMock`, `jiraTransitionIssueMock` → stubs for escalateToHuman path

**Renamed "skips spawning when submitted review has no action items"** → "ignores a changes_requested review with no actionable findings", expects `reason: "no actionable (Major+) findings"` (hits the gate's `actionableCount === 0` path rather than the old string-match path).

**Full suite:** 293 tests across 26 test files, all passing. PGlite integration tests included.

**Typecheck:** Clean (`tsc --noEmit` zero errors).

## Divergence from Main's Structure

1. **`recordAndSpawnRevision` / `spawnRevisionRun`:** The old branch (`agent/HYDI-44-pr-revision-webhook`) refactored these to a 3-arg signature (no `runRecordId` in spawn, `updateRunStatus` with `status` field instead of `run_record_id`). The current branch's multi-run architecture keeps `runRecordId` flowing through, with `claimRevisionSlot` inserting the `dispatch_runs` row and `updateRunStatus` targeting it by `run_record_id`. These were kept as-is from HEAD; only the post-spawn side-effects were added.

2. **`DispatchRun` type for `prDisplayState`:** The old branch imported `DispatchRun` from `../db/queries.js` and used `DispatchRun["pr_display_state"]` for the context field. This branch's `DispatchRun` is re-exported from `../db/dispatch-run.js` through queries — the import just needed `import type { DispatchRun, ProjectConfig }` instead of the old `import type { ProjectConfig }`.

## Concerns

- **`upsertFindings` not `.catch`-wrapped after spawn:** If `upsertFindings` throws, the caller sees a thrown error even though the Oz run was spawned successfully. The spawn run record is already in the DB. This is intentional (findings data loss is more serious than ledger data loss) but means a DB failure after spawn would return an error response. Acceptable per the plan — the spawn itself is idempotent (tryRecordRevisionEvent prevents re-spawn on retry).
- **`escalateToHuman` creates a GitHub comment before the Jira transition:** If Jira fails (swallowed), the GitHub comment still posts. The GitHub comment accurately warns the human regardless of Jira state, so this is acceptable.
- **Legacy `[REV-N]` markers now go through `parseFindings` / `actionableFindings` with `severity=undefined`:** `actionableFindings` treats `severity === undefined` as actionable for backward compat. Once the reviewer skill adopts the contract markers, all findings will carry explicit severities.

## Review Follow-up (approved with 3 small fixes)

Applied 3 review fixes to `src/orchestration/revision.ts` / `revision.test.ts`:

- **I1 (Important):** Escalation test now also verifies the Jira transition fires.
  Added `expect(jiraGetTransitionsMock).toHaveBeenCalledWith("HYDI-44")` and
  `expect(jiraTransitionIssueMock).toHaveBeenCalledWith("HYDI-44", "trans-123")`.
  The `beforeEach` mock already returns a transition named "In Review" (matching
  the fixture's `in_review_column_name`), so `transitionIssue` actually runs.
- **I2 (Important):** The `in_progress` test now asserts the budget-burn invariant —
  `upsertFindingsMock`, `projectLedgerMock`, and `dismissSupersededReviewsMock` are
  all NOT called when the slot is already claimed (mirrors the duplicate-delivery test).
- **M1 (Minor):** In the revise branch, `dismissSupersededReviews(...).catch(() => {})`
  now logs via `console.warn("[revision] dismissSupersededReviews failed:", err)`,
  consistent with the adjacent `projectLedger` catch (also upgraded to a logged warn).

Test summary: `revision.test.ts` 14/14 passing; `tsc --noEmit` clean.
