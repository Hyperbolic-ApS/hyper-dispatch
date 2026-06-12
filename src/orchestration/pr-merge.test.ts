import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatchRun, makeProjectConfig } from "../test/fixtures.js";

const {
  getProjectConfigMock,
  getRunsBlockedByMock,
  removeBlockerMock,
  jiraGetIssueMock,
  jiraGetTransitionsMock,
  jiraTransitionIssueMock,
} = vi.hoisted(() => ({
  getProjectConfigMock: vi.fn(),
  getRunsBlockedByMock: vi.fn(),
  removeBlockerMock: vi.fn(),
  jiraGetIssueMock: vi.fn(),
  jiraGetTransitionsMock: vi.fn(),
  jiraTransitionIssueMock: vi.fn(),
}));

vi.mock("../db/queries.js", () => ({
  getProjectConfig: getProjectConfigMock,
  getRunsBlockedBy: getRunsBlockedByMock,
  removeBlocker: removeBlockerMock,
}));

vi.mock("../jira/client.js", () => ({
  getIssue: jiraGetIssueMock,
  getTransitions: jiraGetTransitionsMock,
  transitionIssue: jiraTransitionIssueMock,
}));

async function importPrMerge() {
  return import("./pr-merge.js");
}

let fetchSpy: any;
let warnSpy: any;
let logSpy: any;

beforeEach(() => {
  vi.resetModules();
  fetchSpy = vi.spyOn(globalThis, "fetch");
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  getProjectConfigMock.mockReset();
  getRunsBlockedByMock.mockReset();
  removeBlockerMock.mockReset();
  jiraGetIssueMock.mockReset();
  jiraGetTransitionsMock.mockReset();
  jiraTransitionIssueMock.mockReset();
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe("transitionMergedPrToDone", () => {
  it("still unblocks dependents when Jira issue is already done", async () => {
    const { transitionMergedPrToDone } = await importPrMerge();
    const run = makeDispatchRun({
      ticket_key: "HYDI-65",
      project_key: "HYDI",
      pr_url: "https://github.com/org/repo/pull/65",
    });

    jiraGetIssueMock.mockResolvedValue({
      fields: { status: { statusCategory: { key: "done" } } },
    });
    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    getRunsBlockedByMock.mockResolvedValue([
      makeDispatchRun({ ticket_key: "HYDI-66", blocked_by: ["HYDI-65"] }),
    ]);
    removeBlockerMock.mockResolvedValue(makeDispatchRun({ ticket_key: "HYDI-66" }));

    await transitionMergedPrToDone(run, { logPrefix: "[monitor]" });

    expect(jiraGetTransitionsMock).not.toHaveBeenCalled();
    expect(jiraTransitionIssueMock).not.toHaveBeenCalled();
    expect(getRunsBlockedByMock).toHaveBeenCalledWith("HYDI-65");
    expect(removeBlockerMock).toHaveBeenCalledWith("HYDI-66", "HYDI-65");
  });

  it("allows a later retry to recover dependent unblocking after a prior unblocking failure", async () => {
    const { transitionMergedPrToDone } = await importPrMerge();
    const run = makeDispatchRun({
      ticket_key: "HYDI-65",
      project_key: "HYDI",
      pr_url: "https://github.com/org/repo/pull/65",
    });

    getProjectConfigMock.mockResolvedValue(makeProjectConfig());
    jiraGetIssueMock
      .mockResolvedValueOnce({
        fields: { status: { statusCategory: { key: "in-progress" } } },
      })
      .mockResolvedValueOnce({
        fields: { status: { statusCategory: { key: "done" } } },
      });
    jiraGetTransitionsMock.mockResolvedValue({
      transitions: [{ id: "200", name: "Done" }],
    });

    getRunsBlockedByMock
      .mockRejectedValueOnce(new Error("temporary DB failure"))
      .mockResolvedValueOnce([
        makeDispatchRun({ ticket_key: "HYDI-66", blocked_by: ["HYDI-65"] }),
      ]);
    removeBlockerMock.mockResolvedValue(makeDispatchRun({ ticket_key: "HYDI-66" }));

    await transitionMergedPrToDone(run, { logPrefix: "[monitor]" });
    await transitionMergedPrToDone(run, { logPrefix: "[monitor]" });

    expect(jiraTransitionIssueMock).toHaveBeenCalledTimes(1);
    expect(getRunsBlockedByMock).toHaveBeenCalledTimes(2);
    expect(removeBlockerMock).toHaveBeenCalledWith("HYDI-66", "HYDI-65");
  });
});
