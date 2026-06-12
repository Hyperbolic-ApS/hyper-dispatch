# HyperDispatch Documentation

This folder contains the living documentation for HyperDispatch. It is the canonical reference for how the system works — both for humans and for AI agents working on the codebase.

## Structure

- **[architecture.md](./architecture.md)** — System architecture, component overview, and data flow.
- **[api.md](./api.md)** — HTTP endpoints (webhook, status API, config API, validation).
- **[database.md](./database.md)** — PostgreSQL schema, tables, indexes, and migration notes.
- **[configuration.md](./configuration.md)** — Environment variables, project config, and Jira Automation setup.
- **[worker-agents.md](./worker-agents.md)** — How worker agents are spawned, the skill contract, and the default worker skill.
- **[deployment.md](./deployment.md)** — Dockerfile, Coolify setup, and environment provisioning.
- **[jira-integration.md](./jira-integration.md)** — Jira REST API usage, webhook format, board validation, dependency resolution.
- **[dashboard.md](./dashboard.md)** — Dashboard and config UI routes, data sources, and rendering approach.
- **[verification-hydi-69.md](./verification-hydi-69.md)** — Production verification checklist for PR state webhook propagation and GitHub rate-limit relief.
- **[testing.md](./testing.md)** — Test harness, layering, mocking/fixture conventions, and coverage expectations.

## Keeping Docs Up to Date

This documentation must stay in sync with the implementation. A project skill (`.agents/skills/keep-docs-updated/SKILL.md`) enforces this: any code change that affects behavior, APIs, schema, or configuration must include corresponding documentation updates in this folder.
