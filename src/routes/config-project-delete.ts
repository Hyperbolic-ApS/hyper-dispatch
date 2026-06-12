import type { Context } from "hono";
import { deleteProjectConfig } from "../db/config-queries.js";

export function projectDeleteSection(projectKey: string): string {
  return `<div style="margin-top:16px">
  <form method="POST" action="/config/${projectKey}/delete" onsubmit="return confirm('Delete this project and its dispatch history?')">
    <button type="submit" class="btn btn-danger">Delete project</button>
  </form>
</div>`;
}

export async function handleProjectDeletePost(c: Context): Promise<Response> {
  const { projectKey } = c.req.param();
  await deleteProjectConfig(projectKey);
  return c.redirect("/config");
}
