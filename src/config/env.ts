import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}
function optionalEnvUndefined(name: string): string | undefined {
  return process.env[name];
}

export const env = {
  // Jira
  JIRA_SITE_URL: requireEnv("JIRA_SITE_URL"),
  JIRA_CLOUD_ID: requireEnv("JIRA_CLOUD_ID"),
  JIRA_API_TOKEN: requireEnv("JIRA_API_TOKEN"),

  // Warp
  WARP_API_KEY: requireEnv("WARP_API_KEY"),

  // Database
  DATABASE_URL: requireEnv("DATABASE_URL"),

  // GitHub
  GITHUB_TOKEN: requireEnv("GITHUB_TOKEN"),

  // Coolify (optional; used for prod deployment status checks)
  COOLIFY_BASE_URL: optionalEnvUndefined("COOLIFY_BASE_URL"),
  COOLIFY_API_TOKEN: optionalEnvUndefined("COOLIFY_API_TOKEN"),
  COOLIFY_PRODUCTION_APP_UUID: optionalEnvUndefined("COOLIFY_PRODUCTION_APP_UUID"),

  // Agent limits
  MAX_CONCURRENT_AGENTS: parseInt(optionalEnv("MAX_CONCURRENT_AGENTS", "4"), 10),
  MAX_RUN_DURATION_HOURS: parseInt(optionalEnv("MAX_RUN_DURATION_HOURS", "2"), 10),

  // Server
  PORT: parseInt(optionalEnv("PORT", "3000"), 10),
} as const;

export type Env = typeof env;

// ─── Per-project token resolution ─────────────────────────────────────────────

import type { ProjectConfig } from "../db/config-queries.js";

/**
 * Returns the effective GitHub and Jira tokens for a project.
 * Per-project values take precedence over the global env vars.
 */
export function resolveProjectTokens(config: ProjectConfig): {
  githubToken: string;
  jiraApiToken: string;
} {
  return {
    githubToken: config.github_pat ?? env.GITHUB_TOKEN,
    jiraApiToken: config.jira_api_token ?? env.JIRA_API_TOKEN,
  };
}
