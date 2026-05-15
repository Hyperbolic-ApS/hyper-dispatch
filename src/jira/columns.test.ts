import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_JIRA_COLUMN_MAPPINGS,
  jiraNamesEqual,
  resolveJiraColumnMappings,
} from "./columns.js";
let fetchSpy: any;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

describe("jiraNamesEqual", () => {
  it("returns true when values match case-insensitively with surrounding whitespace", () => {
    expect(jiraNamesEqual("  In Progress ", "in progress")).toBe(true);
  });

  it("returns true for case-insensitive match", () => {
    expect(jiraNamesEqual("Done", "done")).toBe(true);
  });

  it("returns false for full mismatch", () => {
    expect(jiraNamesEqual("To Do", "In Review")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(jiraNamesEqual("", "")).toBe(true);
  });
});

describe("resolveJiraColumnMappings", () => {
  it("returns defaults when all mappings are undefined", () => {
    expect(resolveJiraColumnMappings()).toEqual(DEFAULT_JIRA_COLUMN_MAPPINGS);
  });

  it("preserves provided partial overrides", () => {
    expect(
      resolveJiraColumnMappings({
        toDo: "Ready",
        inReview: "QA Review",
      })
    ).toEqual({
      ...DEFAULT_JIRA_COLUMN_MAPPINGS,
      toDo: "Ready",
      inReview: "QA Review",
    });
  });

  it("uses defaults when overrides are whitespace-only", () => {
    expect(
      resolveJiraColumnMappings({
        backlog: "   ",
        done: "\t",
      })
    ).toEqual(DEFAULT_JIRA_COLUMN_MAPPINGS);
  });

  it("uses defaults when overrides are empty strings", () => {
    expect(
      resolveJiraColumnMappings({
        backlog: "",
        toDo: "",
        inProgress: "",
        inReview: "",
        done: "",
      })
    ).toEqual(DEFAULT_JIRA_COLUMN_MAPPINGS);
  });
});
