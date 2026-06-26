# Task 11 Report — Tier-Floored Reviser Model with Escalate-on-Repeat

## Summary

Task 11 adds capability-matched model selection for revision runs: the reviser model is
floored at the review tier that triggered the review (so a high-tier reviewer is answered
by an equally capable reviser), and bumped one tier higher when any actionable finding
has recurred across rounds.

---

## `resolveRevisionModel` logic (`src/orchestration/spawner.ts`)

```
TIER_MODELS = ["auto-open", "auto-efficient", "auto", "auto-genius"]

resolveRevisionModel(issue, config, { floorTier, escalate }):
  base = resolveModel(issue, config)   // per-ticket field or project default
  idx  = max(rank(base), rank(floorTier))  // rank() = index in TIER_MODELS, -1 if not in list
  if escalate: idx = min(idx + 1, 3)
  if idx < 0: return base              // both unranked → leave Oz workspace default
  return TIER_MODELS[idx]
```

Key properties proven by unit tests:

- **Floor**: a `null` base + `floorTier="auto"` → `"auto"`.
- **Escalate**: `floorTier="auto-efficient"` + `escalate=true` → bumps to `"auto"`.
- **No downgrade**: base `"auto-genius"` + `floorTier="auto-open"` → `"auto-genius"` (max
  keeps the higher rank).
- **Both unranked**: base `"claude-custom"` + `floorTier=null` → returns `"claude-custom"`
  (idx stays -1, early-return preserves the non-tier string).
- **Escalation cap**: `"auto-genius"` + `escalate=true` → stays `"auto-genius"`.

---

## Read-only escalate wiring (`src/orchestration/revision.ts`)

In the `"revise"` branch of `handleGithubRevisionWebhook`, immediately **before**
`recordAndSpawnRevision`:

```ts
const existingFindings = await getOpenFindings(context.pr.htmlUrl);
const existingKeys = new Set(existingFindings.map((f) => f.finding_key));
const escalate = actionable.some((f) => existingKeys.has(f.key));
```

`getOpenFindings` is a SELECT — no INSERT/UPDATE before the spawn guards run. This means:
- A duplicate-delivery (idempotency guard fires) or in-progress (concurrency guard fires)
  does not burn a budget round or corrupt the ledger.
- The post-spawn `upsertFindings` / `dismissSupersededReviews` / `projectLedger` calls are
  left exactly as they were.

`floorTier: state?.reviewTier ?? null` and `escalate` are threaded into the `spawn` object
passed to `recordAndSpawnRevision`, which passes them through `SpawnRevisionParams` (derived
type, no manual update needed) to `spawnRevisionRun`, which passes them to
`resolveRevisionModel`.

---

## Test evidence

### `npx vitest run src/orchestration/spawner.test.ts`
26 tests passed, 0 failed.

New tests added under `describe("resolveRevisionModel")`:
1. floors at floorTier when base is unranked
2. escalates one tier when escalate=true
3. never downgrades below the base model
4. returns base unchanged when both are outside the tier list
5. caps escalation at auto-genius

### `npx vitest run src/orchestration/revision.test.ts`
15 tests passed (14 pre-existing + 1 new), 0 failed.

New test: "escalates model tier when a prior finding key recurs (escalate-on-repeat)"
- `getRevisionState` returns `reviewTier: "auto"` (floor)
- `getOpenFindings` returns `[{ finding_key: "REV-001", ... }]`
- Incoming review body contains `[REV-001]` (matches the existing key)
- `resolveRevisionModelMock` configured to return `"auto-genius"` when `escalate=true`
- Asserts `resolveRevisionModelMock` called with `{ floorTier: "auto", escalate: true }`
- Asserts `runMock.mock.calls[0][0].config.model_id === "auto-genius"`

### Full PGlite suite
299 tests passed across 26 test files, 0 failed.

### Typecheck
`tsc --noEmit` — clean, no errors.

---

## Self-review checklist

- **Read-only repeat check is BEFORE spawn**: `getOpenFindings` runs before
  `recordAndSpawnRevision`. No upsert moved before spawn.
- **No upsert moved before spawn**: the `upsertFindings` call after spawn is unchanged.
- **Model never downgrades below base**: the `Math.max(rank(base), rank(floorTier))`
  invariant ensures this; proven by unit test.

---

## Concerns / follow-up notes

- **`review_tier` persistence is a follow-up (not in this task)**: `state?.reviewTier`
  comes from `dispatch_entries.review_tier`. That column exists (from the Task 1 migration)
  but is only written by `setReviewTier`. The CI workflow step that reads the PR label and
  calls `setReviewTier` (Task 7) is the planned mechanism. Until Task 7 ships,
  `state?.reviewTier` will always be `null`, so `floorTier` will be `null` and escalation
  still fires correctly based on `escalate` alone (provided both base and floorTier rank -1,
  the logic returns base unchanged — correct Oz default behavior).
- **Legacy REV-nnn keys**: the parser normalises these to uppercase (e.g. `"REV-001"`).
  `getOpenFindings` returns DB rows whose `finding_key` was stored by the same parser, so
  keys match across rounds.
- **Manual `/revise` path**: the repeat check only applies to the
  `pull_request_review` branch. The `issue_comment` (`/revise`) branch does not compute
  `escalate` — it passes no `floorTier`/`escalate` to the spawn, so defaults kick in
  (`floorTier=null`, `escalate=false`). This is intentional: manual revisions are
  operator-driven and should not automatically escalate.
