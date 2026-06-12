# Jira Integration

HyperDispatch interacts with Jira Cloud via the REST API v3 and the Agile REST API v1.

## Authentication

Basic auth using a service account email + API token (`JIRA_EMAIL` + `JIRA_API_TOKEN`). All requests go to `JIRA_BASE_URL`.

## APIs Used

### Jira REST API v3

- **Get issue**: `GET /rest/api/3/issue/{issueKey}?fields=issuelinks,status,summary,description,priority,{model_field_id}`
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
- It verifies tracked `dispatch_runs` tickets still exist in Jira and removes rows for issues that now return Jira `404` (deleted issues), so stale dashboard entries are cleaned up automatically.
- Scheduler cycles are serialized (the next cycle is scheduled only after the previous cycle completes), preventing overlapping queue reads.
- Spawn dispatch uses an atomic queued-claim update in Postgres before agent creation, so overlapping triggers cannot dispatch the same ticket twice.
- `upsertDispatchRun` conflict handling rejects stale `queued` replays when a row is already `running` or `succeeded`, which prevents webhook backslides from re-queueing active/completed tickets.

## PR Merge to Done

When a worker run completes successfully, HyperDispatch stores the PR URL artifact and moves the issue to `In Review`.
When GitHub sends a signed `pull_request` webhook with `action: "closed"` and `pull_request.merged: true`, HyperDispatch immediately transitions the matching Jira issue to `Done` and unblocks dependent runs.
The monitor still polls GitHub for `succeeded` runs with PR URLs as a backfill path and uses the same idempotent transition helper, so duplicate webhook/monitor observations remain safe.

## Board Validation

The validator checks:
1. Board has all project-configured required columns (`backlog_column_name`, `to_do_column_name`, `in_progress_column_name`, `in_review_column_name`, `done_column_name`).
2. Model override custom field exists (if configured).
3. Workflow statuses include those same configured mapped names.

The Jira API is read-only for board configuration — HyperDispatch reports what's missing but cannot auto-create columns.
