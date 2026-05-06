import OzAPI from "oz-agent-sdk";
import { env } from "../config/env.js";
import * as jira from "../jira/client.js";
import { updateRunStatus } from "../db/queries.js";
import type { ProjectConfig } from "../db/queries.js";
import type { JiraIssue } from "../jira/types.js";

// Lazy singleton — avoids constructing the client at module load time
let _ozClient: OzAPI | null = null;

function getOzClient(): OzAPI {
  if (!_ozClient) {
    _ozClient = new OzAPI({ apiKey: env.WARP_API_KEY });
  }
  return _ozClient;
}

// ─── ADF helpers ───────────────────────────────────────────────────────────

/**
 * Recursively extract plain text from an Atlassian Document Format (ADF) node.
 */
function adfToText(node: unknown, depth = 0): string {
  if (typeof node === "string") return node;
  if (typeof node !== "object" || node === null) return "";

  const obj = node as Record<string, unknown>;

  // Leaf text node
  if (typeof obj["text"] === "string") return obj["text"];

  // Recurse into content array
  if (Array.isArray(obj["content"])) {
    const parts = (obj["content"] as unknown[]).map((child) =>
      adfToText(child, depth + 1)
    );
    return parts.join(depth === 0 ? "\n" : " ").trim();
  }

  return "";
}

/**
 * Build a plain-text prompt for the agent from a Jira issue.
 */
function buildPrompt(ticketKey: string, issue: JiraIssue): string {
  const summary = issue.fields.summary;
  const description = issue.fields.description
    ? adfToText(issue.fields.description)
    : "";

  const lines: string[] = [`Implement ${ticketKey}: ${summary}`];
  if (description) {
    lines.push("", description);
  }
  return lines.join("\n");
}

/**
 * Determine which model to use for the run:
 *   1. Custom field on the issue (if model_field_id is configured)
 *   2. Project default model
 *   3. undefined → let Oz use the workspace default
 */
function resolveModel(
  issue: JiraIssue,
  config: ProjectConfig
): string | undefined {
  if (config.model_field_id) {
    const fieldValue = issue.fields[config.model_field_id];
    if (typeof fieldValue === "string" && fieldValue.trim()) {
      return fieldValue.trim();
    }
  }
  return config.default_model ?? undefined;
}

// ─── Main export ───────────────────────────────────────────────────────────

/**
 * Spawn an Oz cloud agent for the given ticket.
 * - Creates the run via the Oz SDK
 * - Updates the dispatch_runs row to "running"
 * - Transitions the Jira issue to "In Progress"
 */
export async function spawnAgent(
  ticketKey: string,
  config: ProjectConfig,
  issue: JiraIssue
): Promise<void> {
  const client = getOzClient();

  const model = resolveModel(issue, config);
  const prompt = buildPrompt(ticketKey, issue);

  // First skill in the array is the run skill (oz-agent-sdk accepts one skill)
  const skillSpec = config.skills.length > 0 ? config.skills[0] : undefined;

  const runResponse = await client.agent.run({
    prompt,
    config: {
      name: ticketKey,
      environment_id: config.oz_env_id,
      ...(model ? { model_id: model } : {}),
      ...(skillSpec ? { skill_spec: skillSpec } : {}),
    },
  });

  await updateRunStatus(ticketKey, {
    status: "running",
    run_id: runResponse.run_id,
    model: model ?? null,
    spawned_at: new Date(),
  });

  // Transition Jira issue to "In Progress" (best-effort)
  try {
    const transitions = await jira.getTransitions(ticketKey);
    const inProgress = transitions.transitions.find(
      (t) => t.name === "In Progress"
    );
    if (inProgress) {
      await jira.transitionIssue(ticketKey, inProgress.id);
    }
  } catch (err) {
    console.warn(
      `[spawner] Failed to transition ${ticketKey} to In Progress:`,
      err
    );
  }

  console.log(
    `[spawner] Spawned run ${runResponse.run_id} for ${ticketKey} (model: ${model ?? "default"})`
  );
}
