import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "./connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  const schemaPath = join(__dirname, "schema.sql");
  const schema = await readFile(schemaPath, "utf-8");
  const additiveColumnMigrationSql = `
    ALTER TABLE project_configs
      ADD COLUMN IF NOT EXISTS oz_agent_identity_uid TEXT,
      ADD COLUMN IF NOT EXISTS oz_api_key TEXT,
      ADD COLUMN IF NOT EXISTS github_pat TEXT,
      ADD COLUMN IF NOT EXISTS jira_api_token TEXT,
      ADD COLUMN IF NOT EXISTS mcp_servers JSONB,
      ADD COLUMN IF NOT EXISTS backlog_column_name TEXT NOT NULL DEFAULT 'Backlog',
      ADD COLUMN IF NOT EXISTS to_do_column_name TEXT NOT NULL DEFAULT 'To Do',
      ADD COLUMN IF NOT EXISTS in_progress_column_name TEXT NOT NULL DEFAULT 'In Progress',
      ADD COLUMN IF NOT EXISTS in_review_column_name TEXT NOT NULL DEFAULT 'In Review',
      ADD COLUMN IF NOT EXISTS done_column_name TEXT NOT NULL DEFAULT 'Done';
  `;
  const dispatchEntriesExists = await sql<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'dispatch_entries'
    ) AS exists
  `;
  const legacyDispatchRunsExists = await sql<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'dispatch_runs'
    ) AS exists
  `;
  const legacyDispatchRunsHasProjectKey = await sql<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'dispatch_runs'
        AND column_name = 'project_key'
    ) AS exists
  `;
  const shouldMigrateLegacyRuns =
    !dispatchEntriesExists[0]?.exists &&
    legacyDispatchRunsExists[0]?.exists &&
    legacyDispatchRunsHasProjectKey[0]?.exists;

  if (shouldMigrateLegacyRuns) {
    await sql.begin(async (tx) => {
      await tx.unsafe(`
        ALTER TABLE dispatch_runs RENAME TO dispatch_runs_legacy;
      `);
      await tx.unsafe(schema);
      // Additive column migrations — safe to run repeatedly.
      await tx.unsafe(additiveColumnMigrationSql);

      await tx.unsafe(`
        INSERT INTO dispatch_entries (
          ticket_key,
          project_key,
          summary,
          status,
          blocked_by,
          priority,
          ticket_status_name,
          ticket_status_category,
          created_at,
          updated_at
        )
        SELECT
          ticket_key,
          project_key,
          summary,
          status,
          blocked_by,
          priority,
          ticket_status_name,
          ticket_status_category,
          created_at,
          updated_at
        FROM dispatch_runs_legacy
        ON CONFLICT (ticket_key) DO NOTHING;
      `);

      const legacyRuns = await tx<Array<{
        ticket_key: string;
        run_id: string | null;
        status: string;
        model: string | null;
        spawned_at: Date | null;
        completed_at: Date | null;
        pr_url: string | null;
        pr_has_conflicts: boolean | null;
        pr_display_state: "open" | "draft" | "merged" | "closed" | null;
        pr_review_running: boolean | null;
        pr_revision_running: boolean | null;
        session_link: string | null;
        error: string | null;
        created_at: Date;
        updated_at: Date;
      }>>`
        SELECT
          ticket_key,
          run_id,
          status,
          model,
          spawned_at,
          completed_at,
          pr_url,
          pr_has_conflicts,
          pr_display_state,
          pr_review_running,
          pr_revision_running,
          session_link,
          error,
          created_at,
          updated_at
        FROM dispatch_runs_legacy
      `;

      for (const legacyRun of legacyRuns) {
        await tx`
          INSERT INTO dispatch_runs (
            id,
            ticket_key,
            run_type,
            run_id,
            status,
            model,
            spawned_at,
            completed_at,
            pr_url,
            pr_has_conflicts,
            pr_display_state,
            pr_review_running,
            pr_revision_running,
            session_link,
            error,
            created_at,
            updated_at
          ) VALUES (
            ${randomUUID()},
            ${legacyRun.ticket_key},
            'implementation',
            ${legacyRun.run_id},
            ${legacyRun.status},
            ${legacyRun.model},
            ${legacyRun.spawned_at},
            ${legacyRun.completed_at},
            ${legacyRun.pr_url},
            ${legacyRun.pr_has_conflicts},
            ${legacyRun.pr_display_state},
            ${legacyRun.pr_review_running},
            ${legacyRun.pr_revision_running},
            ${legacyRun.session_link},
            ${legacyRun.error},
            ${legacyRun.spawned_at ?? legacyRun.created_at},
            ${legacyRun.updated_at}
          )
        `;
      }

      await tx.unsafe(`DROP TABLE dispatch_runs_legacy;`);
    });
  } else {
    await sql.unsafe(schema);
    // Additive column migrations — safe to run repeatedly.
    await sql.unsafe(additiveColumnMigrationSql);
  }

  // Revision state + findings ledger — additive, idempotent, runs on every startup.
  await sql.unsafe(`
    ALTER TABLE dispatch_entries
      ADD COLUMN IF NOT EXISTS revision_budget INTEGER NOT NULL DEFAULT 2,
      ADD COLUMN IF NOT EXISTS needs_human BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS review_tier TEXT;
  `);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS review_findings (
      finding_key      TEXT NOT NULL,
      ticket_key       TEXT NOT NULL REFERENCES dispatch_entries(ticket_key),
      pr_url           TEXT NOT NULL,
      severity         TEXT,
      title            TEXT,
      status           TEXT NOT NULL DEFAULT 'open',
      disposition      TEXT,
      first_seen_round INTEGER NOT NULL,
      last_seen_round  INTEGER NOT NULL,
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (pr_url, finding_key)
    );
  `);
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_review_findings_ticket ON review_findings(ticket_key);
    CREATE INDEX IF NOT EXISTS idx_review_findings_pr_url ON review_findings(pr_url);
  `);

  console.log("Database migrations applied successfully");
}
