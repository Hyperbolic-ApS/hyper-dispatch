import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sql } from "./connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  const schemaPath = join(__dirname, "schema.sql");
  const schema = await readFile(schemaPath, "utf-8");
  await sql.unsafe(schema);

  // Additive column migrations — safe to run repeatedly
  await sql.unsafe(`
    ALTER TABLE project_configs
      ADD COLUMN IF NOT EXISTS github_pat TEXT,
      ADD COLUMN IF NOT EXISTS jira_api_token TEXT,
      ADD COLUMN IF NOT EXISTS deployment_url TEXT,
      ADD COLUMN IF NOT EXISTS mcp_servers JSONB,
      ADD COLUMN IF NOT EXISTS backlog_column_name TEXT NOT NULL DEFAULT 'Backlog',
      ADD COLUMN IF NOT EXISTS to_do_column_name TEXT NOT NULL DEFAULT 'To Do',
      ADD COLUMN IF NOT EXISTS in_progress_column_name TEXT NOT NULL DEFAULT 'In Progress',
      ADD COLUMN IF NOT EXISTS in_review_column_name TEXT NOT NULL DEFAULT 'In Review',
      ADD COLUMN IF NOT EXISTS done_column_name TEXT NOT NULL DEFAULT 'Done';
  `);
  await sql.unsafe(`
    ALTER TABLE dispatch_runs
      ADD COLUMN IF NOT EXISTS pr_has_conflicts BOOLEAN;
  `);

  console.log("Database migrations applied successfully");
}
