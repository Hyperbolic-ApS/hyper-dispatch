import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

type QueriesModule = typeof import("./queries.js");
type ConnectionModule = {
  sql: {
    unsafe: (query: string) => Promise<unknown[]>;
    end: (opts?: { timeout?: number }) => Promise<void>;
  };
};
type PGliteLike = {
  query: (query: string, params?: unknown[]) => Promise<{ rows?: unknown[] } | unknown[]>;
  exec?: (query: string) => Promise<unknown>;
  close?: () => Promise<void>;
};

const DB_URL = "postgres://postgres:test@localhost:5433/postgres";

function setRequiredEnvForDbTests() {
  process.env.DATABASE_URL ??= DB_URL;
  process.env.JIRA_SITE_URL ??= "https://example.atlassian.net";
  process.env.JIRA_CLOUD_ID ??= "test-cloud-id";
  process.env.JIRA_API_TOKEN ??= "test-token";
  process.env.WARP_API_KEY ??= "test-key";
  process.env.GITHUB_TOKEN ??= "test-token";
}
function isIdentifierFragment(input: string): boolean {
  return /^[a-z_][a-z0-9_]*$/i.test(input);
}
function createPgliteSqlTag(db: PGliteLike) {
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const builtText = strings.join("").trim();
    if (values.length === 0 && isIdentifierFragment(builtText)) {
      return { __raw: builtText };
    }
    return (async () => {
    let text = strings[0] ?? "";
    const params: unknown[] = [];
    for (let i = 0; i < values.length; i++) {
      const value = values[i] as { __raw?: string } | null | undefined;
      if (value && typeof value === "object" && typeof value.__raw === "string") {
        text += value.__raw;
      } else if (value === null) {
        text += "NULL";
      } else {
        params.push(values[i]);
        text += `$${params.length}`;
      }
      text += strings[i + 1] ?? "";
    }
    const result = await db.query(text, params);
    if (Array.isArray(result)) {
      return result;
    }
    return result.rows ?? [];
    })();
  }) as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> | { __raw: string };
    unsafe: (query: string) => Promise<unknown[]>;
    end: (opts?: { timeout?: number }) => Promise<void>;
  };
  sql.unsafe = async (query: string) => {
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
  };
  sql.end = async () => {
    if (typeof db.close === "function") {
      await db.close();
    }
  };
  return sql;
}

