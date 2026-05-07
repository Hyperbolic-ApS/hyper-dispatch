import { afterEach, beforeEach, vi } from "vitest";

process.env.JIRA_BASE_URL ??= "https://example.atlassian.net";
process.env.JIRA_EMAIL ??= "agent@example.com";
process.env.JIRA_API_TOKEN ??= "token";
process.env.WARP_API_KEY ??= "warp-key";
process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:5432/hyper_dispatch_test";
process.env.GITHUB_TOKEN ??= "github-token";
process.env.MAX_CONCURRENT_AGENTS ??= "4";
process.env.MAX_RUN_DURATION_HOURS ??= "2";
process.env.PORT ??= "3000";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
