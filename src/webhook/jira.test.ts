import { describe, expect, it, vi } from "vitest";
import { makeDispatchRun, makeProjectConfig } from "../test/fixtures.js";

const getProjectConfigMock = vi.fn();
const getRunsBlockedByMock = vi.fn();
const removeBlockerMock = vi.fn();
const syncTicketInToDoMock = vi.fn();

vi.mock("../db/queries.js", () => ({
  getProjectConfig: getProjectConfigMock,
  getRunsBlockedBy: getRunsBlockedByMock,
  removeBlocker: removeBlockerMock,
}));

vi.mock("../orchestration/ticket-sync.js", () => ({
  syncTicketInToDo: syncTicketInToDoMock,
}));

describe("webhookRouter", () => {
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
});
