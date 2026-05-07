import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatchRun } from "../test/fixtures.js";
const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock("./connection.js", () => ({
  sql: mockSql,
}));

import { removeBlocker } from "./queries.js";

describe("removeBlocker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps blocked_cycle status untouched in SQL transition case expression", async () => {
    const updatedRun = makeDispatchRun({
      ticket_key: "HYDI-55",
      status: "blocked_cycle",
      blocked_by: [],
    });
    mockSql.mockResolvedValue([updatedRun]);

    const result = await removeBlocker("HYDI-55", "HYDI-10");

    expect(result).toEqual(updatedRun);
    expect(mockSql).toHaveBeenCalledTimes(1);

    const [strings, ...values] = mockSql.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sqlText = strings.join(" ");

    expect(sqlText).toContain("WHEN status = 'blocked'");
    expect(sqlText).toContain("THEN 'queued'");
    expect(values).toEqual(expect.arrayContaining(["HYDI-10", "HYDI-55"]));
  });

  it("returns null when no run is updated", async () => {
    mockSql.mockResolvedValue([]);

    const result = await removeBlocker("HYDI-99", "HYDI-10");

    expect(result).toBeNull();
  });
});
