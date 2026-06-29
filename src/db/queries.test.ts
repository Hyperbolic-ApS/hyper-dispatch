import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "./connection.js";
import {
  getActiveRunCount,
  getProjectConfig,
  getRunsByPrUrl,
  removeBlocker,
  updateRunStatus,
  upsertDispatchRun,
} from "./queries.js";

const shouldRunDbTests =
  process.env.RUN_DB_TESTS === "1" && process.env.TEST_DB_MODE !== "pglite";

if (shouldRunDbTests) {
  describe("db queries integration", () => {
    beforeAll(async () => {
      const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
      await sql.unsafe(schema);
      await sql`TRUNCATE TABLE dispatch_runs RESTART IDENTITY CASCADE`;
      await sql`TRUNCATE TABLE project_configs RESTART IDENTITY CASCADE`;
      await sql`
        INSERT INTO project_configs (
          project_key,
          jira_cloud_id,
          board_id,
          oz_env_id,
          github_repo,
          active
        ) VALUES ('HYDI', 'cloud', 1, 'env_1', 'org/repo', true)
      `;
    });

    it("upserts and updates a dispatch run", async () => {
      await upsertDispatchRun({
        ticketKey: "HYDI-1",
        projectKey: "HYDI",
        summary: "Ticket summary",
        status: "blocked",
        blockedBy: ["HYDI-0"],
      });

      const updated = await updateRunStatus("HYDI-1", {
        status: "running",
        run_id: "run_1",
        pr_display_state: "open",
      });

      expect(updated?.status).toBe("running");
      expect(updated?.run_id).toBe("run_1");
      expect(updated?.pr_display_state).toBe("open");

      const preserved = await updateRunStatus("HYDI-1", {
        status: "succeeded",
      });
      expect(preserved?.status).toBe("succeeded");
      expect(preserved?.pr_display_state).toBe("open");
    });

    it("returns runs by PR URL", async () => {
      const prUrl = "https://github.com/org/repo/pull/101";

      await upsertDispatchRun({
        ticketKey: "HYDI-5",
        projectKey: "HYDI",
        status: "queued",
      });
      await updateRunStatus("HYDI-5", {
        pr_url: prUrl,
        pr_display_state: "draft",
      });

      await upsertDispatchRun({
        ticketKey: "HYDI-6",
        projectKey: "HYDI",
        status: "queued",
      });
      await updateRunStatus("HYDI-6", {
        pr_url: prUrl,
        pr_display_state: "open",
      });

      await upsertDispatchRun({
        ticketKey: "HYDI-7",
        projectKey: "HYDI",
        status: "queued",
      });
      await updateRunStatus("HYDI-7", {
        pr_url: "https://github.com/org/repo/pull/102",
      });

      const matches = await getRunsByPrUrl(prUrl);
      expect(matches.map((run) => run.ticket_key)).toEqual(["HYDI-6", "HYDI-5"]);
      expect(matches.map((run) => run.pr_display_state)).toEqual(["open", "draft"]);
    });

    it("removes blockers and auto-queues when no blockers remain", async () => {
      await upsertDispatchRun({
        ticketKey: "HYDI-2",
        projectKey: "HYDI",
        status: "blocked",
        blockedBy: ["HYDI-10", "HYDI-11"],
      });

      await removeBlocker("HYDI-2", "HYDI-10");
      const stillBlocked = await removeBlocker("HYDI-2", "HYDI-11");

      expect(stillBlocked?.blocked_by).toEqual([]);
      expect(stillBlocked?.status).toBe("queued");
    });

    it("counts active running runs and fetches project configs", async () => {
      await upsertDispatchRun({
        ticketKey: "HYDI-3",
        projectKey: "HYDI",
        status: "running",
      });
      await upsertDispatchRun({
        ticketKey: "HYDI-4",
        projectKey: "HYDI",
        status: "queued",
      });

      expect(await getActiveRunCount()).toBeGreaterThanOrEqual(1);
      const config = await getProjectConfig("HYDI");
      expect(config?.project_key).toBe("HYDI");
    });
  });
} else {
  describe("db queries integration guard", () => {
    it("runs db integration tests only when RUN_DB_TESTS=1", () => {
      expect(
        process.env.RUN_DB_TESTS !== "1" || process.env.TEST_DB_MODE === "pglite"
      ).toBe(true);
    });
  });
}
