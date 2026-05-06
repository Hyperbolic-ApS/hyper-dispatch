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

export const env = {
  // Jira
  JIRA_BASE_URL: requireEnv("JIRA_BASE_URL"),
  JIRA_EMAIL: requireEnv("JIRA_EMAIL"),
  JIRA_API_TOKEN: requireEnv("JIRA_API_TOKEN"),

  // Warp
  WARP_API_KEY: requireEnv("WARP_API_KEY"),

  // Database
  DATABASE_URL: requireEnv("DATABASE_URL"),

  // GitHub
  GITHUB_TOKEN: requireEnv("GITHUB_TOKEN"),

  // Agent limits
  MAX_CONCURRENT_AGENTS: parseInt(optionalEnv("MAX_CONCURRENT_AGENTS", "4"), 10),
  MAX_RUN_DURATION_HOURS: parseInt(optionalEnv("MAX_RUN_DURATION_HOURS", "2"), 10),

  // Server
  PORT: parseInt(optionalEnv("PORT", "3000"), 10),
} as const;

export type Env = typeof env;
