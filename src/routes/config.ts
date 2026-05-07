import { Hono } from "hono";
import {
  listProjectConfigs,
  getProjectConfig,
  createProjectConfig,
  updateProjectConfig,
  deactivateProjectConfig,
  type ProjectConfig,
} from "../db/config-queries.js";
import { discoverSkills } from "../github/skills.js";
import { validateJiraProject } from "../validator/jira.js";
import { DEFAULT_JIRA_COLUMN_MAPPINGS } from "../jira/columns.js";
import { brandIconSvg, faviconDataUri } from "./branding.js";

export const configRouter = new Hono();

function formColumnName(
  form: Record<string, unknown>,
  key: string,
  fallback: string
): string {
  const value = form[key];
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

// ─── Shared CSS ────────────────────────────────────────────────────────────────

const CSS = `
  body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #f9fafb; color: #111; }
  .page-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .brand-logo { width: 30px; height: 30px; flex: 0 0 auto; display: inline-flex; }
  .brand-title { margin: 0; font-size: 1.1rem; font-weight: 700; }
  h1, h2 { margin: 0 0 16px; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; }
  nav { margin-bottom: 20px; }
  nav a { margin-right: 12px; color: #3b82f6; text-decoration: none; font-weight: 500; }
  nav a:hover { text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }
  th { background: #f3f4f6; text-align: left; padding: 10px 12px; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; }
  td { padding: 10px 12px; border-bottom: 1px solid #f3f4f6; font-size: 0.875rem; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  a { color: #3b82f6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .badge { padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
  .badge-active { background:#22c55e;color:#fff; }
  .badge-inactive { background:#6b7280;color:#fff; }
  .form-card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 24px; max-width: 640px; }
  .field { margin-bottom: 16px; }
  label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 4px; }
  input[type=text], input[type=number], input[type=password], textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem; font-family: inherit; }
  textarea { min-height: 80px; resize: vertical; }
  input[type=checkbox] { width: auto; }
  .hint { font-size: 0.75rem; color: #6b7280; margin-top: 3px; }
  .btn { display: inline-block; padding: 8px 18px; border-radius: 6px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: 1px solid transparent; text-decoration: none; line-height: 1.2; }
  .btn-primary { background: #3b82f6; border-color: #2563eb; color: #fff; }
  .btn-primary:hover { background: #2563eb; }
  .btn-danger { background: #ef4444; border-color: #dc2626; color: #fff; }
  .btn-danger:hover { background: #dc2626; }
  .btn-secondary { background: #e5e7eb; border-color: #d1d5db; color: #111; }
  .btn-secondary:hover { background: #d1d5db; }
  .btn:hover { text-decoration: none; }
  .btn-small { padding: 6px 10px; font-size: 0.8rem; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 20px; }
  .skill-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .skill-tag { background:#dbeafe;color:#1e40af;padding:3px 10px;border-radius:4px;font-size:0.75rem; }
  #skills-picker { display: none; margin-top: 8px; border: 1px solid #d1d5db; border-radius: 6px; padding: 8px; background: #f9fafb; max-height: 200px; overflow-y: auto; }
  #skills-picker label { font-weight: normal; display: flex; align-items: center; gap: 6px; padding: 4px 0; cursor: pointer; }
`;

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title} — HyperDispatch</title>
  <link rel="icon" href="${faviconDataUri()}">
  <style>${CSS}</style>
</head>
<body>
  <div class="page-header">
    <span class="brand-logo">${brandIconSvg()}</span>
    <p class="brand-title">HyperDispatch</p>
  </div>
  <nav>
    <a href="/dashboard">Dashboard</a>
    <a href="/config">Projects</a>
  </nav>
  ${body}
</body>
</html>`;
}

function projectForm(
  action: string,
  config?: Partial<ProjectConfig>,
  projectKey?: string
): string {
  const v = config ?? {};
  const skillsValue = (v.skills ?? []).join(", ");

  const skillsPickerScript = `
