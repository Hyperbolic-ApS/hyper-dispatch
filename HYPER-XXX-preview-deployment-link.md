# Add per-PR Coolify preview deployment link to project settings, dashboard, and GitHub PR

## Summary

Add a per-project `deployment_url` setting. When a dispatch run produces a PR, render a preview-environment link on the dashboard and post the same link as a comment on the GitHub PR. The preview URL follows Coolify's subdomain pattern: `https://pr-{PR_NUMBER}.{deployment_url}`.

## Context

The app is deployed to Coolify, which can spin up a per-PR preview deployment at a subdomain like `pr-42.preview.example.com`. Reviewers currently have to know this convention by heart. We want HyperDispatch to surface the preview URL automatically wherever the PR shows up so reviewers can click straight through to a running build of the change.

This ticket only covers the link surfacing. Configuring Coolify itself to actually create preview deployments is out of scope — assume that's done separately by ops.

## Acceptance Criteria

1. A `deployment_url` field exists on `project_configs` and is editable in the project settings UI at `/config/:projectKey`.
2. The dashboard at `/dashboard` shows a "Preview" link next to the existing "PR" link for any run whose `pr_url` is set AND whose project has a `deployment_url` configured.
3. When a dispatch run transitions to `succeeded` and has a PR URL, a comment is posted to the GitHub PR containing the preview URL. The comment is posted at most once per PR.
4. If `deployment_url` is empty for a project, no preview link is shown and no GitHub comment is posted (no errors, no warnings beyond an info-level log).
5. URL format is exactly `https://pr-{N}.{deployment_url}` where `{N}` is the integer PR number parsed from the PR URL and `{deployment_url}` is the stored value (no scheme, no trailing slash).

## Implementation Plan

### 1. Database migration

**File:** `src/db/schema.sql`
Add the column to the `project_configs` table definition (place after `github_repo`):

```sql
deployment_url TEXT,
```

**File:** `src/db/migrate.ts`
Extend the existing additive migration block so an `ALTER TABLE` runs on existing deployments:

```ts
await sql.unsafe(`
  ALTER TABLE project_configs
    ADD COLUMN IF NOT EXISTS github_pat TEXT,
    ADD COLUMN IF NOT EXISTS jira_api_token TEXT,
    ADD COLUMN IF NOT EXISTS jira_email TEXT,
    ADD COLUMN IF NOT EXISTS deployment_url TEXT;
`);
```

> No new column on `dispatch_runs` is needed for idempotency: `monitor.checkRuns()` only polls runs with `status='running'`, so the success branch fires exactly once per run.

### 2. Update `ProjectConfig` interface and queries

**File:** `src/db/config-queries.ts`

In `ProjectConfig`:
```ts
deployment_url: string | null;
```
(insert after `github_repo: string;`)

In `ProjectConfigInput`:
```ts
deployment_url?: string | null;
```

In `createProjectConfig`: add `deployment_url` to the column list and to the `VALUES` list as `${config.deployment_url ?? null}`.

In `updateProjectConfig`: add `deployment_url = ${merged.deployment_url ?? null},` to the `UPDATE ... SET` block.

### 3. Settings form

**File:** `src/routes/config.ts`

Inside `projectForm()` (around line 152, immediately after the `github_repo` field), add a new field block:

```html
<div class="field">
  <label for="deployment_url">Preview Deployment URL <span style="font-weight:400;color:#6b7280">(optional)</span></label>
  <input type="text" id="deployment_url" name="deployment_url" value="${v.deployment_url ?? ""}" placeholder="preview.example.com">
  <div class="hint">Base domain (no scheme) for Coolify per-PR previews. Resulting URLs look like <code>https://pr-123.preview.example.com</code>. Leave blank to disable preview links.</div>
</div>
```

In the **POST `/`** handler (`configRouter.post("/")`, around line 265), pass through to `createProjectConfig`:
```ts
deployment_url: form.deployment_url ? String(form.deployment_url) : null,
```

In the **POST `/:projectKey`** handler (around line 315), pass through to `updateProjectConfig`:
```ts
deployment_url: form.deployment_url ? String(form.deployment_url) : null,
```

### 4. URL builder utility

Create a new file **`src/preview/url.ts`**:

