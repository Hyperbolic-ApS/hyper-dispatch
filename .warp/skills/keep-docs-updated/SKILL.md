---
name: keep-docs-updated
description: "Enforces documentation updates alongside code changes. MUST be triggered after ANY code change that affects behavior, APIs, schema, configuration, deployment, or component interactions. Read this skill before committing or creating PRs."
---

# Keep Documentation Updated

## When This Applies

After ANY code change that affects:
- HTTP endpoints (routes, request/response format, behavior)
- Database schema (tables, columns, indexes, migrations)
- Environment variables or configuration
- Component behavior or interactions
- Deployment (Dockerfile, build process, health checks)
- Jira integration (API usage, webhook format, transitions)
- Worker agent contract (skill expectations, branch naming, artifact output)
- Dashboard or config UI (routes, displayed data, form fields)

## What To Do

1. **Identify affected docs**: Check which files in `docs/` describe the area you changed. The mapping is:
   - Endpoints / routes → `docs/api.md`
   - Database changes → `docs/database.md`
   - Env vars / project config → `docs/configuration.md`
   - System design / components → `docs/architecture.md`
   - Agent spawning / skills / model selection → `docs/worker-agents.md`
   - Docker / Coolify / deployment → `docs/deployment.md`
   - Jira API / webhooks / dependencies → `docs/jira-integration.md`
   - Dashboard / config UI → `docs/dashboard.md`
   - New doc section needed → `docs/README.md` (update the index)

2. **Update the docs**: Make the documentation match the new reality. Be precise and concise. Don't add aspirational content — only document what is actually implemented.

3. **Include in the same commit**: Documentation updates must be part of the same commit or PR as the code change. Never defer doc updates to a follow-up.

## What NOT To Do

- Do not update docs for purely internal refactors that don't change behavior or interfaces.
- Do not add implementation details that are obvious from reading the code (e.g., variable names, internal function signatures). Docs are for concepts, contracts, and configuration.
- Do not duplicate the PLAN.md. The `docs/` folder documents what IS implemented. PLAN.md documents what WILL BE implemented.
