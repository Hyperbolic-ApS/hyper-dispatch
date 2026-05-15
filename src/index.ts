import { env } from "./config/env.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { runMigrations } from "./db/migrate.js";
import { webhookRouter } from "./webhook/jira.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { apiRouter } from "./routes/api.js";
import { configRouter } from "./routes/config.js";
import { authRouter } from "./routes/auth.js";
import { requireAdmin, requireAuth } from "./auth/middleware.js";
import { startSchedulerLoop } from "./orchestration/scheduler.js";
import { startMonitorLoop } from "./orchestration/monitor.js";

const app = new Hono();

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Redirect root to dashboard
app.get("/", (c) => c.redirect("/dashboard"));

// Route groups
app.route("/webhook", webhookRouter);

app.use("/auth/account", requireAuth);
app.use("/auth/change-password", requireAuth);
app.route("/auth", authRouter);

app.use("/dashboard", requireAuth);
app.use("/dashboard/*", requireAuth);
app.use("/api/*", requireAuth);
app.route("/api", apiRouter);

app.use("/config", requireAuth);
app.use("/config/*", requireAuth);
app.use("/config/users", requireAdmin);
app.use("/config/users/*", requireAdmin);
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