<script>
async function loadSkills() {
  const repo = document.getElementById('github_repo').value.trim();
  const githubPat = document.getElementById('github_pat').value.trim();
  if (!repo || !repo.includes('/')) {
    alert('Enter a valid owner/repo first (e.g. myorg/myrepo)');
    return;
  }
  const btn = document.getElementById('discover-btn');
  btn.textContent = 'Loading...';
  btn.disabled = true;
  try {
    const key = document.getElementById('project_key_field')?.value || '';
    const res = await fetch('/config/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo,
        projectKey: key || undefined,
        githubPat: githubPat || undefined,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const skills = await res.json();
    const picker = document.getElementById('skills-picker');
    picker.innerHTML = '';
    if (skills.length === 0) {
      picker.innerHTML = '<em style="color:#6b7280">No skills found in repo</em>';
    } else {
      const current = document.getElementById('skills').value.split(',').map(s => s.trim()).filter(Boolean);
      for (const s of skills) {
        const checked = current.includes(s.spec) ? 'checked' : '';
        picker.innerHTML += '<label><input type="checkbox" value="' + s.spec + '" ' + checked + ' onchange="syncSkills()"> ' + s.name + ' <span style="color:#6b7280;font-size:0.7rem">(' + s.spec + ')</span></label>';
      }
    }
    picker.style.display = 'block';
  } catch(e) {
    alert('Error: ' + e.message);
  } finally {
    btn.textContent = 'Discover Skills';
    btn.disabled = false;
  }
}
function syncSkills() {
  const boxes = document.querySelectorAll('#skills-picker input[type=checkbox]');
  const selected = Array.from(boxes).filter(b => b.checked).map(b => b.value);
  document.getElementById('skills').value = selected.join(', ');
}
</script>`;

  return `
<div class="form-card">
  <form method="POST" action="${action}">
    <input type="hidden" id="project_key_field" value="${v.project_key ?? ""}">
    <div class="field">
      <label for="project_key">Project Key</label>
      <input type="text" id="project_key" name="project_key" value="${v.project_key ?? ""}" ${config ? "readonly" : ""} required>
      <div class="hint">Jira project key, e.g. MYPROJ</div>
    </div>
    <div class="field">
      <label for="jira_cloud_id">Jira Cloud ID</label>
      <input type="text" id="jira_cloud_id" name="jira_cloud_id" value="${v.jira_cloud_id ?? ""}" required>
      <div class="hint">Find this in Jira &rarr; Settings &rarr; Products. It\'s the UUID in Jira API URLs, e.g. <code>https://api.atlassian.com/ex/jira/<strong>CLOUD-ID</strong>/rest/...</code></div>
    </div>
    <div class="field">
      <label for="board_id">Board ID</label>
      <input type="number" id="board_id" name="board_id" value="${v.board_id ?? ""}" required>
      <div class="hint">Go to your Jira board &rarr; the board ID is the number in the URL: <code>/jira/software/projects/PROJ/boards/<strong>123</strong></code></div>
    </div>
    <div class="field">
      <label for="oz_env_id">Oz Environment ID</label>
      <input type="text" id="oz_env_id" name="oz_env_id" value="${v.oz_env_id ?? ""}" required>
      <div class="hint">Run <code>oz environment list</code> in your terminal, or find it in Warp &rarr; Settings &rarr; Environments</div>
    </div>
    <div class="field">
      <label for="github_repo">GitHub Repo</label>
      <input type="text" id="github_repo" name="github_repo" value="${v.github_repo ?? ""}" required>
      <div class="hint">Format: owner/repo</div>
    </div>
    <div class="field">
      <label for="default_model">Default Model</label>
      <input type="text" id="default_model" name="default_model" value="${v.default_model ?? ""}">
      <div class="hint">e.g. claude-sonnet-4-5</div>
    </div>
    <div class="field">
      <label for="model_field_id">Model Field ID</label>
      <input type="text" id="model_field_id" name="model_field_id" value="${v.model_field_id ?? ""}">
      <div class="hint">In Jira, go to Settings &rarr; Issues &rarr; Custom Fields. Click the field &rarr; the ID is in the URL, e.g. <code>customfield_10050</code></div>
    </div>
    <div class="field">
      <label for="backlog_column_name">Backlog Column Name</label>
      <input type="text" id="backlog_column_name" name="backlog_column_name" value="${v.backlog_column_name ?? DEFAULT_JIRA_COLUMN_MAPPINGS.backlog}">
      <div class="hint">Column/status name used as Backlog for this project.</div>
    </div>
    <div class="field">
      <label for="to_do_column_name">To Do Column Name</label>
      <input type="text" id="to_do_column_name" name="to_do_column_name" value="${v.to_do_column_name ?? DEFAULT_JIRA_COLUMN_MAPPINGS.toDo}">
      <div class="hint">Incoming webhook transitions to this status will queue work.</div>
    </div>
    <div class="field">
      <label for="in_progress_column_name">In Progress Column Name</label>
      <input type="text" id="in_progress_column_name" name="in_progress_column_name" value="${v.in_progress_column_name ?? DEFAULT_JIRA_COLUMN_MAPPINGS.inProgress}">
      <div class="hint">Used when HyperDispatch transitions a ticket after spawning an agent.</div>
    </div>
    <div class="field">
      <label for="in_review_column_name">In Review Column Name</label>
      <input type="text" id="in_review_column_name" name="in_review_column_name" value="${v.in_review_column_name ?? DEFAULT_JIRA_COLUMN_MAPPINGS.inReview}">
      <div class="hint">Used when HyperDispatch transitions a succeeded ticket.</div>
    </div>
    <div class="field">
      <label for="done_column_name">Done Column Name</label>
      <input type="text" id="done_column_name" name="done_column_name" value="${v.done_column_name ?? DEFAULT_JIRA_COLUMN_MAPPINGS.done}">
      <div class="hint">Incoming webhook transitions to this status trigger unblock checks.</div>
    </div>
    <div class="field">
      <label for="skills">Skills (comma-separated specs)</label>
      <input type="text" id="skills" name="skills" value="${skillsValue}">
      <div class="hint">e.g. owner/repo:skill-name, owner/repo:other-skill</div>
      <button type="button" id="discover-btn" class="btn btn-secondary" style="margin-top:6px" onclick="loadSkills()">Discover Skills</button>
      <div id="skills-picker"></div>
    </div>
    <div class="field">
      <label for="github_pat">GitHub PAT <span style="font-weight:400;color:#6b7280">(per-project override)</span></label>
      <input type="password" id="github_pat" name="github_pat" autocomplete="new-password" ${config?.github_pat ? 'placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"' : ""}>
      <div class="hint">Generate at github.com &rarr; Settings &rarr; Developer settings &rarr; Personal Access Tokens. Needs <code>repo</code> scope. Leave blank to use the global token.</div>
    </div>
    <div class="field">
      <label for="jira_api_token">Jira API Token <span style="font-weight:400;color:#6b7280">(per-project override)</span></label>
      <input type="password" id="jira_api_token" name="jira_api_token" autocomplete="new-password" ${config?.jira_api_token ? 'placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"' : ""}>
      <div class="hint">Generate at id.atlassian.com/manage-profile/security/api-tokens. Leave blank to use the global token.</div>
    </div>
    <div class="field">
      <label for="jira_email">Jira User Email <span style="font-weight:400;color:#6b7280">(per-project override)</span></label>
      <input type="text" id="jira_email" name="jira_email" value="${v.jira_email ?? ""}" autocomplete="off">
      <div class="hint">The Atlassian account email used for Jira API auth. Leave blank to use the global email.</div>
    </div>
    <div class="field">
      <label><input type="checkbox" name="active" value="true" ${v.active !== false ? "checked" : ""}> Active</label>
    </div>
    <div class="actions">
      <button type="submit" class="btn btn-primary">Save</button>
      <a href="/config" class="btn btn-secondary">Cancel</a>
    </div>
  </form>
</div>
${skillsPickerScript}`;
}

// ─── GET / — List all projects ─────────────────────────────────────────────────

configRouter.get("/", async (c) => {
  const configs = await listProjectConfigs();

  const rows = configs.map(
    (cfg) => `<tr>
    <td><a href="/config/${cfg.project_key}">${cfg.project_key}</a></td>
    <td>${cfg.github_repo}</td>
    <td><span class="badge ${cfg.active ? "badge-active" : "badge-inactive"}">${cfg.active ? "active" : "inactive"}</span></td>
    <td>${cfg.oz_env_id}</td>
    <td style="white-space:nowrap">
      <a href="/config/${cfg.project_key}" class="btn btn-secondary btn-small">Edit</a>
      <a href="/config/${cfg.project_key}/validate" target="_blank" class="btn btn-secondary btn-small">Validate</a>
    </td>
  </tr>`
  );

  const webhookInstructions = `
<div style="background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);padding:24px;margin-top:20px">
  <h2 style="margin:0 0 12px;font-size:1.1rem">Webhook Setup</h2>
  <p style="margin:0 0 12px;font-size:0.875rem;color:#374151">Create one Jira Automation rule to connect Jira to HyperDispatch:</p>
  <ol style="margin:0 0 16px;padding-left:20px;font-size:0.875rem;color:#374151;line-height:1.7">
    <li>In Jira, go to <strong>Project Settings &rarr; Automation</strong> (or use global automation to cover all projects)</li>
    <li>Create a new rule with trigger: <strong>Issue transitioned</strong></li>
    <li>Add action: <strong>Send web request</strong></li>
    <li>Set URL to: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px">https://&lt;your-hyperdispatch-host&gt;/webhook/jira</code></li>
    <li>Method: <strong>POST</strong>, Content type: <strong>application/json</strong></li>
    <li>Set the body to:</li>
  </ol>
  <pre style="background:#1e293b;color:#e2e8f0;padding:16px;border-radius:6px;font-size:0.8rem;overflow-x:auto;margin:0 0 12px">{
  &quot;issueKey&quot;: &quot;{{issue.key}}&quot;,
  &quot;projectKey&quot;: &quot;{{issue.fields.project.key}}&quot;,
  &quot;transitionTarget&quot;: &quot;{{transition.to_status.name}}&quot;
}</pre>
  <p style="margin:0;font-size:0.8rem;color:#6b7280">ℹ️ HyperDispatch silently ignores webhooks for projects that are not configured above.</p>
</div>`;

  const body = `
<h1>Projects</h1>
<table>
  <thead>
    <tr>
      <th>Project Key</th>
      <th>GitHub Repo</th>
      <th>Status</th>
      <th>Oz Env</th>
      <th>Actions</th>
    </tr>
  </thead>
  <tbody>
    ${configs.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:#6b7280">No projects configured yet. <a href="/config/new">Add one</a>.</td></tr>' : rows.join("\n")}
  </tbody>
</table>
<div class="actions">
  <a href="/config/new" class="btn btn-primary">+ New Project</a>
</div>
${webhookInstructions}`;

  return c.html(layout("Projects", body));
});

// ─── GET /new — New project form ───────────────────────────────────────────────

configRouter.get("/new", (c) => {
  const body = `<h1>New Project</h1>${projectForm("/config")}`;
  return c.html(layout("New Project", body));
});

// ─── POST / — Create project ───────────────────────────────────────────────────

configRouter.post("/", async (c) => {
  const form = await c.req.parseBody();

  const skillsRaw = String(form.skills ?? "");
  const skills = skillsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  await createProjectConfig({
    project_key: String(form.project_key),
    jira_cloud_id: String(form.jira_cloud_id),
    board_id: parseInt(String(form.board_id), 10),
    oz_env_id: String(form.oz_env_id),
    github_repo: String(form.github_repo),
    default_model: form.default_model ? String(form.default_model) : null,
    backlog_column_name: formColumnName(
      form as Record<string, unknown>,
      "backlog_column_name",
      DEFAULT_JIRA_COLUMN_MAPPINGS.backlog
    ),
    to_do_column_name: formColumnName(
      form as Record<string, unknown>,
      "to_do_column_name",
      DEFAULT_JIRA_COLUMN_MAPPINGS.toDo
    ),
    in_progress_column_name: formColumnName(
      form as Record<string, unknown>,
      "in_progress_column_name",
      DEFAULT_JIRA_COLUMN_MAPPINGS.inProgress
    ),
    in_review_column_name: formColumnName(
      form as Record<string, unknown>,
      "in_review_column_name",
      DEFAULT_JIRA_COLUMN_MAPPINGS.inReview
    ),
    done_column_name: formColumnName(
      form as Record<string, unknown>,
      "done_column_name",
      DEFAULT_JIRA_COLUMN_MAPPINGS.done
    ),
    model_field_id: form.model_field_id ? String(form.model_field_id) : null,
    skills,
    github_pat: form.github_pat ? String(form.github_pat) : null,
    jira_api_token: form.jira_api_token ? String(form.jira_api_token) : null,
    jira_email: form.jira_email ? String(form.jira_email) : null,
    active: form.active === "true",
  });

  return c.redirect("/config");
});

// ─── GET /:projectKey — Edit form ──────────────────────────────────────────────

configRouter.get("/:projectKey", async (c) => {
  const { projectKey } = c.req.param();
  const config = await getProjectConfig(projectKey);
  if (!config) {
    return c.html(layout("Not Found", `<p>Project <strong>${projectKey}</strong> not found. <a href="/config">Back</a></p>`), 404);
  }

  const body = `
<h1>Edit: ${config.project_key}</h1>
${projectForm(`/config/${config.project_key}`, config, config.project_key)}
<div style="margin-top:16px">
  <form method="POST" action="/config/${config.project_key}/delete" onsubmit="return confirm('Deactivate this project?')">
    <button type="submit" class="btn btn-danger">Deactivate</button>
  </form>
</div>`;

  return c.html(layout(`Edit ${projectKey}`, body));
});

// ─── POST /:projectKey — Update project ────────────────────────────────────────

configRouter.post("/:projectKey", async (c) => {
  const { projectKey } = c.req.param();
  const form = await c.req.parseBody();

  const skillsRaw = String(form.skills ?? "");
  const skills = skillsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Only update tokens if a new value was submitted — empty field means "keep existing"
  const tokenUpdates: { github_pat?: string | null; jira_api_token?: string | null; jira_email?: string | null } = {};
  if (form.github_pat) tokenUpdates.github_pat = String(form.github_pat);
  if (form.jira_api_token) tokenUpdates.jira_api_token = String(form.jira_api_token);
  if (form.jira_email) tokenUpdates.jira_email = String(form.jira_email);

  await updateProjectConfig(projectKey, {
    jira_cloud_id: String(form.jira_cloud_id),
    board_id: parseInt(String(form.board_id), 10),
    oz_env_id: String(form.oz_env_id),
    github_repo: String(form.github_repo),
    default_model: form.default_model ? String(form.default_model) : null,
    model_field_id: form.model_field_id ? String(form.model_field_id) : null,
    backlog_column_name: formColumnName(
      form as Record<string, unknown>,
      "backlog_column_name",
      DEFAULT_JIRA_COLUMN_MAPPINGS.backlog
    ),
    to_do_column_name: formColumnName(
      form as Record<string, unknown>,
      "to_do_column_name",
      DEFAULT_JIRA_COLUMN_MAPPINGS.toDo
    ),
    in_progress_column_name: formColumnName(
      form as Record<string, unknown>,
      "in_progress_column_name",
      DEFAULT_JIRA_COLUMN_MAPPINGS.inProgress
    ),
    in_review_column_name: formColumnName(
      form as Record<string, unknown>,
      "in_review_column_name",
      DEFAULT_JIRA_COLUMN_MAPPINGS.inReview
    ),
    done_column_name: formColumnName(
      form as Record<string, unknown>,
      "done_column_name",
      DEFAULT_JIRA_COLUMN_MAPPINGS.done
    ),
    skills,
    ...tokenUpdates,
    active: form.active === "true",
  });

  return c.redirect(`/config/${projectKey}`);
});

// ─── POST /:projectKey/delete — Deactivate project ────────────────────────────

configRouter.post("/:projectKey/delete", async (c) => {
  const { projectKey } = c.req.param();
  await deactivateProjectConfig(projectKey);
  return c.redirect("/config");
});

// ─── GET /:projectKey/skills — Discover skills from GitHub repo ────────────────
configRouter.post("/skills", async (c) => {
  let payload:
    | { repo?: unknown; projectKey?: unknown; githubPat?: unknown }
    | undefined;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  const repoParam = typeof payload?.repo === "string" ? payload.repo : "";
  const projectKey =
    typeof payload?.projectKey === "string" ? payload.projectKey : "";
  const githubPat =
    typeof payload?.githubPat === "string" ? payload.githubPat : "";

  if (!repoParam) {
    return c.json({ error: "Missing repo value (format: owner/repo)" }, 400);
  }

  const parts = repoParam.split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return c.json({ error: "Invalid repo format. Use owner/repo" }, 400);
  }

  const [owner, repo] = parts;

  try {
    const existingConfig =
      projectKey.trim().length > 0
        ? await getProjectConfig(projectKey.trim())
        : null;
    const tokenForDiscovery =
      githubPat.trim().length > 0
        ? githubPat.trim()
        : existingConfig?.github_pat ?? undefined;
    const skills = await discoverSkills(owner!, repo!, "main", tokenForDiscovery);
    return c.json(skills);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

configRouter.get("/:projectKey/skills", async (c) => {
  const repoParam = c.req.query("repo");
  if (!repoParam) {
    return c.json({ error: "Missing repo query param (format: owner/repo)" }, 400);
  }

  const parts = repoParam.split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return c.json({ error: "Invalid repo format. Use owner/repo" }, 400);
  }

  const [owner, repo] = parts;

  try {
    const { projectKey } = c.req.param();
    const config = await getProjectConfig(projectKey);
    const skills = await discoverSkills(
      owner!,
      repo!,
      "main",
      config?.github_pat ?? undefined
    );
    return c.json(skills);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ─── GET /:projectKey/validate — Validate Jira project ────────────────────────

configRouter.get("/:projectKey/validate", async (c) => {
  const { projectKey } = c.req.param();
  const config = await getProjectConfig(projectKey);
  if (!config) {
    return c.json({ error: `Project ${projectKey} not found` }, 404);
  }

  const result = await validateJiraProject(
    config.board_id,
    config.model_field_id,
    {
      backlog: config.backlog_column_name,
      toDo: config.to_do_column_name,
      inProgress: config.in_progress_column_name,
      inReview: config.in_review_column_name,
      done: config.done_column_name,
    },
    config.jira_email && config.jira_api_token
      ? { email: config.jira_email, apiToken: config.jira_api_token }
      : undefined
  );

  // Return HTML if accept header prefers it, otherwise JSON
  const accept = c.req.header("accept") ?? "";
  if (accept.includes("text/html")) {
    const checksHtml = result.checks
      .map(
        (ch) => `<tr>
        <td>${ch.name}</td>
        <td><span class="badge ${ch.passed ? "badge-active" : "badge-danger"}" style="${ch.passed ? "background:#22c55e;color:#fff" : "background:#ef4444;color:#fff"}">${ch.passed ? "PASS" : "FAIL"}</span></td>
        <td>${ch.message}</td>
      </tr>`
      )
      .join("\n");

    const body = `
<h1>Validate: ${projectKey}</h1>
<p><strong>Overall: </strong><span class="badge" style="${result.valid ? "background:#22c55e;color:#fff" : "background:#ef4444;color:#fff"}">${result.valid ? "VALID" : "INVALID"}</span></p>
<table>
  <thead>
    <tr><th>Check</th><th>Result</th><th>Message</th></tr>
  </thead>
  <tbody>
    ${checksHtml}
  </tbody>
</table>
<a href="/config/${projectKey}">← Back to project</a>`;

    return c.html(layout(`Validate ${projectKey}`, body));
  }

  return c.json(result);
});
