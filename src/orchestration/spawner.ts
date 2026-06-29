import { env, resolveProjectTokens } from "../config/env.js";
import * as jira from "../jira/client.js";
import { createRun, updateRunStatus } from "../db/queries.js";
import type { ProjectConfig } from "../db/queries.js";
import type { JiraIssue } from "../jira/types.js";
import type { McpServerConfig } from "oz-agent-sdk/resources/agent/agent";
import { resolveJiraColumnMappings } from "../jira/columns.js";
import { getOzClient } from "./oz-client.js";
import { buildAgentBranchName } from "./branch-name.js";

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
  const branchName = buildAgentBranchName(ticketKey, summary);
  const jiraIssueUrl = `${env.JIRA_SITE_URL.replace(/\/+$/, "")}/browse/${ticketKey}`;

  const lines: string[] = [
    `Implement ${ticketKey}: ${summary}`,
    `Branch name: ${branchName}`,
    "Use Jira as the source of truth for this task.",
    `Ticket: ${ticketKey}`,
    `Jira URL: ${jiraIssueUrl}`,
    "Before making code changes, use the available Jira tools to read the ticket and any related context needed to implement it. At minimum, fetch:",
    "- Title/summary",
    "- Description",
    "- Direct subtasks, including the same fields listed here for each subtask",
    "- Attachments (download contents when needed to understand or implement the ticket)",
    "- Linked work items",
    "- Comments",
    "- Parent epic",
    "Implement the feature described in the ticket. Do not rely on this prompt as the specification beyond identifying the ticket key and the required Jira lookup fields. If Jira context is unavailable, stop and report the blocker rather than guessing.",
    "Follow the project worker instructions: use the branch name above, keep changes scoped to this ticket, add or update tests, run the required validation commands, commit, create a non-draft PR, and report the PR artifact.",
  ];
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

// ─── Revision model resolution ─────────────────────────────────────────────

/**
 * Ordered tier names. The index is the "rank" used for floor/escalate logic.
 */
export const TIER_MODELS = [
  "auto-open",
  "auto-efficient",
  "auto",
  "auto-genius",
] as const;

function rank(model: string | null | undefined): number {
  const idx = TIER_MODELS.indexOf(
    (model ?? "") as (typeof TIER_MODELS)[number]
  );
  return idx < 0 ? -1 : idx;
}

/**
 * Resolve the model to use for a revision run:
 *   1. Start from the per-ticket/default model (`resolveModel`).
 *   2. Floor at `opts.floorTier` (the review tier that triggered the revision).
 *   3. If `opts.escalate` is true (a finding repeated across rounds), bump one tier.
 *   4. If both base and floorTier are outside the tier list, return base unchanged
 *      so the Oz workspace default takes effect.
 */
export function resolveRevisionModel(
  issue: JiraIssue,
  config: ProjectConfig,
  opts: { floorTier: string | null; escalate: boolean }
): string | undefined {
  const base = resolveModel(issue, config);
  const baseRank = rank(base);
  // An explicit non-tier (custom) base model is respected as-is — never overridden by tier floor/escalate.
  if (base && baseRank < 0) return base;
  let idx = Math.max(baseRank, rank(opts.floorTier));
  if (idx < 0) return base;                 // nothing ranked → Oz default
  if (opts.escalate) idx = Math.min(idx + 1, TIER_MODELS.length - 1);
  return TIER_MODELS[idx]!;
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
  issue: JiraIssue,
  runType: string = "implementation"
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

  const runRecord = await createRun({
    ticketKey,
    runType,
    status: "running",
    spawnedAt: new Date(),
  });

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
  let sessionLink: string | null = null;
  try {
    const runDetails = await client.agent.runs.retrieve(runResponse.run_id);
    sessionLink = runDetails.session_link ?? null;
  } catch (err) {
    console.warn(
      `[spawner] Failed to fetch session link for ${ticketKey} (${runResponse.run_id}):`,
      err
    );
  }

  await updateRunStatus(ticketKey, {
    status: "running",
    run_id: runResponse.run_id,
    run_record_id: runRecord.id,
    model: model ?? null,
    spawned_at: new Date(),
    session_link: sessionLink,
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
