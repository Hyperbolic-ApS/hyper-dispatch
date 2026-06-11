import { resolveProjectTokens } from "../config/env.js";
import * as jira from "../jira/client.js";
import { updateRunStatus } from "../db/queries.js";
import type { ProjectConfig } from "../db/queries.js";
import type { JiraIssue } from "../jira/types.js";
import type { McpServerConfig } from "oz-agent-sdk/resources/agent/agent";
import { resolveJiraColumnMappings } from "../jira/columns.js";
import { getOzClient } from "./oz-client.js";

// ─── ADF helpers ───────────────────────────────────────────────────────────

/**
 * Recursively extract plain text from an Atlassian Document Format (ADF) node.
 */
export function adfToText(node: unknown, depth = 0): string {
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
export function buildPrompt(ticketKey: string, issue: JiraIssue): string {
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
export function resolveModel(
  issue: JiraIssue,
  config: ProjectConfig
): string | undefined {
  if (config.model_field_id) {
    const fieldValue = issue.fields[config.model_field_id];
    if (typeof fieldValue === "string" && fieldValue.trim()) {
      return fieldValue.trim();
    }
    if (
      typeof fieldValue === "object" &&
      fieldValue !== null &&
      "value" in fieldValue
    ) {
      const nestedValue = (fieldValue as { value?: unknown }).value;
      if (typeof nestedValue === "string" && nestedValue.trim()) {
        return nestedValue.trim();
      }
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
  const { ozApiKey } = resolveProjectTokens(config);
  const client = getOzClient(ozApiKey);

  const model = resolveModel(issue, config);
  const prompt = buildPrompt(ticketKey, issue);
  const mcpServers = config.mcp_servers as Record<string, McpServerConfig> | null;

  // First skill in the array is the run skill (oz-agent-sdk accepts one skill)
  const skillSpec = config.skills.length > 0 ? config.skills[0] : undefined;

  // Optional per-project Oz agent identity, used as the run's execution
  // principal so all of a project's runs are attributed to the same agent.
  // Only valid for team-owned runs (the default for single-team API keys).
  const agentIdentityUid = config.oz_agent_identity_uid?.trim()
    ? config.oz_agent_identity_uid.trim()
    : undefined;

  const runResponse = await client.agent.run({
    prompt,
    ...(agentIdentityUid ? { agent_identity_uid: agentIdentityUid } : {}),
    config: {
      name: ticketKey,
      environment_id: config.oz_env_id,
      ...(model ? { model_id: model } : {}),
      ...(skillSpec ? { skill_spec: skillSpec } : {}),
      ...(mcpServers ? { mcp_servers: mcpServers } : {}),
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
    const columnMappings = resolveJiraColumnMappings({
      backlog: config.backlog_column_name,
      toDo: config.to_do_column_name,
      inProgress: config.in_progress_column_name,
      inReview: config.in_review_column_name,
      done: config.done_column_name,
    });
    const transitions = await jira.getTransitions(ticketKey);
    const inProgress = transitions.transitions.find(
      (t) => t.name.trim().toLowerCase() === columnMappings.inProgress.toLowerCase()
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
