import { describe, expect, it } from "vitest";
import { jiraNamesEqual } from "./columns.js";

describe("jiraNamesEqual", () => {
  it("returns true when values match case-insensitively with surrounding whitespace", () => {
    expect(jiraNamesEqual("  In Progress ", "in progress")).toBe(true);
  });
});
