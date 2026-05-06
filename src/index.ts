import { env } from "./config/env.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { runMigrations } from "./db/migrate.js";
import { webhookRouter } from "./webhook/jira.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { apiRouter } from "./routes/api.js";
import { configRouter } from "./routes/config.js";
import { startSchedulerLoop } from "./orchestration/scheduler.js";
import { startMonitorLoop } from "./orchestration/monitor.js";

const app = new Hono();

// Health check
app.get("/", (c) => c.json({ status: "ok" }));

// Route groups
app.route("/webhook", webhookRouter);
app.route("/api", apiRouter);
app.route("/dashboard", dashboardRouter);
app.route("/config", configRouter);

async function main(): Promise<void> {
  await runMigrations();

  startSchedulerLoop();
  startMonitorLoop();

  serve(
    {
      fetch: app.fetch,
      port: env.PORT,
    },
    (info) => {
      console.log(`HyperDispatch listening on http://localhost:${info.port}`);
    }
  );
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
