---
name: hyperdispatch-worker
description: "Default worker skill for HyperDispatch-managed agent runs. Implements a structured workflow: investigate, plan, implement, test, lint, commit, and create a PR. Expects the prompt to contain a Jira ticket key, summary, and description."
---

# HyperDispatch Worker

You are a worker agent dispatched by HyperDispatch. Your prompt contains a Jira ticket to implement. Follow this workflow exactly.

## Connecting to Jira (REST API)

You do not have a Jira MCP — talk to Jira Cloud directly over its REST API. Credentials are provided as environment variables; never print, echo, or log them (reference them only as `$VAR`):
- `JIRA_API_TOKEN` — a **scoped** API token (starts with `ATSTT…`).
- `JIRA_CLOUD_ID` — the Jira Cloud instance ID.
- `JIRA_SITE_URL` — the human site URL (e.g. `https://your-org.atlassian.net`); used for `/browse/` links only, never for API calls.
- `JIRA_EMAIL` — the service-account email (informational; NOT used for auth below).

**Authenticate with a Bearer token against the Atlassian API gateway, keyed by cloud ID — not basic auth against the site URL.** This scoped token returns `401` with `curl -u email:token` and/or when hitting `$JIRA_SITE_URL/rest/...` directly.

```sh
# Base URL for ALL API calls (api.atlassian.com gateway, keyed by cloud ID)
JIRA_API="https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}"

# Example: fetch an issue
curl -s \
  -H "Authorization: Bearer ${JIRA_API_TOKEN}" \
  -H "Accept: application/json" \
  "${JIRA_API}/rest/api/3/issue/${TICKET}?fields=summary,status,description"
```

Verify connectivity with `GET ${JIRA_API}/rest/api/3/serverInfo` (expect HTTP `200`).

Pitfalls:
- Do NOT use basic auth (`curl -u "$JIRA_EMAIL:$JIRA_API_TOKEN"`) and do NOT hit `$JIRA_SITE_URL/rest/...` — both fail with `401`/`Unauthorized` for this scoped token.
- The token is scoped: some endpoints (e.g. `/myself`) may return `401 "scope does not match"` even though the token is valid — stick to the issue/project/field endpoints you actually need.
- `GET /rest/api/3/search` is removed (returns `410`); use `POST ${JIRA_API}/rest/api/3/search/jql` with a JSON body instead.

## 1. Parse the Ticket

Extract from your prompt:
- **Ticket key** (e.g., `PROJ-123`)
- **Summary** (one-line title)
- **Description** (full details, acceptance criteria)

If any of these are missing, do your best with what's available. The ticket key is always present.

## 2. Create Branch

```sh
SUMMARY_SLUG=$(printf '%s' "{summary}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g; s/-+/-/g' | cut -d- -f1-3)
if [ -n "$SUMMARY_SLUG" ]; then
  BRANCH_NAME="agent/{ticket-key}-${SUMMARY_SLUG}"
else
  BRANCH_NAME="agent/{ticket-key}"
fi
git checkout -b "$BRANCH_NAME"
```

Branch names must include the ticket key plus a short descriptor to improve scanability in GitHub/Jira/tooling. Keep descriptors minimal:
- prefer 2-3 words (at most 4)
- avoid filler words (`add`, `the`, `to`, `for`, `and`, etc.) unless needed for clarity
- keep total suffix length concise (aim ~24 characters max)

Examples:
- ✅ `agent/PROJ-123-github-webhooks`
- ✅ `agent/PROJ-123-descriptive-branch-name`
- ❌ `agent/PROJ-123-add-short-descriptive-text-to-branch-name`

This convention is required — the PR review feedback loop depends on extracting `{ticket-key}` from the branch name.
If the normalized summary slug is empty (for example, punctuation-only summaries), fall back to `agent/{ticket-key}` (no trailing hyphen).

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
- Standard runs must not rely on skipped tests (`it.skip` / `describe.skip`); use env-gated inclusion for external integrations instead.
- Co-locate new tests as `<source>.test.ts` and reuse fixtures from `src/test/fixtures.ts`.
- Backend tickets touching `src/orchestration/`, `src/webhook/`, `src/validator/`, or `src/db/queries.ts` MUST add or update unit tests.
- Coverage target for backend initiatives is ≥75% in `src/orchestration/`, `src/webhook/`, and `src/validator/`.

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
git push -u origin "$(git branch --show-current)"
gh pr create \
  --title "{ticket-key}: {summary}" \
  --body "Implements [{ticket-key}](${JIRA_SITE_URL}/browse/{ticket-key})

## Changes

{brief description of what changed and why}

---
Co-Authored-By: Oz <oz-agent@warp.dev>"
```

Create a normal pull request (non-draft) — do not pass `--draft`. The Oz harness may still open the PR as a draft, so immediately convert it to ready-for-review after creation and confirm the result:

```sh
gh pr ready
gh pr view --json isDraft --jq '.isDraft'   # expect: false
```

`gh pr ready` acts on the PR for the current branch (or pass the URL/number printed by `gh pr create`). It is a no-op when the PR is already ready, so it is always safe to run. If `isDraft` is still `true`, retry `gh pr ready` before continuing.

The PR body must include a link to the Jira ticket. Build the `/browse/{ticket-key}` link from the `JIRA_SITE_URL` environment variable (the human site URL, not the `api.atlassian.com` gateway); fall back to the URL from the prompt context if it is unset.
For UI-touching tickets, also include:
- Iteration trail (each iteration's screenshot paths + one-paragraph rationale)
- Any unresolved blockers if the 4-iteration cap was reached

Do not upload intermediate screenshots to Jira; keep the trail in the PR only.

## 12. Attach Final Screenshots to Jira (UI Tickets Only)

If the ticket is UI-touching and final screenshots exist, upload them after opening the PR:

```sh
curl -X POST \
  -H "Authorization: Bearer ${JIRA_API_TOKEN}" \
  -H "X-Atlassian-Token: no-check" \
  -F "file=@./.agent/screenshots/${TICKET}-final-desktop.png" \
  -F "file=@./.agent/screenshots/${TICKET}-final-mobile.png" \
  "https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}/rest/api/3/issue/${TICKET}/attachments"
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

- **Branch name must be `agent/{ticket-key}-{short-descriptor}`** — this is non-negotiable. Keep descriptor short and human-scannable.
- **A PR must be created** — HyperDispatch marks the run as failed if no PR artifact is found.
- **PRs must not be drafts** — always create a normal, ready-for-review pull request. Never pass `--draft` to `gh pr create`, and run `gh pr ready` immediately after creation to force the PR out of draft state (verify with `gh pr view --json isDraft`).
- **Do not modify files outside the ticket's scope** — parallel agents are working on other tickets simultaneously.
- **Do not force-push or rewrite history** — other processes may be watching the branch.
- **UI verification must run headlessly** — the workflow must work in CI with no display server or visible browser window.