describe.skipIf(!process.env.RUN_DB_TESTS)("queries integration", () => {
  let queries: QueriesModule;
  let connection: ConnectionModule;

  async function resetTables() {
    await connection.sql.unsafe(`
      TRUNCATE TABLE dispatch_runs, project_configs RESTART IDENTITY CASCADE;
    `);

    await connection.sql.unsafe(`
      INSERT INTO project_configs (
        project_key,
        jira_cloud_id,
        board_id,
        oz_env_id,
        github_repo,
        backlog_column_name,
        to_do_column_name,
        in_progress_column_name,
        in_review_column_name,
        done_column_name,
        skills
      ) VALUES (
        'HYDI',
        'jira-cloud-id',
        1,
        'env-1',
        'hyperbolic-co/hyper-dispatch',
        'Backlog',
        'To Do',
        'In Progress',
        'In Review',
        'Done',
        ARRAY[]::TEXT[]
      );
    `);
  }

  beforeAll(async () => {
    setRequiredEnvForDbTests();
    if (process.env.TEST_DB_MODE === "pglite") {
      const db = new PGlite();
      vi.doMock("./connection.js", () => ({
        sql: createPgliteSqlTag(db),
      }));
    }

    connection = await import("./connection.js");
    queries = await import("./queries.js");

    const schemaSql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
    await connection.sql.unsafe(schemaSql);
  });

  it("integration: getRunsByPrUrl returns runs matching the PR URL", async () => {
    const prUrl = "https://github.com/hyperbolic-co/hyper-dispatch/pull/201";

    await queries.upsertDispatchRun({
      ticketKey: "HYDI-201",
      projectKey: "HYDI",
      status: "queued",
    });
    await queries.updateRunStatus("HYDI-201", {
      pr_url: prUrl,
      pr_display_state: "draft",
    });

    await queries.upsertDispatchRun({
      ticketKey: "HYDI-202",
      projectKey: "HYDI",
      status: "queued",
    });
    await queries.updateRunStatus("HYDI-202", {
      pr_url: "https://github.com/hyperbolic-co/hyper-dispatch/pull/202",
      pr_display_state: "open",
    });

    const matched = await queries.getRunsByPrUrl(prUrl);
    expect(matched.map((run) => run.ticket_key)).toEqual(["HYDI-201"]);
    expect(matched[0]?.pr_display_state).toBe("draft");
  });

  beforeEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await connection.sql.end({ timeout: 1 });
  });

  it("integration: upsertDispatchRun inserts a new row", async () => {
    const run = await queries.upsertDispatchRun({
      ticketKey: "HYDI-36",
      projectKey: "HYDI",
      summary: "Add DB integration tests",
      status: "queued",
      blockedBy: ["HYDI-31"],
      priority: 10,
    });

    expect(run.ticket_key).toBe("HYDI-36");
    expect(run.project_key).toBe("HYDI");
    expect(run.summary).toBe("Add DB integration tests");
    expect(run.status).toBe("queued");
    expect(run.blocked_by).toEqual(["HYDI-31"]);
    expect(run.priority).toBe(10);
  });

  it("integration: upsertDispatchRun preserves summary on conflict when incoming summary is undefined", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-40",
      projectKey: "HYDI",
      summary: "Original summary",
      status: "blocked",
      blockedBy: ["HYDI-31"],
      priority: 1,
    });

    const updated = await queries.upsertDispatchRun({
      ticketKey: "HYDI-40",
      projectKey: "HYDI",
      status: "queued",
      blockedBy: [],
      priority: 2,
    });

    expect(updated.summary).toBe("Original summary");
    expect(updated.status).toBe("queued");
    expect(updated.priority).toBe(2);
  });

  it("integration: upsertDispatchRun does not downgrade running or succeeded rows back to queued", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-41",
      projectKey: "HYDI",
      summary: "Already running",
      status: "running",
      blockedBy: [],
    });
    const running = await queries.upsertDispatchRun({
      ticketKey: "HYDI-41",
      projectKey: "HYDI",
      summary: "Webhook replay",
      status: "queued",
      blockedBy: [],
    });
    expect(running.status).toBe("running");

    await queries.upsertDispatchRun({
      ticketKey: "HYDI-42",
      projectKey: "HYDI",
      summary: "Already done",
      status: "succeeded",
      blockedBy: [],
    });
    const succeeded = await queries.upsertDispatchRun({
      ticketKey: "HYDI-42",
      projectKey: "HYDI",
      summary: "Webhook replay",
      status: "queued",
      blockedBy: [],
    });
    expect(succeeded.status).toBe("succeeded");
  });

  it("integration: claimRunForSpawn is atomic and releaseSpawnClaim only releases unbound claims", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-43",
      projectKey: "HYDI",
      status: "queued",
    });

    const firstClaim = await queries.claimRunForSpawn("HYDI-43");
    const secondClaim = await queries.claimRunForSpawn("HYDI-43");
    expect(firstClaim).toBe(true);
    expect(secondClaim).toBe(false);

    await queries.releaseSpawnClaim("HYDI-43");
    const reclaimed = await queries.claimRunForSpawn("HYDI-43");
    expect(reclaimed).toBe(true);

    await queries.updateRunStatus("HYDI-43", { run_id: "run-43" });
    await queries.releaseSpawnClaim("HYDI-43");
    const stillRunning = await queries.getRunsByStatus("running");
    expect(stillRunning.map((run) => run.ticket_key)).toContain("HYDI-43");
  });

  it("integration: removeBlocker removes one blocker while preserving status when blockers remain", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-50",
      projectKey: "HYDI",
      summary: "Blocked by multiple tickets",
      status: "blocked",
      blockedBy: ["HYDI-51", "HYDI-52"],
    });

    const updated = await queries.removeBlocker("HYDI-50", "HYDI-51");

    expect(updated?.blocked_by).toEqual(["HYDI-52"]);
    expect(updated?.status).toBe("blocked");
  });

  it("integration: removeBlocker transitions to queued when the last blocker is removed from blocked_cycle", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-60",
      projectKey: "HYDI",
      summary: "Cycle blocked run",
      status: "blocked_cycle",
      blockedBy: ["HYDI-61"],
    });

    const updated = await queries.removeBlocker("HYDI-60", "HYDI-61");

    expect(updated?.blocked_by).toEqual([]);
    expect(updated?.status).toBe("queued");
  });

  it("integration: updateRunStatus partial updates preserve unspecified fields and enforce null/undefined behavior", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-70",
      projectKey: "HYDI",
      summary: "Update status behavior",
      status: "blocked",
      blockedBy: ["HYDI-71"],
    });

    await connection.sql.unsafe(`
      UPDATE dispatch_runs
      SET
        run_id = 'run-70',
        model = 'sonnet',
        pr_url = 'https://github.com/hyperbolic-co/hyper-dispatch/pull/70',
        pr_display_state = 'open'
      WHERE ticket_key = 'HYDI-70';
    `);

    const partiallyUpdated = await queries.updateRunStatus("HYDI-70", {
      status: "running",
    });
    expect(partiallyUpdated?.status).toBe("running");
    expect(partiallyUpdated?.run_id).toBe("run-70");
    expect(partiallyUpdated?.model).toBe("sonnet");
    expect(partiallyUpdated?.pr_url).toBe("https://github.com/hyperbolic-co/hyper-dispatch/pull/70");
    expect(partiallyUpdated?.pr_display_state).toBe("open");
    expect(partiallyUpdated?.blocked_by).toEqual(["HYDI-71"]);

    const clearedBlockedBy = await queries.updateRunStatus("HYDI-70", {
      blocked_by: null,
    });
    expect(clearedBlockedBy?.blocked_by).toBeNull();

    const nullPrUrlAttempt = await queries.updateRunStatus("HYDI-70", {
      pr_url: null,
    });
    expect(nullPrUrlAttempt?.pr_url).toBe("https://github.com/hyperbolic-co/hyper-dispatch/pull/70");

    const updatedPrDisplayState = await queries.updateRunStatus("HYDI-70", {
      pr_display_state: "merged",
    });
    expect(updatedPrDisplayState?.pr_display_state).toBe("merged");
  });

  it("integration: getRunsBlockedBy returns only runs containing the blocker key", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-80",
      projectKey: "HYDI",
      status: "blocked",
      blockedBy: ["HYDI-81", "HYDI-82"],
    });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-81",
      projectKey: "HYDI",
      status: "blocked",
      blockedBy: ["HYDI-83"],
    });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-82",
      projectKey: "HYDI",
      status: "queued",
    });

    const blocked = await queries.getRunsBlockedBy("HYDI-82");
    expect(blocked.map((run) => run.ticket_key)).toEqual(["HYDI-80"]);
  });

  it("integration: getActiveRunCount counts only running runs", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-90",
      projectKey: "HYDI",
      status: "running",
    });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-91",
      projectKey: "HYDI",
      status: "queued",
    });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-92",
      projectKey: "HYDI",
      status: "running",
    });

    const activeCount = await queries.getActiveRunCount();
    expect(activeCount).toBe(2);
  });

  it("integration: getProjectConfig and listActiveProjectConfigs return only active configs", async () => {
    await connection.sql.unsafe(`
      INSERT INTO project_configs (
        project_key,
        jira_cloud_id,
        board_id,
        oz_env_id,
        github_repo,
        active
      ) VALUES (
        'INACTIVE',
        'jira-cloud-id-2',
        2,
        'env-2',
        'hyperbolic-co/hyper-dispatch',
        false
      );
    `);

    const config = await queries.getProjectConfig("HYDI");
    const missingConfig = await queries.getProjectConfig("INACTIVE");
    const activeConfigs = await queries.listActiveProjectConfigs();

    expect(config?.project_key).toBe("HYDI");
    expect(missingConfig).toBeNull();
    expect(activeConfigs.map((item) => item.project_key)).toEqual(["HYDI"]);
  });


  it("integration: status/project listing helpers and deleteRun operate on persisted rows", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-100",
      projectKey: "HYDI",
      status: "queued",
      priority: 1,
    });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-101",
      projectKey: "HYDI",
      status: "queued",
      priority: 5,
    });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-102",
      projectKey: "HYDI",
      status: "running",
      priority: 0,
    });

    const queued = await queries.getRunsByStatus("queued");
    const byProject = await queries.getRunsByProject("HYDI");
    const allRuns = await queries.getAllRuns();

    expect(queued.map((run) => run.ticket_key)).toEqual(["HYDI-101", "HYDI-100"]);
    expect(byProject).toHaveLength(3);
    expect(allRuns).toHaveLength(3);

    await queries.deleteRun("HYDI-101");
    const afterDelete = await queries.getRunsByStatus("queued");
    expect(afterDelete.map((run) => run.ticket_key)).toEqual(["HYDI-100"]);
  });
});