```ts
/**
 * Build a Coolify-style per-PR preview URL.
 * Returns null if either input is missing or the PR URL cannot be parsed.
 *
 * Example:
 *   buildPreviewUrl("https://github.com/acme/foo/pull/42", "preview.example.com")
 *   => "https://pr-42.preview.example.com"
 */
export function buildPreviewUrl(
  prUrl: string | null | undefined,
  deploymentUrl: string | null | undefined
): string | null {
  if (!prUrl || !deploymentUrl) return null;

  const match = prUrl.match(/\/pull\/(\d+)(?:\b|\/|$)/);
  if (!match) return null;
  const prNumber = match[1];

  // Strip any scheme and trailing slashes from the configured deployment_url.
  const host = deploymentUrl.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!host) return null;

  return `https://pr-${prNumber}.${host}`;
}

/**
 * Extract { owner, repo, prNumber } from a GitHub PR URL.
 * Returns null if the URL doesn't match the expected shape.
 */
export function parseGitHubPrUrl(
  prUrl: string
): { owner: string; repo: string; prNumber: number } | null {
  const match = prUrl.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i
  );
  if (!match) return null;
  return {
    owner: match[1]!,
    repo: match[2]!,
    prNumber: parseInt(match[3]!, 10),
  };
}
```

### 5. Dashboard link

**File:** `src/routes/dashboard.ts`

Imports — add `listProjectConfigs` and the new helper:
```ts
import { getAllDispatchRuns, getRunCountsByStatus, listProjectConfigs } from "../db/config-queries.js";
import { buildPreviewUrl } from "../preview/url.js";
```

In the route handler (`dashboardRouter.get("/")`), update the `Promise.all` to also fetch configs, and build a lookup map:

```ts
const [runs, countRows, configs] = await Promise.all([
  getAllDispatchRuns(),
  getRunCountsByStatus(),
  listProjectConfigs(),
]);

const configByKey = new Map(configs.map((c) => [c.project_key, c]));
```

In the row-rendering block (around line 86–107), compute a preview URL and append it to the action cell. Replace the existing `actionLink` / `<td>${actionLink}…</td>` logic with:

```ts
const cfg = configByKey.get(run.project_key);
const previewUrl = buildPreviewUrl(run.pr_url, cfg?.deployment_url ?? null);

const links: string[] = [];
if (run.status === "running" && run.session_link) {
  links.push(`<a href="${run.session_link}" target="_blank">Session</a>`);
}
if (run.pr_url) {
  links.push(`<a href="${run.pr_url}" target="_blank">PR</a>`);
}
if (previewUrl) {
  links.push(`<a href="${previewUrl}" target="_blank">Preview</a>`);
}
const actionCell = links.length > 0 ? links.join(" · ") : "-";
```

Then render `<td>${actionCell}${blockedByHtml}</td>`.

> Note: this also fixes a small existing limitation — currently the dashboard only shows the PR link for `succeeded` runs. After this change it shows for any run with a `pr_url`, which matches AC #2.

### 6. GitHub PR comment on success

**File:** `src/orchestration/monitor.ts`

Add imports at the top:
```ts
import { Octokit } from "@octokit/rest";
import { getProjectConfig } from "../db/config-queries.js";
import { buildPreviewUrl, parseGitHubPrUrl } from "../preview/url.js";
```

Add a helper near the top of the file (after `getOzClient`):

```ts
async function postPreviewComment(
  prUrl: string,
  deploymentUrl: string,
  authToken: string,
  ticketKey: string
): Promise<void> {
  const previewUrl = buildPreviewUrl(prUrl, deploymentUrl);
  const parsed = parseGitHubPrUrl(prUrl);
  if (!previewUrl || !parsed) return;

  const octokit = new Octokit({ auth: authToken });
  const body = `🚀 **Preview deployment**: ${previewUrl}\n\nThis environment was deployed automatically for PR #${parsed.prNumber}.`;

  try {
    await octokit.issues.createComment({
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.prNumber,
      body,
    });
    console.log(`[monitor] Posted preview link to PR for ${ticketKey}: ${previewUrl}`);
  } catch (err) {
    console.warn(`[monitor] Failed to post preview comment for ${ticketKey}:`, err);
  }
}
```

In the `state === "SUCCEEDED"` branch (currently around lines 71–100), **after** the existing Jira transition try/catch and **before** the trailing `console.log` for "succeeded", add:

```ts
if (prUrl) {
  try {
    const cfg = await getProjectConfig(run.project_key);
    const deploymentUrl = cfg?.deployment_url ?? null;
    const authToken = cfg?.github_pat ?? env.GITHUB_TOKEN;
    if (deploymentUrl && authToken) {
      await postPreviewComment(prUrl, deploymentUrl, authToken, run.ticket_key);
    }
  } catch (err) {
    console.warn(`[monitor] Preview-comment step failed for ${run.ticket_key}:`, err);
  }
}
```

The outer try/catch is a safety net — under no circumstance should a comment-posting failure prevent the run from being marked succeeded (which already happened at line ~75).

## Edge Cases (must handle)

- **Empty `deployment_url`**: no preview link rendered, no comment posted, no error.
- **`pr_url` is null**: no preview link, no comment.
- **`deployment_url` saved with `https://` prefix or trailing slash**: `buildPreviewUrl` normalises both. Verify with unit-style sanity checks (see Testing).
- **PR URL from a non-github.com host or unexpected shape**: `parseGitHubPrUrl` returns null → silently skip the comment (log nothing or a single info line).
- **Octokit auth missing** (no per-project `github_pat` AND no `env.GITHUB_TOKEN`): skip the comment, do not crash.
- **GitHub API returns 4xx/5xx**: caught inside `postPreviewComment`, logged at warn level, run still succeeds.
- **Existing rows in `project_configs`** with no `deployment_url`: column is nullable, defaults to NULL — they keep working unchanged.

