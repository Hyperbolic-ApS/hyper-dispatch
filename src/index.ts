import { env } from "./config/env.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { runMigrations } from "./db/migrate.js";

const app = new Hono();

// Health check
app.get("/", (c) => c.json({ status: "ok" }));

// Placeholder route groups
app.route("/webhook", new Hono());
app.route("/api", new Hono());
app.route("/dashboard", new Hono());
app.route("/config", new Hono());

async function main(): Promise<void> {
  await runMigrations();

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
