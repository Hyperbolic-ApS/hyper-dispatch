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

## PR Merge to Done

When a worker run completes successfully, HyperDispatch stores the PR URL artifact and moves the issue to `In Review`. If the project has `deployment_url` configured, it also posts a one-time preview link comment to the PR using `https://pr-{N}.{deployment_url}`. The monitor then polls GitHub for `succeeded` runs with PR URLs. Once a PR is merged, HyperDispatch transitions the matching Jira issue to `Done`.

## Board Validation

The validator checks:
1. Board has required columns: Backlog, To Do, In Progress, In Review, Done.
2. Model override custom field exists (if configured).
3. Workflow statuses include the required ones.

The Jira API is read-only for board configuration — HyperDispatch reports what's missing but cannot auto-create columns.
