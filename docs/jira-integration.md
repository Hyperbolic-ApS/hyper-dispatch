# Jira Integration

HyperDispatch interacts with Jira Cloud via the REST API v3 and the Agile REST API v1.

## Authentication

A **scoped** API token (`JIRA_API_TOKEN`) sent as a Bearer token to the Atlassian API gateway, keyed by `JIRA_CLOUD_ID`. All API requests go to `https://api.atlassian.com/ex/jira/{JIRA_CLOUD_ID}` (see `src/jira/client.ts`). Basic auth (`email:token`) and requests against `JIRA_SITE_URL/rest/...` are rejected with `401` by this token type. `JIRA_SITE_URL` is the human site URL and is used only for `/browse/{key}` links, not API calls.

## APIs Used

### Jira REST API v3

- **Get issue**: `GET /rest/api/3/issue/{issueKey}?fields=issuelinks,status,summary,description,priority,{model_field_id}`
- **Bulk fetch issues**: `POST /rest/api/3/issue/bulkfetch` (max 100 keys per request) — batches ticket-status reads for the dashboard and the scheduler's deleted-issue reconciliation, replacing one `GET /issue/{key}` per tracked run. Keys that no longer exist (or are not visible) are omitted from the response rather than failing it.
- **Transition issue**: `POST /rest/api/3/issue/{issueKey}/transitions` — used to move tickets between columns (To Do → In Progress → In Review → Done).
- **Get transitions**: `GET /rest/api/3/issue/{issueKey}/transitions` — to find the transition ID for a target status.
- **List fields**: `GET /rest/api/3/field` — for validating that the model override custom field exists.
- **List statuses**: `GET /rest/api/3/status` — for validating workflow statuses.
- **Add comment**: `POST /rest/api/3/issue/{issueKey}/comment` — to post the PR link on the ticket.

### Jira Agile REST API v1

- **Board configuration**: `GET /rest/agile/1.0/board/{boardId}/configuration` — returns `columnConfig.columns` with column names and mapped status IDs. Used by the Jira Project Validator.
- **List boards**: `GET /rest/agile/1.0/board?projectKeyOrId={key}` — to find the board ID for a project during config setup.

## Dependency Resolution

Issue links are fetched via the `issuelinks` field on `GET /rest/api/3/issue/{key}`. Blocking relationships use:
- `link.type.inward === "is blocked by"` with `link.inwardIssue` — this ticket is blocked by the linked issue.

A ticket is eligible only when all its blockers have a status category of "Done".

Cycles in the blocking graph (A blocks B blocks A) are detected via DFS before eligibility is checked. Tickets in a cycle are stored with status `blocked_cycle` and will not be queued automatically.

## Webhook Format

See [configuration.md](./configuration.md) for the Jira Automation rule setup. The webhook payload is:

```json
{
  "issueKey": "PROJ-123",
  "projectKey": "PROJ",
  "transitionTarget": "To Do"
}
```
`transitionTarget` is matched against configured per-project column/status names, not hardcoded labels:
- `to_do_column_name` triggers queueing logic.
- `done_column_name` triggers unblock checks.

## Polling Backfill

In addition to webhook-triggered ingestion, the scheduler loop performs a Jira reconciliation poll each cycle:
- It queries each active project's configured `to_do_column_name` and auto-ingests tickets that are in To Do but missing from `dispatch_runs` (same cycle/dependency checks as webhook ingestion).
- It verifies tracked `dispatch_runs` tickets still exist in Jira using a single batched `bulkfetch` per project (max 100 keys per request) and removes rows whose keys are absent from the response (deleted/inaccessible issues), so stale dashboard entries are cleaned up automatically. If the batch request fails, deletions are skipped for that cycle so live runs are never removed on a transient error.
- Scheduler cycles are serialized (the next cycle is scheduled only after the previous cycle completes), preventing overlapping queue reads.
- Spawn dispatch uses an atomic queued-claim update in Postgres before agent creation, so overlapping triggers cannot dispatch the same ticket twice.
- `upsertDispatchRun` conflict handling rejects stale `queued` replays when a row is already `running` or `succeeded`, which prevents webhook backslides from re-queueing active/completed tickets.

## PR Merge to Done

When a worker run completes successfully, HyperDispatch stores the PR URL artifact, posts a Jira comment with that PR URL, and moves the issue to `In Review`.
Newly created worker PRs are forced out of draft state by the monitor, not the webhook. The GitHub `opened` event fires the instant the worker creates the PR — before the run's `pr_url` is persisted (it is only recorded once the Oz run reaches `SUCCEEDED`), so an `opened`-triggered lookup cannot reliably find the run. Instead, when the monitor reconciles a tracked `succeeded` run whose PR is still a draft, it marks the PR ready-for-review via the GitHub GraphQL `markPullRequestReadyForReview` mutation (keyed by the PR's `node_id`) and persists `pr_display_state: "open"`. GitHub's REST "update a pull request" endpoint cannot change a PR's draft state, so GraphQL is required. The mutation reuses the PR fetch the monitor already performs and is safe to retry: it runs only while the PR reads back as a draft.
When GitHub sends a signed `pull_request` webhook with `action: "closed"` and `pull_request.merged: true`, HyperDispatch immediately transitions the matching Jira issue to `Done` and unblocks dependent runs.
The monitor still polls GitHub for `succeeded` runs with PR URLs as a backfill path and uses the same idempotent transition helper, so duplicate webhook/monitor observations remain safe. To keep this sweep bounded as succeeded runs accumulate, the monitor skips the GitHub re-fetch for runs already in a terminal PR display state (`merged`/`closed`): their conflict/display metadata no longer changes and the Done transition was already attempted in the cycle that first observed the terminal state. Within each sweep, succeeded-run reconciliation is de-duplicated by `pr_url`, so multiple run rows that reference the same PR share one GitHub `pulls.get` fetch for that cycle.

## PR Review Revision Triggers

Signed GitHub webhook events also drive in-app PR revision runs:
- `pull_request_review` with `action: "submitted"` triggers automatic revision analysis.
- Submitted review content is scanned for actionable items (`REV-###` IDs / action-list entries); if none are present, no Oz revision run is spawned.
- `issue_comment` with `/revise ...` triggers manual revision; HyperDispatch still reads ticket context but forwards only the explicit `/revise` instruction text to the revision run.
- `pull_request_review_comment` events are ignored for spawning so inline-comment replies/subcomments do not create duplicate revision runs.
- Revision spawns are deduplicated by GitHub review/comment id (`revision_events` ledger) and guarded by an atomic revision-slot claim that updates the ticket to `running` and inserts the revision `dispatch_runs` row in the same SQL statement, so webhook redeliveries and rapid successive reviews cannot spawn duplicate or overlapping revision runs on the same branch.
- For revision runs, the claimed run row already exists before `agent.run` is called; if spawn fails, that claimed row is cleaned up and the slot/idempotency key are released so a retry can start exactly one tracked run.

## Board Validation

The validator checks:
1. Board has all project-configured required columns (`backlog_column_name`, `to_do_column_name`, `in_progress_column_name`, `in_review_column_name`, `done_column_name`).
2. Model override custom field exists (if configured).
3. Workflow statuses include those same configured mapped names.

The Jira API is read-only for board configuration — HyperDispatch reports what's missing but cannot auto-create columns.
