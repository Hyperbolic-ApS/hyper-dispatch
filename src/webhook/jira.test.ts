import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { makeDispatchRun, makeProjectConfig } from "../test/fixtures.js";

const getProjectConfigMock = vi.fn();
const getRunsBlockedByMock = vi.fn();
const getRunsByPrUrlMock = vi.fn();
const removeBlockerMock = vi.fn();
const updateRunStatusMock = vi.fn();
const syncTicketInToDoMock = vi.fn();
const jiraGetIssueMock = vi.fn();
const jiraGetTransitionsMock = vi.fn();
const jiraTransitionIssueMock = vi.fn();
const handleGithubRevisionWebhookMock = vi.fn();
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
vi.mock("../jira/client.js", () => ({
  getIssue: jiraGetIssueMock,
  getTransitions: jiraGetTransitionsMock,
  transitionIssue: jiraTransitionIssueMock,
}));
vi.mock("../orchestration/revision.js", () => ({
  handleGithubRevisionWebhook: handleGithubRevisionWebhookMock,
}));

vi.mock("../config/env.js", () => ({
  env: {
    GITHUB_TOKEN: "global-gh-token",
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
    jiraGetIssueMock.mockReset();
    jiraGetTransitionsMock.mockReset();
    jiraTransitionIssueMock.mockReset();
    handleGithubRevisionWebhookMock.mockReset();
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

  it("routes signed pull_request_review events to revision orchestration", async () => {
    handleGithubRevisionWebhookMock.mockResolvedValue({
      action: "spawned",
      mode: "auto_review_submitted",
      ticketKey: "HYDI-44",
      runId: "run_123",
      actionItemCount: 1,
    });
    const body = JSON.stringify({
      action: "submitted",
      pull_request: {
        number: 44,
        html_url: "https://github.com/org/repo/pull/44",
        head: { ref: "agent/HYDI-44-pr-revision-webhook" },
      },
      review: { id: 123, state: "COMMENTED", body: "[REV-001] fix" },
      repository: { owner: { login: "org" }, name: "repo" },
    });
    const { webhookRouter } = await import("./jira.js");

    const res = await webhookRouter.request("http://localhost/github", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "pull_request_review",
        "x-hub-signature-256": makeGithubSignature(body),
      },
    });

    expect(res.status).toBe(200);
    expect(handleGithubRevisionWebhookMock).toHaveBeenCalledWith({
      event: "pull_request_review",
      payload: JSON.parse(body),
    });
    expect(await res.json()).toMatchObject({
      action: "spawned",
      mode: "auto_review_submitted",
      ticketKey: "HYDI-44",
    });
  });

  it("routes signed issue_comment events to revision orchestration", async () => {
    handleGithubRevisionWebhookMock.mockResolvedValue({
      action: "ignored",
      reason: "issue comment has no /revise command",
    });
    const body = JSON.stringify({
      action: "created",
      issue: { number: 44, pull_request: { html_url: "https://github.com/org/repo/pull/44" } },
      comment: { body: "thanks!" },
      repository: { owner: { login: "org" }, name: "repo" },
    });
    const { webhookRouter } = await import("./jira.js");

    const res = await webhookRouter.request("http://localhost/github", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "issue_comment",
        "x-hub-signature-256": makeGithubSignature(body),
      },
    });

    expect(res.status).toBe(200);
    expect(handleGithubRevisionWebhookMock).toHaveBeenCalledWith({
      event: "issue_comment",
      payload: JSON.parse(body),
    });
    expect(await res.json()).toEqual({
      action: "ignored",
      reason: "issue comment has no /revise command",
    });
  });

  it("routes signed pull_request_review_comment events to revision orchestration", async () => {
    handleGithubRevisionWebhookMock.mockResolvedValue({
      action: "ignored",
      reason: "review comment events are ignored; wait for submitted review",
    });
    const body = JSON.stringify({
      action: "created",
      pull_request: { number: 44, html_url: "https://github.com/org/repo/pull/44" },
      comment: { id: 555, body: "inline note" },
      repository: { owner: { login: "org" }, name: "repo" },
    });
    const { webhookRouter } = await import("./jira.js");

    const res = await webhookRouter.request("http://localhost/github", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "pull_request_review_comment",
        "x-hub-signature-256": makeGithubSignature(body),
      },
    });

    expect(res.status).toBe(200);
    expect(handleGithubRevisionWebhookMock).toHaveBeenCalledWith({
      event: "pull_request_review_comment",
      payload: JSON.parse(body),
    });
    expect(await res.json()).toEqual({
      action: "ignored",
      reason: "review comment events are ignored; wait for submitted review",
    });
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

  it("transitions tracked Jira issues to Done and unblocks dependents on closed+merged PR events", async () => {
    const prUrl = "https://github.com/org/repo/pull/222";
    getRunsByPrUrlMock.mockResolvedValue([
      makeDispatchRun({
        ticket_key: "HYDI-65",
        project_key: "HYDI",
        pr_url: prUrl,
      }),
    ]);
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "in-progress" } } },
    });
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "300", name: "Done" }],
    });
    getRunsBlockedByMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-66", blocked_by: ["HYDI-65"] }),
    ]);
    removeBlockerMock.mockResolvedValue(makeDispatchRun({ ticket_key: "HYDI-66" }));

    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        html_url: prUrl,
        state: "closed",
        draft: false,
        merged: true,
        merged_at: "2026-06-12T00:00:00.000Z",
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
    expect(updateRunStatusMock).toHaveBeenCalledWith("HYDI-65", {
      pr_display_state: "merged",
    });
    expect(jiraTransitionIssueMock).toHaveBeenCalledWith("HYDI-65", "300");
    expect(removeBlockerMock).toHaveBeenCalledWith("HYDI-66", "HYDI-65");
  });
});
