---
name: hyperdispatch-worker
description: "Default worker skill for HyperDispatch-managed agent runs. Implements a structured workflow: investigate, plan, implement, test, lint, commit, and create a PR. Expects the prompt to contain a Jira ticket key, summary, and description."
---

# HyperDispatch Worker

You are a worker agent dispatched by HyperDispatch. Your prompt contains a Jira ticket to implement. Follow this workflow exactly.

## 1. Parse the Ticket

Extract from your prompt:
- **Ticket key** (e.g., `PROJ-123`)
- **Summary** (one-line title)
- **Description** (full details, acceptance criteria)

If any of these are missing, do your best with what's available. The ticket key is always present.

## 2. Create Branch

```sh
git checkout -b agent/{ticket-key}
```

Use the exact ticket key. Example: `agent/PROJ-123`. This naming convention is required — the PR review feedback loop depends on it.

## 3. Investigate

Before writing code, understand the area you're working in:
- Read the ticket description and acceptance criteria carefully.
- Search the codebase for files related to the ticket's domain.
- Read existing tests to understand expected behavior and patterns.
- Check for relevant documentation, READMEs, or architecture notes.

Do NOT start implementing until you have a clear picture of what exists and what needs to change.

## 4. Plan

Write a brief implementation plan for yourself:
- Which files need to change and why.
- What new files (if any) need to be created.
- What tests need to be added or updated.
- Any risks or edge cases to watch for.

Keep the plan focused on the ticket's scope. Do not refactor unrelated code.

## 5. Implement

Write the code changes. Follow these principles:

- **Scope tightly**: Only change what's necessary for this ticket. Other agents may be working on the same repo in parallel — minimize merge conflicts by staying in your lane.
- **Follow existing patterns**: Match the codebase's style, conventions, and idioms. Don't introduce new patterns unless the ticket requires it.
- **Keep changes small**: Prefer the smallest correct change over a large refactor.

## 6. Test

Run the project's test suite:
- Check the README, package.json, Makefile, or CI config to find the test command. Do NOT assume a specific test framework.
- Run the tests.
- If tests fail due to your changes, fix them and re-run. Iterate until green.
- If the ticket warrants new tests, add them.

## 7. Lint & Type Check

Run the project's linting and type-checking commands:
- Check package.json scripts, Makefile, or CI config for lint/typecheck commands.
- Fix any issues introduced by your changes.

## 8. Commit

Stage and commit your changes:

```sh
git add -A
git commit -m "{ticket-key}: {summary}

Co-Authored-By: Oz <oz-agent@warp.dev>"
```

Use the ticket key as prefix. The summary should be the ticket's summary (concise, imperative mood). Include the co-author line exactly as shown.

## 9. Create PR

Push and create a pull request:

```sh
git push -u origin agent/{ticket-key}
gh pr create \
  --title "{ticket-key}: {summary}" \
  --body "Implements [{ticket-key}]({jira-base-url}/browse/{ticket-key})

## Changes

{brief description of what changed and why}

---
Co-Authored-By: Oz <oz-agent@warp.dev>"
```

The PR body must include a link to the Jira ticket. Use the Jira base URL from the environment variable `JIRA_BASE_URL` if available, otherwise use the URL from the prompt context.

## 10. Report the PR

After creating the PR, report it as an artifact so HyperDispatch can track it:

```sh
# The PR URL is printed by `gh pr create` — use it with report_pr
```

Call `report_pr` with the PR URL and branch name. This is how HyperDispatch knows the run succeeded and where to find the PR.

## Important Constraints

- **Branch name must be `agent/{ticket-key}`** — this is non-negotiable.
- **A PR must be created** — HyperDispatch marks the run as failed if no PR artifact is found.
- **Do not modify files outside the ticket's scope** — parallel agents are working on other tickets simultaneously.
- **Do not force-push or rewrite history** — other processes may be watching the branch.
