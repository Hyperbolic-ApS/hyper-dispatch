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

## 5. Configure Playwright MCP (Headless)

Before implementation, ensure your MCP config contains a Playwright server entry for automated visual verification:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--headless",
        "--isolated",
        "--browser=chromium",
        "--viewport-size=1440,900",
        "--output-dir=./.agent/screenshots"
      ]
    }
  }
}
```

Notes:
- Use `@playwright/mcp` (not interactive browser connectors).
- `--isolated` is required so every ticket run gets a fresh browser profile.
- Keep screenshots under `./.agent/screenshots` so later upload steps can find them.

## 6. Implement

Write the code changes. Follow these principles:

- **Scope tightly**: Only change what's necessary for this ticket. Other agents may be working on the same repo in parallel — minimize merge conflicts by staying in your lane.
- **Follow existing patterns**: Match the codebase's style, conventions, and idioms. Don't introduce new patterns unless the ticket requires it.
- **Keep changes small**: Prefer the smallest correct change over a large refactor.

## 7. UI Screenshot-and-Evaluate Loop (Conditional)

Run this stage only when the ticket touches UI code. Treat a ticket as UI-touching if the diff includes any of:
- paths under `src/components`, `app/`, or `pages/`
- files matching `*.tsx`, `*.jsx`, `*.vue`, `*.css`, or `*.scss`

If the ticket is **not** UI-touching, skip this stage and continue.

If it is UI-touching, run this loop (maximum 4 iterations):

1. Identify affected route(s) from the ticket + code changes.
2. For each route, use `browser_navigate`.
3. Wait for readiness (`networkidle` or a known stable selector) before capture.
4. Capture screenshots with:
   - Desktop viewport: `1440x900`
   - Mobile viewport: `390x844`
   - Filenames per iteration:
     - `./.agent/screenshots/{ticket-key}-{iteration}-desktop.png`
     - `./.agent/screenshots/{ticket-key}-{iteration}-mobile.png`
5. Run `browser_snapshot` and save/record accessibility tree output for evaluation.
6. Evaluate screenshots + snapshot against acceptance criteria.
7. Write a one-paragraph rationale for the iteration:
   - what looks correct
   - what is wrong
   - what code changes are needed
8. If changes are needed, edit code, wait for the app to stabilize/HMR, and repeat.

Loop guardrails:
- Hard cap at 4 iterations (no infinite loops).
- If still unsatisfied at iteration 4, stop looping and document blockers in the PR description.
- On final successful pass, also save:
  - `./.agent/screenshots/{ticket-key}-final-desktop.png`
  - `./.agent/screenshots/{ticket-key}-final-mobile.png`

## 8. Test

Run the project's test suite:
- Read `docs/testing.md` before adding or modifying tests, and follow its layering + mocking conventions.
- Framework is Vitest (`vitest run`).
- Run:
  - `npm test`
  - `npm run test:coverage`
- If tests fail due to your changes, fix them and re-run. Iterate until green.
- Co-locate new tests as `<source>.test.ts` and reuse fixtures from `src/test/fixtures.ts`.
- Backend tickets touching `src/orchestration/`, `src/webhook/`, `src/validator/`, or `src/db/queries.ts` MUST add or update unit tests.

## 9. Lint & Type Check

Run the project's linting and type-checking commands:
- Check package.json scripts, Makefile, or CI config for lint/typecheck commands.
- Run `npm run typecheck` explicitly.
- Fix any issues introduced by your changes.

## 10. Commit

Stage and commit your changes:

```sh
git add -A
git commit -m "{ticket-key}: {summary}

Co-Authored-By: Oz <oz-agent@warp.dev>"
```

Use the ticket key as prefix. The summary should be the ticket's summary (concise, imperative mood). Include the co-author line exactly as shown.

## 11. Create PR

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
For UI-touching tickets, also include:
- Iteration trail (each iteration's screenshot paths + one-paragraph rationale)
- Any unresolved blockers if the 4-iteration cap was reached

Do not upload intermediate screenshots to Jira; keep the trail in the PR only.

## 12. Attach Final Screenshots to Jira (UI Tickets Only)

If the ticket is UI-touching and final screenshots exist, upload them after opening the PR:

```sh
curl -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  -X POST \
  -H "X-Atlassian-Token: no-check" \
  -F "file=@./.agent/screenshots/${TICKET}-final-desktop.png" \
  -F "file=@./.agent/screenshots/${TICKET}-final-mobile.png" \
  "${JIRA_BASE_URL}/rest/api/3/issue/${TICKET}/attachments"
```

Then post a Jira comment (via `addCommentToJiraIssue`) that references the uploaded images, for example:
- `!${TICKET}-final-desktop.png|thumbnail!`
- `!${TICKET}-final-mobile.png|thumbnail!`

If upload/comment fails, record the failure reason in the PR description.

## 13. Report the PR

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
- **UI verification must run headlessly** — the workflow must work in CI with no display server or visible browser window.
