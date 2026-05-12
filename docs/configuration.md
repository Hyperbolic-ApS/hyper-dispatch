# Configuration

## Environment Variables

These are set once for the HyperDispatch instance (not per-project).

| Variable | Required | Default | Description |
|---|---|---|---|
| `JIRA_BASE_URL` | Yes | — | Jira Cloud site URL (e.g., `https://your-site.atlassian.net`) |
| `JIRA_EMAIL` | Yes | — | Service account email for Jira API auth |
| `JIRA_API_TOKEN` | Yes | — | Jira API token |
| `WARP_API_KEY` | Yes | — | Oz API key for spawning agents |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `GITHUB_TOKEN` | Yes | — | GitHub token for skill discovery and repo access |
| `COOLIFY_BASE_URL` | No | — | Coolify base URL (for example `https://coolify.example.com`) used to check prod deployment status |
| `COOLIFY_API_TOKEN` | No | — | Coolify API bearer token used for deployment lookups |
| `COOLIFY_PRODUCTION_APP_UUID` | No | — | Coolify application UUID for the production HyperDispatch deployment target |
| `MAX_CONCURRENT_AGENTS` | No | `4` | Maximum parallel agent runs |
| `MAX_RUN_DURATION_HOURS` | No | `2` | Stale run threshold (hours) |
| `PORT` | No | `3000` | HTTP server port |

## Per-Project Configuration

All per-project settings are stored in the `project_configs` database table and managed via the config UI at `/config`. See [database.md](./database.md) for the full schema.

Key fields:
- **Oz environment ID** — one per Jira project (mono-repo checked out in each).
- **Default model** — LLM model for agent runs. Can be overridden per-ticket via a Jira custom field.
- **Model override field** — Jira custom field ID (e.g., `customfield_10050`). If a ticket has a value in this field, it overrides the project default.
- **Jira column name mappings** — per-project names for Backlog, To Do, In Progress, In Review, and Done. Defaults match Jira defaults, but can be customized for projects that renamed workflow columns/statuses.
- **Skills** — selected from the GitHub repo's skill directories via the config UI.
- **MCP servers JSON** — optional JSON object of MCP server definitions. On save, the config UI validates that the value is valid JSON and is an object; malformed JSON shows an error with the failing line number.

## Jira Automation Setup

One global automation rule is needed (covers all projects):

1. Go to Jira → Project Settings → Automation (or global automation).
2. Create a rule:
   - **Trigger**: "Issue transitioned" (all projects)
   - **Action**: "Send web request"
     - URL: `https://<hyperdispatch-host>/webhook/jira`
     - Method: POST
     - Body:
       ```json
       {
         "issueKey": "{{issue.key}}",
         "projectKey": "{{issue.project.key}}",
         "transitionTarget": "{{issue.status.name}}"
       }
       ```

HyperDispatch ignores webhooks for unconfigured projects.
