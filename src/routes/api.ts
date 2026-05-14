import { Hono } from "hono";
import { getAllDispatchRuns, getRunCountsByStatus } from "../db/config-queries.js";
import { annotateRunsWithProdDeploymentStatus } from "../coolify/prod-deployment.js";

export const apiRouter = new Hono();

apiRouter.get("/status", async (c) => {
  const [runs, countRows] = await Promise.all([
    getAllDispatchRuns(),
    getRunCountsByStatus(),
  ]);
  const runsWithProdDeployment = await annotateRunsWithProdDeploymentStatus(runs);

  const counts: Record<string, number> = {
    running: 0,
    queued: 0,
    blocked: 0,
    succeeded: 0,
    failed: 0,
    stale: 0,
  };
  for (const row of countRows) {
    if (row.status === "blocked_cycle") {
      counts.blocked = (counts.blocked ?? 0) + parseInt(row.count, 10);
    } else {
      counts[row.status] = parseInt(row.count, 10);
    }
  }

  return c.json({ runs: runsWithProdDeployment, counts });
});
