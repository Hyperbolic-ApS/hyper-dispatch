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
      TRUNCATE TABLE review_findings, dispatch_runs, dispatch_entries, project_configs, revision_events RESTART IDENTITY CASCADE;
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
    expect(winners[0]).toMatchObject({
      claimed: true,
      previousStatus: "succeeded",
      previousRunId: "run-original-701",
      runRecordId: expect.any(String),
    });
    expect(losers[0]).toEqual({
      claimed: false,
      previousStatus: null,
      previousRunId: null,
      runRecordId: null,
    });
    const failedRevisionRunId = winners[0]!.runRecordId;
    expect(failedRevisionRunId).toBeTruthy();

    await queries.releaseRevisionSlot(
      "HYDI-701",
      winners[0]!.previousStatus,
      winners[0]!.previousRunId,
      failedRevisionRunId
    );
    const runningAfterRelease = await queries.getRunsByStatus("running");
    expect(runningAfterRelease.find((run) => run.id === failedRevisionRunId)).toBeUndefined();
    const afterRelease = (await queries.getRunsByProject("HYDI")).find(
      (run) => run.ticket_key === "HYDI-701"
    );
    expect(afterRelease?.status).toBe("succeeded");
    expect(afterRelease?.run_id).toBe("run-original-701");

    const reclaim = await queries.claimRevisionSlot("HYDI-701");
    expect(reclaim).toMatchObject({
      claimed: true,
      previousStatus: "succeeded",
      previousRunId: "run-original-701",
      runRecordId: expect.any(String),
    });
  });

  it("integration: recomputeEntryStatus between revision claim and spawn cannot reopen a second claim", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-702",
      projectKey: "HYDI",
      status: "succeeded",
    });
    const priorRun = await queries.createRun({
      ticketKey: "HYDI-702",
      runType: "implementation",
      status: "succeeded",
      runId: "run-original-702",
      completedAt: new Date("2026-01-01T00:05:00.000Z"),
    });
    const claim = await queries.claimRevisionSlot("HYDI-702");
    expect(claim).toMatchObject({
      claimed: true,
      previousStatus: "succeeded",
      previousRunId: "run-original-702",
      runRecordId: expect.any(String),
    });

    await queries.updateRunStatus("HYDI-702", {
      run_record_id: priorRun.id,
      status: "succeeded",
      completed_at: new Date("2026-01-01T00:10:00.000Z"),
    });
    const projected = (await queries.getRunsByProject("HYDI")).find(
      (run) => run.ticket_key === "HYDI-702"
    );
    expect(projected?.status).toBe("running");

    const secondClaim = await queries.claimRevisionSlot("HYDI-702");
    expect(secondClaim).toEqual({
      claimed: false,
      previousStatus: null,
      previousRunId: null,
      runRecordId: null,
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

    const noPrev = {
      claimed: false,
      previousStatus: null,
      previousRunId: null,
      runRecordId: null,
    };
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
  it("integration: createRun inherits the latest known PR metadata when the newest row has null PR fields", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-901",
      projectKey: "HYDI",
      status: "queued",
    });
    const initialRun = await queries.createRun({
      ticketKey: "HYDI-901",
      runType: "implementation",
      status: "succeeded",
      runId: "run-901-impl",
      completedAt: new Date("2026-01-01T09:00:00.000Z"),
    });
    await queries.updateRunStatus("HYDI-901", {
      run_record_id: initialRun.id,
      pr_url: "https://github.com/hyperbolic-co/hyper-dispatch/pull/901",
      pr_display_state: "open",
      pr_has_conflicts: false,
      pr_review_running: true,
      pr_revision_running: false,
    });
    const nullMetadataRun = await queries.createRun({
      ticketKey: "HYDI-901",
      runType: "revision",
      status: "failed",
      runId: "run-901-null",
      completedAt: new Date("2026-01-01T09:30:00.000Z"),
    });
    await connection.sql.unsafe(`
      UPDATE dispatch_runs
      SET
        pr_url = NULL,
        pr_has_conflicts = NULL,
        pr_display_state = NULL,
        pr_review_running = NULL,
        pr_revision_running = NULL
      WHERE id = '${nullMetadataRun.id}';
    `);

    const followUpRun = await queries.createRun({
      ticketKey: "HYDI-901",
      runType: "revision",
      status: "running",
      runId: "run-901-recover",
      spawnedAt: new Date("2026-01-01T10:00:00.000Z"),
    });

    expect(followUpRun.pr_url).toBe("https://github.com/hyperbolic-co/hyper-dispatch/pull/901");
    expect(followUpRun.pr_display_state).toBe("open");
    expect(followUpRun.pr_has_conflicts).toBe(false);
    expect(followUpRun.pr_review_running).toBe(true);
    expect(followUpRun.pr_revision_running).toBe(false);
  });

  it("integration: claimRevisionSlot seeds revision rows from the latest known PR metadata when newest row is null", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-902",
      projectKey: "HYDI",
      status: "succeeded",
    });
    const implementationRun = await queries.createRun({
      ticketKey: "HYDI-902",
      runType: "implementation",
      status: "succeeded",
      runId: "run-902-impl",
      completedAt: new Date("2026-01-01T10:00:00.000Z"),
    });
    await queries.updateRunStatus("HYDI-902", {
      run_record_id: implementationRun.id,
      pr_url: "https://github.com/hyperbolic-co/hyper-dispatch/pull/902",
      pr_display_state: "open",
      pr_has_conflicts: false,
      pr_review_running: true,
      pr_revision_running: false,
    });
    const nullMetadataRun = await queries.createRun({
      ticketKey: "HYDI-902",
      runType: "revision",
      status: "failed",
      runId: "run-902-null",
      completedAt: new Date("2026-01-01T10:30:00.000Z"),
    });
    await connection.sql.unsafe(`
      UPDATE dispatch_runs
      SET
        pr_url = NULL,
        pr_has_conflicts = NULL,
        pr_display_state = NULL,
        pr_review_running = NULL,
        pr_revision_running = NULL
      WHERE id = '${nullMetadataRun.id}';
    `);

    const claim = await queries.claimRevisionSlot("HYDI-902");
    expect(claim).toMatchObject({
      claimed: true,
      previousStatus: "failed",
      previousRunId: "run-902-null",
      runRecordId: expect.any(String),
    });

    const rows = await queries.getRunsForTicket("HYDI-902");
    const insertedRevision = rows.find((row) => row.id === claim.runRecordId);
    expect(insertedRevision).toBeDefined();
    expect(insertedRevision?.run_type).toBe("revision");
    expect(insertedRevision?.status).toBe("running");
    expect(insertedRevision?.pr_url).toBe(
      "https://github.com/hyperbolic-co/hyper-dispatch/pull/902"
    );
    expect(insertedRevision?.pr_display_state).toBe("open");
    expect(insertedRevision?.pr_has_conflicts).toBe(false);
    expect(insertedRevision?.pr_review_running).toBe(true);
    expect(insertedRevision?.pr_revision_running).toBe(false);
  });

  it("integration: getRunHistoryForTickets caps history per ticket", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-950",
      projectKey: "HYDI",
      status: "queued",
    });
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-951",
      projectKey: "HYDI",
      status: "queued",
    });
    for (let i = 0; i < 30; i++) {
      await queries.createRun({
        ticketKey: "HYDI-950",
        runType: i % 2 === 0 ? "implementation" : "revision",
        status: "succeeded",
        runId: `run-950-${i}`,
      });
    }
    for (let i = 0; i < 8; i++) {
      await queries.createRun({
        ticketKey: "HYDI-951",
        runType: "implementation",
        status: "succeeded",
        runId: `run-951-${i}`,
      });
    }

    const customCap = await configQueries.getRunHistoryForTickets(
      ["HYDI-950", "HYDI-951"],
      10
    );
    expect(customCap.filter((run) => run.ticket_key === "HYDI-950")).toHaveLength(10);
    expect(customCap.filter((run) => run.ticket_key === "HYDI-951")).toHaveLength(8);

    const defaultCap = await configQueries.getRunHistoryForTickets(["HYDI-950"]);
    expect(defaultCap).toHaveLength(25);
  });

  it("integration: updateRunStatus fallback creates a run record and preserves metadata when no run row exists", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-72",
      projectKey: "HYDI",
      status: "queued",
    });

    const fallback = await queries.updateRunStatus("HYDI-72", {
      run_type: "revision",
      status: "failed",
      error: "spawn failed before run binding",
      session_link: "https://warp.dev/runs/fallback-72",
      pr_url: "https://github.com/hyperbolic-co/hyper-dispatch/pull/72",
    });
    expect(fallback?.run_type).toBe("revision");
    expect(fallback?.status).toBe("failed");
    expect(fallback?.error).toBe("spawn failed before run binding");
    expect(fallback?.session_link).toBe("https://warp.dev/runs/fallback-72");
    expect(fallback?.pr_url).toBe("https://github.com/hyperbolic-co/hyper-dispatch/pull/72");

    const failedRuns = await queries.getRunsByStatus("failed");
    const persisted = failedRuns.find((run) => run.ticket_key === "HYDI-72");
    expect(persisted).toBeDefined();
    expect(persisted?.run_type).toBe("revision");
    expect(persisted?.error).toBe("spawn failed before run binding");
    expect(persisted?.pr_url).toBe("https://github.com/hyperbolic-co/hyper-dispatch/pull/72");
  });

  it("integration: updateRunStatus fallback inherits latest known PR metadata when stale run_record_id is provided and PR fields are omitted", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-74",
      projectKey: "HYDI",
      status: "succeeded",
    });
    const implementationRun = await queries.createRun({
      ticketKey: "HYDI-74",
      runType: "implementation",
      status: "succeeded",
      runId: "run-74-impl",
      completedAt: new Date("2026-01-01T10:00:00.000Z"),
    });
    await queries.updateRunStatus("HYDI-74", {
      run_record_id: implementationRun.id,
      pr_url: "https://github.com/hyperbolic-co/hyper-dispatch/pull/74",
      pr_display_state: "open",
      pr_has_conflicts: false,
      pr_review_running: true,
      pr_revision_running: false,
    });
    const nullMetadataRun = await queries.createRun({
      ticketKey: "HYDI-74",
      runType: "revision",
      status: "failed",
      runId: "run-74-null",
      completedAt: new Date("2026-01-01T10:30:00.000Z"),
    });
    await connection.sql.unsafe(`
      UPDATE dispatch_runs
      SET
        pr_url = NULL,
        pr_has_conflicts = NULL,
        pr_display_state = NULL,
        pr_review_running = NULL,
        pr_revision_running = NULL
      WHERE id = '${nullMetadataRun.id}';
    `);

    const fallback = await queries.updateRunStatus("HYDI-74", {
      run_record_id: "11111111-2222-4333-8444-555555555555",
      run_type: "revision",
      status: "failed",
      error: "stale run_record_id",
    });
    expect(fallback).not.toBeNull();
    expect(fallback?.run_type).toBe("revision");
    expect(fallback?.status).toBe("failed");
    expect(fallback?.error).toBe("stale run_record_id");
    expect(fallback?.pr_url).toBe("https://github.com/hyperbolic-co/hyper-dispatch/pull/74");
    expect(fallback?.pr_display_state).toBe("open");
    expect(fallback?.pr_has_conflicts).toBe(false);
    expect(fallback?.pr_review_running).toBe(true);
    expect(fallback?.pr_revision_running).toBe(false);
  });

  it("integration: updateRunStatus does not fabricate a run when explicit run_record_id is missing", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-73",
      projectKey: "HYDI",
      status: "queued",
    });
    const before = await queries.getRunsForTicket("HYDI-73");
    expect(before).toHaveLength(0);

    const result = await queries.updateRunStatus("HYDI-73", {
      run_record_id: "11111111-2222-4333-8444-555555555555",
      run_type: "revision",
      status: "failed",
      error: "missing run record",
    });
    expect(result).toBeNull();

    const after = await queries.getRunsForTicket("HYDI-73");
    expect(after).toHaveLength(0);
    const projected = (await queries.getRunsByProject("HYDI")).find(
      (run) => run.ticket_key === "HYDI-73"
    );
    expect(projected?.status).toBe("queued");
  });

  it("integration: getRevisionState reflects budget defaults and derives round from revision-run count", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-9901",
      projectKey: "HYDI",
      status: "queued",
    });

    const before = await (queries as any).getRevisionState("HYDI-9901");
    expect(before).not.toBeNull();
    expect(before).toMatchObject({ round: 0, budget: 2, needsHuman: false, reviewTier: null });

    await queries.createRun({
      ticketKey: "HYDI-9901",
      runType: "revision",
      status: "running",
    });

    const after = await (queries as any).getRevisionState("HYDI-9901");
    expect(after?.round).toBe(1);
  });

  it("integration: upsertFindings detects repeated findings across rounds", async () => {
    await queries.upsertDispatchRun({
      ticketKey: "HYDI-9902",
      projectKey: "HYDI",
      status: "queued",
    });

    const f = { key: "k1", severity: "Major", title: "Fix the thing", path: "src/a.ts" };
    await (queries as any).upsertFindings("https://github.com/test/repo/pull/1", "HYDI-9902", 1, [f]);
    const result = await (queries as any).upsertFindings("https://github.com/test/repo/pull/1", "HYDI-9902", 2, [f]);
    expect(result.repeated).toEqual(["k1"]);
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
    const allRuns = await configQueries.getAllDispatchRuns();

    expect(queued.map((run) => run.ticket_key)).toEqual(["HYDI-101", "HYDI-100"]);
    expect(byProject).toHaveLength(3);
    expect(allRuns).toHaveLength(3);

    await queries.deleteRun("HYDI-101");
    const afterDelete = await queries.getRunsByStatus("queued");
    expect(afterDelete.map((run) => run.ticket_key)).toEqual(["HYDI-100"]);
  });
});
