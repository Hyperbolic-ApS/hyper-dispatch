# Fix: cascade-delete review_findings with its ticket (deleteRun FK fix)

## Problem

`review_findings.ticket_key` had `REFERENCES dispatch_entries(ticket_key)` without `ON DELETE CASCADE`. `deleteRun()` deletes from `dispatch_entries`, which cascades to `dispatch_runs` (already correct) but not to `review_findings`, causing a FK violation (`23503`) whenever a ticket with any findings row was deleted.

## Files Changed

### `src/db/schema.sql` (line 87)
```diff
-  ticket_key       TEXT NOT NULL REFERENCES dispatch_entries(ticket_key),
+  ticket_key       TEXT NOT NULL REFERENCES dispatch_entries(ticket_key) ON DELETE CASCADE,
```

### `src/db/migrate.ts` (line 183)
```diff
-      ticket_key       TEXT NOT NULL REFERENCES dispatch_entries(ticket_key),
+      ticket_key       TEXT NOT NULL REFERENCES dispatch_entries(ticket_key) ON DELETE CASCADE,
```

The additive `CREATE TABLE IF NOT EXISTS review_findings` block in `migrate.ts` matches the schema.sql definition. The table is brand-new in this branch with no existing deployments, so no constraint-drop migration is needed.

### `src/db/queries.integration.test.ts`
Added regression test: `"integration: deleteRun cascades to review_findings and does not throw FK violation"`.

The test:
1. Seeds a `dispatch_entries` row via `upsertDispatchRun`
2. Inserts a `review_findings` row via `upsertFindings`
3. Calls `deleteRun(ticketKey)`
4. Asserts it resolves without throwing
5. Asserts `review_findings` rows for that PR are gone (CASCADE removed them)

## RED → GREEN Evidence

**Before fix (schema without ON DELETE CASCADE):**
```
FAIL src/db/queries.integration.test.ts > queries integration > integration: deleteRun cascades to review_findings and does not throw FK violation
AssertionError: promise rejected "error: update or delete on table "dispatc…"
Caused by: error: update or delete on table "dispatch_entries" violates foreign key constraint
  "review_findings_ticket_key_fkey" on table "review_findings"
  detail: Key (ticket_key)=(HYDI-9910) is still referenced from table "review_findings".
1 failed | 31 passed (integration pattern)
```

**After fix (ON DELETE CASCADE added to both files):**
```
✓ src/db/queries.integration.test.ts (28 tests) 1253ms
✓ src/db/migrate.integration.test.ts (2 tests) 1584ms
Test Files  4 passed | 22 skipped (26)
Tests       32 passed | 268 skipped (300)
```

Typecheck: `npm run typecheck` exits 0 (no errors).