## Out of Scope

- Configuring Coolify itself or the GitHub→Coolify webhook.
- Preview database provisioning / seeding (tracked separately).
- Preview environment teardown.
- Preventing duplicate comments across re-runs of the same ticket (each new dispatch run gets at most one comment; if a ticket is re-dispatched and produces a new PR, a new comment is posted to the new PR — that's intended).
- Updating the comment if the preview URL changes (it doesn't — PR number is stable).

## Testing

Manual verification steps for the reviewer:

1. **Migration runs cleanly on an existing DB**: start the app against a DB that already has data; confirm `npm run dev` logs `Database migrations applied successfully` with no errors. Confirm `\d project_configs` shows the new column.
2. **Settings UI**: open `/config/<existing-project>`, confirm the "Preview Deployment URL" field shows up empty, save a value like `preview.example.com`, reload, confirm it persists. Try saving with `https://preview.example.com/` — confirm it still produces a clean URL on the dashboard.
3. **Dashboard with no `deployment_url`**: confirm no Preview link appears for any run.
4. **Dashboard with `deployment_url` set and a run that has a `pr_url`**: confirm a "Preview" link appears next to "PR", pointing at `https://pr-{N}.preview.example.com`.
5. **GitHub comment**: trigger a successful dispatch run end-to-end, or temporarily seed a `dispatch_runs` row with `status='running'` and a real `run_id` that's about to succeed. Confirm a single comment appears on the PR with the expected URL. Confirm no second comment is posted on subsequent monitor ticks.
6. **GitHub comment with no token**: unset `env.GITHUB_TOKEN` and clear `github_pat` for the project; confirm the run still succeeds and a warn log explains the skip (or simply nothing is posted).
7. **Quick sanity check on `buildPreviewUrl`** (paste into a Node REPL or add a throwaway test):
   - `buildPreviewUrl("https://github.com/a/b/pull/7", "preview.example.com")` → `"https://pr-7.preview.example.com"`
   - `buildPreviewUrl("https://github.com/a/b/pull/7", "https://preview.example.com/")` → `"https://pr-7.preview.example.com"`
   - `buildPreviewUrl(null, "preview.example.com")` → `null`
   - `buildPreviewUrl("https://github.com/a/b/pull/7", null)` → `null`
   - `buildPreviewUrl("not a url", "preview.example.com")` → `null`

## Files Touched

- `src/db/schema.sql` — new column
- `src/db/migrate.ts` — additive migration
- `src/db/config-queries.ts` — interface + create + update
- `src/routes/config.ts` — form field + 2 POST handlers
- `src/routes/dashboard.ts` — fetch configs, render preview link
- `src/orchestration/monitor.ts` — post GitHub comment on success
- `src/preview/url.ts` — **new file**, URL helpers

## Dependencies

`@octokit/rest` is already a project dependency (used in `src/github/skills.ts`). No new packages needed.
