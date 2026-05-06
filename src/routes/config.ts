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

export const configRouter = new Hono();

// ─── Shared CSS ────────────────────────────────────────────────────────────────

const CSS = `
  body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #f9fafb; color: #111; }
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
  input[type=text], input[type=number], textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem; font-family: inherit; }
  textarea { min-height: 80px; resize: vertical; }
  input[type=checkbox] { width: auto; }
  .hint { font-size: 0.75rem; color: #6b7280; margin-top: 3px; }
  .btn { display: inline-block; padding: 8px 18px; border-radius: 6px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; }
  .btn-primary { background: #3b82f6; color: #fff; }
  .btn-primary:hover { background: #2563eb; }
  .btn-danger { background: #ef4444; color: #fff; }
  .btn-danger:hover { background: #dc2626; }
  .btn-secondary { background: #e5e7eb; color: #111; }
  .btn-secondary:hover { background: #d1d5db; }
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
  <style>${CSS}</style>
</head>
<body>
  <nav>
    <a href="/dashboard">Dashboard</a>
    <a href="/config">Projects</a>
    <a href="/config/new">+ New Project</a>
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
  if (!repo || !repo.includes('/')) {
    alert('Enter a valid owner/repo first (e.g. myorg/myrepo)');
    return;
  }
  const btn = document.getElementById('discover-btn');
  btn.textContent = 'Loading...';
  btn.disabled = true;
  try {
    const key = document.getElementById('project_key_field')?.value || '';
    const res = await fetch('/config/' + encodeURIComponent(key) + '/skills?repo=' + encodeURIComponent(repo));
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
    </div>
    <div class="field">
      <label for="board_id">Board ID</label>
      <input type="number" id="board_id" name="board_id" value="${v.board_id ?? ""}" required>
    </div>
    <div class="field">
      <label for="oz_env_id">Oz Environment ID</label>
      <input type="text" id="oz_env_id" name="oz_env_id" value="${v.oz_env_id ?? ""}" required>
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
      <div class="hint">Jira custom field ID for per-ticket model override</div>
    </div>
    <div class="field">
      <label for="skills">Skills (comma-separated specs)</label>
      <input type="text" id="skills" name="skills" value="${skillsValue}">
      <div class="hint">e.g. owner/repo:skill-name, owner/repo:other-skill</div>
      <button type="button" id="discover-btn" class="btn btn-secondary" style="margin-top:6px" onclick="loadSkills()">Discover Skills</button>
      <div id="skills-picker"></div>
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
      <a href="/config/${cfg.project_key}">Edit</a> ·
      <a href="/config/${cfg.project_key}/validate" target="_blank">Validate</a>
    </td>
  </tr>`
  );

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
</table>`;

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
    model_field_id: form.model_field_id ? String(form.model_field_id) : null,
    skills,
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

  await updateProjectConfig(projectKey, {
    jira_cloud_id: String(form.jira_cloud_id),
    board_id: parseInt(String(form.board_id), 10),
    oz_env_id: String(form.oz_env_id),
    github_repo: String(form.github_repo),
    default_model: form.default_model ? String(form.default_model) : null,
    model_field_id: form.model_field_id ? String(form.model_field_id) : null,
    skills,
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
    const skills = await discoverSkills(owner!, repo!);
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

  const result = await validateJiraProject(config.board_id, config.model_field_id);

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
