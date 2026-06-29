import { describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

type PGliteLike = {
  query: (query: string, params?: unknown[]) => Promise<{ rows?: unknown[] } | unknown[]>;
  exec?: (query: string) => Promise<unknown>;
  close?: () => Promise<void>;
};

type SqlTag = {
  <T = unknown[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  unsafe: (query: string) => Promise<unknown[]>;
  begin: <T>(callback: (tx: SqlTag) => Promise<T>) => Promise<T>;
};

async function queryRows<T = Record<string, unknown>>(
  db: PGliteLike,
  query: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await db.query(query, params);
  if (Array.isArray(result)) return result as T[];
  return (result.rows ?? []) as T[];
}

async function runUnsafeStatements(db: PGliteLike, query: string): Promise<unknown[]> {
  if (typeof db.exec === "function") {
    await db.exec(query);
    return [];
  }
  const statements = query
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.query(statement);
  }
  return [];
}

function createPgliteSqlTag(db: PGliteLike): SqlTag {
  const runQuery = async <T = unknown[]>(
    strings: TemplateStringsArray,
    values: unknown[]
  ): Promise<T> => {
    let text = strings[0] ?? "";
    const params: unknown[] = [];
    for (let i = 0; i < values.length; i++) {
      params.push(values[i]);
      text += `$${params.length}`;
      text += strings[i + 1] ?? "";
    }
    const result = await db.query(text, params);
    if (Array.isArray(result)) return result as T;
    return (result.rows ?? []) as T;
  };

  const makeTag = (): SqlTag =>
    Object.assign(
      (<T = unknown[]>(strings: TemplateStringsArray, ...values: unknown[]) =>
        runQuery<T>(strings, values)) as SqlTag,
      {
        unsafe: (query: string) => runUnsafeStatements(db, query),
        begin: async <T>(callback: (tx: SqlTag) => Promise<T>): Promise<T> => {
          await db.query("BEGIN");
          const tx = makeTag();
          try {
            const result = await callback(tx);
            await db.query("COMMIT");
            return result;
          } catch (error) {
            await db.query("ROLLBACK");
            throw error;
          }
        },
      }
    );

  return makeTag();
}

async function seedLegacySchema(db: PGliteLike): Promise<void> {
  await runUnsafeStatements(
    db,
    `
      CREATE TABLE project_configs (
        project_key TEXT PRIMARY KEY,
        jira_cloud_id TEXT NOT NULL,
        board_id INTEGER NOT NULL,
        oz_env_id TEXT NOT NULL,
        github_repo TEXT NOT NULL,
        default_model TEXT,
        model_field_id TEXT,
        skills TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE dispatch_runs (
        ticket_key TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        summary TEXT,
        status TEXT NOT NULL,
        blocked_by TEXT[],
        priority INTEGER DEFAULT 0,
        ticket_status_name TEXT,
        ticket_status_category TEXT,
        run_id TEXT,
        model TEXT,
        spawned_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        pr_url TEXT,
        pr_has_conflicts BOOLEAN,
        pr_display_state TEXT,
        pr_review_running BOOLEAN,
        pr_revision_running BOOLEAN,
        session_link TEXT,
        error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `
  );

  await queryRows(
    db,
    `
      INSERT INTO project_configs (
        project_key,
        jira_cloud_id,
        board_id,
        oz_env_id,
        github_repo,
        skills,
        active
      ) VALUES ($1, $2, $3, $4, $5, ARRAY[]::TEXT[], true)
    `,
    ["HYDI", "cloud-id", 1, "env-1", "hyperbolic-co/hyper-dispatch"]
  );
}

async function tableExists(db: PGliteLike, tableName: string): Promise<boolean> {
  const rows = await queryRows<{ exists: boolean }>(
    db,
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = $1
      ) AS exists
    `,
    [tableName]
  );
  return rows[0]?.exists ?? false;
}

async function loadMigratorWithDb(db: PGliteLike) {
  vi.doMock("./connection.js", () => ({
    sql: createPgliteSqlTag(db),
  }));
  return import("./migrate.js");
}

describe("runMigrations integration", () => {
  it("backfills legacy dispatch_runs into dispatch_entries + dispatch_runs and drops the legacy table", async () => {
    const db = new PGlite();
    try {
      await seedLegacySchema(db);
      await queryRows(
        db,
        `
          INSERT INTO dispatch_runs (
            ticket_key,
            project_key,
            summary,
            status,
            run_id,
            model,
            spawned_at,
            completed_at,
            pr_url,
            pr_display_state,
            session_link,
            error,
            created_at,
            updated_at
          ) VALUES
            ('HYDI-100', 'HYDI', 'First legacy row', 'succeeded', 'run-100', 'auto', NOW() - INTERVAL '1 hour', NOW(), 'https://github.com/org/repo/pull/100', 'merged', 'https://warp.dev/runs/100', NULL, NOW() - INTERVAL '2 hours', NOW()),
            ('HYDI-101', 'HYDI', 'Second legacy row', 'failed', NULL, 'auto', NULL, NOW(), NULL, NULL, NULL, 'legacy failure', NOW() - INTERVAL '3 hours', NOW())
        `
      );

      const { runMigrations } = await loadMigratorWithDb(db);
      await runMigrations();

      expect(await tableExists(db, "dispatch_runs_legacy")).toBe(false);
      expect(await tableExists(db, "dispatch_entries")).toBe(true);

      const entries = await queryRows<{
        ticket_key: string;
        project_key: string;
        status: string;
      }>(
        db,
        `
          SELECT ticket_key, project_key, status
          FROM dispatch_entries
          ORDER BY ticket_key ASC
        `
      );
      expect(entries).toEqual([
        { ticket_key: "HYDI-100", project_key: "HYDI", status: "succeeded" },
        { ticket_key: "HYDI-101", project_key: "HYDI", status: "failed" },
      ]);

      const runs = await queryRows<{
        ticket_key: string;
        run_id: string | null;
        status: string;
        error: string | null;
      }>(
        db,
        `
          SELECT ticket_key, run_id, status, error
          FROM dispatch_runs
          ORDER BY ticket_key ASC
        `
      );
      expect(runs).toEqual([
        { ticket_key: "HYDI-100", run_id: "run-100", status: "succeeded", error: null },
        {
          ticket_key: "HYDI-101",
          run_id: null,
          status: "failed",
          error: "legacy failure",
        },
      ]);
    } finally {
      await db.close?.();
    }
  });

  it("rolls back the full legacy migration on backfill failure so restart can re-run safely", async () => {
    const db = new PGlite();
    try {
      await seedLegacySchema(db);
      await queryRows(
        db,
        `
          INSERT INTO dispatch_runs (
            ticket_key,
            project_key,
            summary,
            status,
            pr_display_state,
            created_at,
            updated_at
          ) VALUES (
            'HYDI-200',
            'HYDI',
            'Bad legacy row',
            'succeeded',
            'not-a-valid-pr-state',
            NOW(),
            NOW()
          )
        `
      );

      const { runMigrations } = await loadMigratorWithDb(db);
      await expect(runMigrations()).rejects.toThrow();

      // Transaction rollback keeps the pre-migration shape fully intact.
      expect(await tableExists(db, "dispatch_entries")).toBe(false);
      expect(await tableExists(db, "dispatch_runs_legacy")).toBe(false);
      expect(await tableExists(db, "dispatch_runs")).toBe(true);

      const legacyRows = await queryRows<{ ticket_key: string }>(
        db,
        `SELECT ticket_key FROM dispatch_runs`
      );
      expect(legacyRows.map((row) => row.ticket_key)).toEqual(["HYDI-200"]);

      await queryRows(
        db,
        `
          UPDATE dispatch_runs
          SET pr_display_state = 'open'
          WHERE ticket_key = 'HYDI-200'
        `
      );

      await runMigrations();
      expect(await tableExists(db, "dispatch_entries")).toBe(true);
      expect(await tableExists(db, "dispatch_runs_legacy")).toBe(false);
    } finally {
      await db.close?.();
    }
  });
});
