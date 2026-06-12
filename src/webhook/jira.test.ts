import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { makeDispatchRun, makeProjectConfig } from "../test/fixtures.js";

const getProjectConfigMock = vi.fn();
const getRunsBlockedByMock = vi.fn();
const getRunsByPrUrlMock = vi.fn();
const removeBlockerMock = vi.fn();
const updateRunStatusMock = vi.fn();
const syncTicketInToDoMock = vi.fn();
let githubWebhookSecret: string | undefined = "test-secret";

vi.mock("../db/queries.js", () => ({
  getRunsByPrUrl: getRunsByPrUrlMock,
  getProjectConfig: getProjectConfigMock,
  getRunsBlockedBy: getRunsBlockedByMock,
  removeBlocker: removeBlockerMock,
  updateRunStatus: updateRunStatusMock,
}));

vi.mock("../orchestration/ticket-sync.js", () => ({
  syncTicketInToDo: syncTicketInToDoMock,
}));

vi.mock("../config/env.js", () => ({
  env: {
    get GITHUB_WEBHOOK_SECRET() {
      return githubWebhookSecret;
    },
  },
}));

function makeGithubSignature(body: string, secret = "test-secret"): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("webhookRouter", () => {
  beforeEach(() => {
    githubWebhookSecret = "test-secret";
    getProjectConfigMock.mockReset();
    getRunsBlockedByMock.mockReset();
    getRunsByPrUrlMock.mockReset();
    removeBlockerMock.mockReset();
    syncTicketInToDoMock.mockReset();
    updateRunStatusMock.mockReset();
  });
  it("returns 400 for invalid JSON", async () => {
    const { webhookRouter } = await import("./jira.js");
    const res = await webhookRouter.request("http://localhost/jira", {
      method: "POST",
      body: "{invalid",
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });

  it("returns 400 when required fields are missing", async () => {
    const { webhookRouter } = await import("./jira.js");
    const res = await webhookRouter.request("http://localhost/jira", {
      method: "POST",
      body: JSON.stringify({ issueKey: "HYDI-1", projectKey: "HYDI" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Missing required fields: issueKey, projectKey, transitionTarget",
    });
  });

  it("ignores events for unconfigured projects", async () => {
    getProjectConfigMock.mockResolvedValue(null);
    const { webhookRouter } = await import("./jira.js");

    const res = await webhookRouter.request("http://localhost/jira", {
      method: "POST",
      body: JSON.stringify({
        issueKey: "HYDI-1",
        projectKey: "HYDI",
        transitionTarget: "To Do",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(await res.json()).toEqual({
      action: "ignored",
      reason: "project not configured",
    });
  });

  it("syncs tickets that move into To Do", async () => {
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    syncTicketInToDoMock.mockResolvedValue({
      action: "queued",
      ticketKey: "HYDI-1",
    });
    const { webhookRouter } = await import("./jira.js");

    const res = await webhookRouter.request("http://localhost/jira", {
      method: "POST",
      body: JSON.stringify({
        issueKey: "HYDI-1",
        projectKey: "HYDI",
        transitionTarget: "to do",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(syncTicketInToDoMock).toHaveBeenCalledWith("HYDI-1", "HYDI");
    expect(await res.json()).toEqual({
      action: "queued",
      ticketKey: "HYDI-1",
    });
  });

  it("removes blockers for dependent runs when a ticket is marked done", async () => {
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    getRunsBlockedByMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-2", blocked_by: ["HYDI-1"] }),
      makeDispatchRun({ ticket_key: "HYDI-3", blocked_by: ["HYDI-1"] }),
    ]);
    removeBlockerMock
      .mockResolvedValueOnce(makeDispatchRun({ ticket_key: "HYDI-2" }))
      .mockResolvedValueOnce(null);

    const { webhookRouter } = await import("./jira.js");
    const res = await webhookRouter.request("http://localhost/jira", {
      method: "POST",
      body: JSON.stringify({
        issueKey: "HYDI-1",
        projectKey: "HYDI",
        transitionTarget: "done",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(removeBlockerMock).toHaveBeenCalledTimes(2);
    expect(await res.json()).toEqual({ action: "unblocked", count: 1 });
  });

  it("ignores non-actionable transitions", async () => {
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    const { webhookRouter } = await import("./jira.js");
    const res = await webhookRouter.request("http://localhost/jira", {
      method: "POST",
      body: JSON.stringify({
        issueKey: "HYDI-1",
        projectKey: "HYDI",
        transitionTarget: "In Review",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(await res.json()).toEqual({ action: "ignored" });
  });

  it("returns 503 when GitHub webhook secret is not configured", async () => {
    githubWebhookSecret = undefined;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { webhookRouter } = await import("./jira.js");

    const res = await webhookRouter.request("http://localhost/github", {
      method: "POST",
      body: JSON.stringify({ zen: "keep it logically awesome" }),
      headers: { "x-github-event": "ping" },
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "GitHub webhook is not configured" });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "GitHub webhook received but GITHUB_WEBHOOK_SECRET is not configured"
    );
    githubWebhookSecret = "test-secret";
  });

  it("returns 401 when GitHub signature is missing", async () => {
    const body = JSON.stringify({ zen: "keep it logically awesome" });
    const { webhookRouter } = await import("./jira.js");

    const res = await webhookRouter.request("http://localhost/github", {
      method: "POST",
      body,
      headers: { "x-github-event": "ping" },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid webhook signature" });
  });

  it("returns 401 when GitHub signature is invalid", async () => {
    const body = JSON.stringify({ zen: "keep it logically awesome" });
    const { webhookRouter } = await import("./jira.js");

    const res = await webhookRouter.request("http://localhost/github", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=not-valid",
      },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid webhook signature" });
  });

  it("accepts valid signed ping events", async () => {
    const body = JSON.stringify({ zen: "keep it logically awesome" });
    const { webhookRouter } = await import("./jira.js");

    const res = await webhookRouter.request("http://localhost/github", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "ping",
        "x-hub-signature-256": makeGithubSignature(body),
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: "pong" });
  });

  it.each([
    {
      name: "merged",
      pull_request: {
        html_url: "https://github.com/org/repo/pull/101",
        state: "closed",
        draft: false,
        merged_at: "2026-06-12T00:00:00.000Z",
      },
      expected: "merged",
    },
    {
      name: "draft",
      pull_request: {
        html_url: "https://github.com/org/repo/pull/101",
        state: "open",
        draft: true,
        merged_at: null,
      },
      expected: "draft",
    },
    {
      name: "open",
      pull_request: {
        html_url: "https://github.com/org/repo/pull/101",
        state: "open",
        draft: false,
        merged_at: null,
      },
      expected: "open",
    },
    {
      name: "closed",
      pull_request: {
        html_url: "https://github.com/org/repo/pull/101",
        state: "closed",
        draft: false,
        merged_at: null,
      },
      expected: "closed",
    },
  ])("updates matching run PR display state to $name", async ({ pull_request, expected }) => {
    getRunsByPrUrlMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-64", pr_url: pull_request.html_url }),
    ]);
    updateRunStatusMock.mockResolvedValue(makeDispatchRun({ ticket_key: "HYDI-64" }));
    const body = JSON.stringify({ action: "edited", pull_request });
    const { webhookRouter } = await import("./jira.js");

    const res = await webhookRouter.request("http://localhost/github", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": makeGithubSignature(body),
      },
    });

    expect(res.status).toBe(200);
    expect(getRunsByPrUrlMock).toHaveBeenCalledWith(pull_request.html_url);
    expect(updateRunStatusMock).toHaveBeenCalledWith("HYDI-64", {
      pr_display_state: expected,
    });
    expect(await res.json()).toMatchObject({
      action: "updated",
      pr_url: pull_request.html_url,
      pr_display_state: expected,
      run_count: 1,
    });
  });

  it("ignores signed pull_request events for unknown PRs", async () => {
    getRunsByPrUrlMock.mockResolvedValue([]);
    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        html_url: "https://github.com/org/repo/pull/999",
        state: "closed",
        draft: false,
        merged_at: null,
      },
    });
    const { webhookRouter } = await import("./jira.js");

    const res = await webhookRouter.request("http://localhost/github", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": makeGithubSignature(body),
      },
    });

    expect(res.status).toBe(200);
    expect(updateRunStatusMock).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ action: "ignored", reason: "pr not tracked" });
  });
});
