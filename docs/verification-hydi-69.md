# HYDI-69 Production Verification Runbook
This runbook validates end-to-end webhook-driven PR state updates and confirms GitHub PR-status rate-limit relief in production.

## Scope
- PR lifecycle path A: `open → draft → ready for review → closed`
- PR lifecycle path B: `open → merged`
- Dashboard state reflection within the normal auto-refresh window (15s)
- No live GitHub PR-status calls during dashboard rendering in normal operation
- Merged PR transitions Jira issue to `Done` and unblocks dependent tickets
- No sustained GitHub rate-limit (`403`) errors in Coolify logs during dashboard use

## Prerequisites
- HYDI dependencies complete: `T3`, `T5`, `T6`
- A tracked repository/project is configured in HyperDispatch (`/config`)
- Access to:
  - GitHub repo used by the tracked project
  - Jira project (`HYDI`)
  - Production dashboard (`/dashboard`)
  - Coolify application logs for HyperDispatch

## Test Data Setup
Create or identify:
1. Ticket `A` for lifecycle path A (close without merge).
2. Ticket `B` for lifecycle path B (merge).
3. Ticket `C` blocked by ticket `B` (to verify unblock on merged→Done path).

Ensure HyperDispatch has active runs for both `A` and `B` with PR URLs visible on the dashboard.

## Verification Steps

### 1) Path A: open → draft → ready → close
For ticket `A`'s PR:
1. Ensure PR is initially open (non-draft).
2. Convert PR to draft.
3. Mark PR ready for review.
4. Close PR (without merging).

For each transition:
- Observe `GET /dashboard` within one refresh cycle (≤15s typical).
- Confirm PR link suffix updates match the state:
  - Draft: `(Draft)`
  - Closed: `(Closed)`
  - Open/ready: no suffix
- Confirm no stale state persists beyond one refresh cycle.

### 2) Path B: open → merge
For ticket `B`'s PR:
1. Ensure PR is open.
2. Merge PR.

Verify on dashboard within one refresh cycle:
- PR link suffix becomes `(Merged)`.
- Ticket `B` transitions to Jira `Done`.
- Blocked ticket `C` is unblocked and becomes eligible (no longer blocked by `B`).

## Rate-Limit Relief Verification

### 3) Sustained dashboard usage
Run sustained dashboard use for at least 10 minutes:
- Keep `/dashboard` open in one tab.
- In a second tab/session, repeatedly switch focus to trigger visibility-based immediate refresh.
- Optionally filter by project/status repeatedly to force normal render paths.

### 4) Coolify logs inspection
Inspect HyperDispatch app logs during and after sustained usage.

Pass criteria:
- No GitHub PR-status rate-limit `403` entries.
- No repeated warnings matching:
  - `[dashboard] Failed to load PR status ...`

If either appears during normal operation, capture timestamps and associated ticket keys as failure evidence.

## Evidence to Record
Capture and attach to HYDI-69:
- Timestamped screenshots or notes for each PR state transition in paths A and B
- Jira status transition evidence for ticket `B` to `Done`
- Evidence that ticket `C` became unblocked
- Coolify log excerpt for the sustained-usage window showing absence of:
  - PR-status `403`
  - `[dashboard] Failed to load PR status ...`

## Acceptance Mapping
- **PR state transitions reflected via webhook**: validated by path A + B dashboard updates.
- **Merged → Done works**: validated by ticket `B` transition to `Done`.
- **Dependents unblocked**: validated by ticket `C` eligibility/unblocked state.
- **No GitHub PR-status rate-limit errors**: validated by sustained-usage log review.
