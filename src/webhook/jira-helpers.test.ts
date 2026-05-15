import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../jira/client.js", () => ({}));
vi.mock("../db/queries.js", () => ({
  getProjectConfig: vi.fn(),
  getRunsBlockedBy: vi.fn(),
  removeBlocker: vi.fn(),
  upsertDispatchRun: vi.fn(),
}));
vi.mock("../orchestration/dependency-resolver.js", () => ({
  resolveEligibility: vi.fn(),
  detectCycles: vi.fn(),
}));

import { priorityNameToNumber } from "./jira.js";
let fetchSpy: any;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

describe("priorityNameToNumber", () => {
  it("maps known Jira priorities to numeric values", () => {
    expect(priorityNameToNumber("Highest")).toBe(5);
    expect(priorityNameToNumber("High")).toBe(4);
    expect(priorityNameToNumber("Medium")).toBe(3);
    expect(priorityNameToNumber("Low")).toBe(2);
    expect(priorityNameToNumber("Lowest")).toBe(1);
  });

  it("falls back to medium priority for unknown names", () => {
    expect(priorityNameToNumber("Critical-ish")).toBe(3);
  });

  it("falls back to medium priority for null or undefined", () => {
    expect(priorityNameToNumber(null)).toBe(3);
    expect(priorityNameToNumber(undefined)).toBe(3);
  });
});
