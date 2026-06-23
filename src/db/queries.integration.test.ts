import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

type QueriesModule = typeof import("./queries.js");
type ConfigQueriesModule = typeof import("./config-queries.js");
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
  let configQueries: ConfigQueriesModule;
  let connection: ConnectionModule;

  async function resetTables() {
    await connection.sql.unsafe(`
      TRUNCATE TABLE dispatch_runs, dispatch_entries, project_configs, revision_events RESTART IDENTITY CASCADE;
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
    configQueries = await import("./config-queries.js");

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
      pr_url: prUrl,
      pr_display_state: "open",
    });

    const matched = await queries.getRunsByPrUrl(prUrl);
    expect(matched.map((run) => run.ticket_key)).toEqual(["HYDI-202", "HYDI-201"]);
    expect(matched.map((run) => run.pr_display_state)).toEqual(["open", "draft"]);
  });

  it("integration: pr_display_state check constraint rejects invalid values", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-203",
      projectKey: "HYDI",
      status: "queued",
    });
    const run203 = await queries.createRun({
      ticketKey: "HYDI-203",
      status: "queued",
    });
    await expect(
      connection.sql.unsafe(`
        UPDATE dispatch_runs
        SET pr_display_state = 'invalid_state'
        WHERE id = '${run203.id}';
      `)
    ).rejects.toThrow();
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-204",
      projectKey: "HYDI",
      status: "queued",
    });
    const run204 = await queries.createRun({
      ticketKey: "HYDI-204",
      status: "queued",
    });
    await queries.updateRunStatus("HYDI-204", {
      run_record_id: run204.id,
      pr_display_state: "open",
    });

    await queries.upsertDispatchRun({
      ticketKey: "HYDI-205",
      projectKey: "HYDI",
      status: "queued",
    });
    const run205 = await queries.createRun({
      ticketKey: "HYDI-205",
      status: "queued",
    });
    const rows205 = await queries.getRunsForTicket("HYDI-205");
    expect(rows205.map((row) => row.id)).toContain(run205.id);
    expect(rows205.find((row) => row.id === run205.id)?.pr_display_state).toBeNull();
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

  it("integration: tryRecordRevisionEvent dedupes redelivered events and deleteRevisionEvent allows retry", async () => {
    const prUrl = "https://github.com/hyperbolic-co/hyper-dispatch/pull/700";
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-700",
      projectKey: "HYDI",
      status: "succeeded",
    });
    await queries.updateRunStatus("HYDI-700", { pr_url: prUrl });

    const first = await queries.tryRecordRevisionEvent({
      eventKey: "review:700",
      ticketKey: "HYDI-700",
      prUrl,
    });
    const replay = await queries.tryRecordRevisionEvent({
      eventKey: "review:700",
      ticketKey: "HYDI-700",
      prUrl,
    });
    expect(first).toBe(true);
    expect(replay).toBe(false);

    await queries.deleteRevisionEvent("review:700");
    const afterDelete = await queries.tryRecordRevisionEvent({
      eventKey: "review:700",
      ticketKey: "HYDI-700",
      prUrl,
    });
    expect(afterDelete).toBe(true);
  });

  it("integration: concurrent claimRevisionSlot allows one winner and releaseRevisionSlot removes failed revision rows", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-701",
      projectKey: "HYDI",
      status: "succeeded",
    });
    await queries.updateRunStatus("HYDI-701", { run_id: "run-original-701" });
    const [claimA, claimB] = await Promise.all([
      queries.claimRevisionSlot("HYDI-701"),
      queries.claimRevisionSlot("HYDI-701"),
    ]);
    const claims = [claimA, claimB];
    const winners = claims.filter((claim) => claim.claimed);
    const losers = claims.filter((claim) => !claim.claimed);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]).toEqual({
      claimed: true,
      previousStatus: "succeeded",
      previousRunId: "run-original-701",
    });
    expect(losers[0]).toEqual({ claimed: false, previousStatus: null, previousRunId: null });

    const failedRevisionRun = await queries.createRun({
      ticketKey: "HYDI-701",
      runType: "revision",
      status: "running",
      spawnedAt: new Date(),
    });

    await queries.releaseRevisionSlot(
      "HYDI-701",
      winners[0]!.previousStatus,
      winners[0]!.previousRunId,
      failedRevisionRun.id
    );
    const runningAfterRelease = await queries.getRunsByStatus("running");
    expect(runningAfterRelease.find((run) => run.id === failedRevisionRun.id)).toBeUndefined();
    const afterRelease = (await queries.getRunsByProject("HYDI")).find(
      (run) => run.ticket_key === "HYDI-701"
    );
    expect(afterRelease?.status).toBe("succeeded");
    expect(afterRelease?.run_id).toBe("run-original-701");

    const reclaim = await queries.claimRevisionSlot("HYDI-701");
    expect(reclaim).toEqual({
      claimed: true,
      previousStatus: "succeeded",
      previousRunId: "run-original-701",
    });
  });

  it("integration: claimRevisionSlot does not steal queued, blocked, or blocked_cycle runs", async () => {
    await queries.upsertDispatchRun({ ticketKey: "HYDI-710", projectKey: "HYDI", status: "queued" });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-711",
      projectKey: "HYDI",
      status: "blocked",
      blockedBy: ["HYDI-1"],
    });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-712",
      projectKey: "HYDI",
      status: "blocked_cycle",
      blockedBy: ["HYDI-2"],
    });

    const noPrev = { claimed: false, previousStatus: null, previousRunId: null };
    expect(await queries.claimRevisionSlot("HYDI-710")).toEqual(noPrev);
    expect(await queries.claimRevisionSlot("HYDI-711")).toEqual(noPrev);
    expect(await queries.claimRevisionSlot("HYDI-712")).toEqual(noPrev);

    // The scheduler-owned rows are untouched (still claimable by claimRunForSpawn).
    expect(await queries.claimRunForSpawn("HYDI-710")).toBe(true);
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

  it("integration: setTicketStatuses upserts every supplied row in a single batched UPDATE", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-300",
      projectKey: "HYDI",
      summary: "First",
      status: "running",
    });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-301",
      projectKey: "HYDI",
      summary: "Second",
      status: "running",
    });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-302",
      projectKey: "HYDI",
      summary: "Unmentioned",
      status: "running",
    });

    await queries.setTicketStatuses([
      { ticketKey: "HYDI-300", statusName: "In Progress", statusCategory: "in-flight" },
      { ticketKey: "HYDI-301", statusName: "Done", statusCategory: "done" },
    ]);

    const allRuns = await queries.getRunsByProject("HYDI");
    const persisted = allRuns
      .filter((run) => ["HYDI-300", "HYDI-301", "HYDI-302"].includes(run.ticket_key))
      .map((run) => ({
        ticket_key: run.ticket_key,
        ticket_status_name: run.ticket_status_name,
        ticket_status_category: run.ticket_status_category,
      }))
      .sort((a, b) => a.ticket_key.localeCompare(b.ticket_key));
    expect(persisted).toEqual([
      { ticket_key: "HYDI-300", ticket_status_name: "In Progress", ticket_status_category: "in-flight" },
      { ticket_key: "HYDI-301", ticket_status_name: "Done", ticket_status_category: "done" },
      { ticket_key: "HYDI-302", ticket_status_name: null, ticket_status_category: null },
    ]);

    // Empty-input fast path: no-op (and no SQL error from an empty array).
    await expect(queries.setTicketStatuses([])).resolves.toBeUndefined();
  });

  it("integration: updateRunStatus partial updates preserve unspecified fields and enforce null/undefined behavior", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-70",
      projectKey: "HYDI",
      summary: "Update status behavior",
      status: "blocked",
      blockedBy: ["HYDI-71"],
    });
    await queries.createRun({
      ticketKey: "HYDI-70",
      status: "blocked",
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
    expect(clearedBlockedBy?.blocked_by).toEqual(["HYDI-71"]);
    const reloadedAfterClear = await queries.getRunsByProject("HYDI");
    expect(reloadedAfterClear.find((run) => run.ticket_key === "HYDI-70")?.blocked_by).toBeNull();

    const nullPrUrlAttempt = await queries.updateRunStatus("HYDI-70", {
      pr_url: null,
    });
    expect(nullPrUrlAttempt?.pr_url).toBe("https://github.com/hyperbolic-co/hyper-dispatch/pull/70");
    expect(nullPrUrlAttempt?.model).toBe("sonnet");
    const nullModelAndSessionLinkAttempt = await queries.updateRunStatus("HYDI-70", {
      model: null,
      session_link: null,
    });
    expect(nullModelAndSessionLinkAttempt?.model).toBe("sonnet");
    expect(nullModelAndSessionLinkAttempt?.session_link).toBeNull();

    const updatedPrDisplayState = await queries.updateRunStatus("HYDI-70", {
      pr_display_state: "merged",
    });
    expect(updatedPrDisplayState?.pr_display_state).toBe("merged");

    const preservePrDisplayState = await queries.updateRunStatus("HYDI-70", {
      status: "succeeded",
    });
    expect(preservePrDisplayState?.pr_display_state).toBe("merged");
  });

  it("integration: latest ticket projection keeps PR metadata when a later revision run has no PR artifact", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-900",
      projectKey: "HYDI",
      summary: "Preserve PR metadata after revision",
      status: "queued",
    });
    const implementationRun = await queries.createRun({
      ticketKey: "HYDI-900",
      runType: "implementation",
      status: "running",
      runId: "run-900-impl",
      spawnedAt: new Date("2026-01-01T10:00:00.000Z"),
    });
    await queries.updateRunStatus("HYDI-900", {
      run_record_id: implementationRun.id,
      status: "succeeded",
      completed_at: new Date("2026-01-01T10:05:00.000Z"),
      pr_url: "https://github.com/hyperbolic-co/hyper-dispatch/pull/900",
      pr_display_state: "open",
      pr_has_conflicts: false,
    });

    const revisionRun = await queries.createRun({
      ticketKey: "HYDI-900",
      runType: "revision",
      status: "running",
      runId: "run-900-rev",
      spawnedAt: new Date("2026-01-01T11:00:00.000Z"),
    });
    await queries.updateRunStatus("HYDI-900", {
      run_record_id: revisionRun.id,
      status: "succeeded",
      completed_at: new Date("2026-01-01T11:03:00.000Z"),
      pr_url: null,
      pr_display_state: null,
      pr_has_conflicts: null,
    });

    const page = await configQueries.getDispatchRunsPage({}, 20, 0);
    const projected = page.find((run) => run.ticket_key === "HYDI-900");
    expect(projected).toBeDefined();
    expect(projected?.run_type).toBe("revision");
    expect(projected?.run_id).toBe("run-900-rev");
    expect(projected?.status).toBe("succeeded");
    expect(projected?.pr_url).toBe("https://github.com/hyperbolic-co/hyper-dispatch/pull/900");
    expect(projected?.pr_display_state).toBe("open");
    expect(projected?.pr_has_conflicts).toBe(false);
  });

  it("integration: updateRunStatus fallback creates a run record and preserves metadata when no run row exists", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-72",
      projectKey: "HYDI",
      status: "queued",
    });

    const fallback = await queries.updateRunStatus("HYDI-72", {
      status: "failed",
      error: "spawn failed before run binding",
      session_link: "https://warp.dev/runs/fallback-72",
      pr_url: "https://github.com/hyperbolic-co/hyper-dispatch/pull/72",
    });
    expect(fallback?.status).toBe("failed");
    expect(fallback?.error).toBe("spawn failed before run binding");
    expect(fallback?.session_link).toBe("https://warp.dev/runs/fallback-72");
    expect(fallback?.pr_url).toBe("https://github.com/hyperbolic-co/hyper-dispatch/pull/72");

    const failedRuns = await queries.getRunsByStatus("failed");
    const persisted = failedRuns.find((run) => run.ticket_key === "HYDI-72");
    expect(persisted).toBeDefined();
    expect(persisted?.error).toBe("spawn failed before run binding");
    expect(persisted?.pr_url).toBe("https://github.com/hyperbolic-co/hyper-dispatch/pull/72");
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
    await queries.createRun({
      ticketKey: "HYDI-90",
      status: "running",
    });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-91",
      projectKey: "HYDI",
      status: "queued",
    });
    await queries.createRun({
      ticketKey: "HYDI-91",
      status: "queued",
    });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-92",
      projectKey: "HYDI",
      status: "running",
    });
    await queries.createRun({
      ticketKey: "HYDI-92",
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
    await queries.createRun({
      ticketKey: "HYDI-100",
      status: "queued",
    });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-101",
      projectKey: "HYDI",
      status: "queued",
      priority: 5,
    });
    await queries.createRun({
      ticketKey: "HYDI-101",
      status: "queued",
    });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-102",
      projectKey: "HYDI",
      status: "running",
      priority: 0,
    });
    await queries.createRun({
      ticketKey: "HYDI-102",
      status: "running",
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
