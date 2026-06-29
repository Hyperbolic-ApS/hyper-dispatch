import { describe, expect, it } from "vitest";
import { renderLedger } from "./ledger.js";

describe("renderLedger", () => {
  it("renders a ledger table with the contract markers", () => {
    const out = renderLedger([
      {
        finding_key: "abc1234",
        severity: "Major",
        title: "x",
        status: "open",
        disposition: null,
        first_seen_round: 1,
        last_seen_round: 2,
      },
    ] as any);
    expect(out).toContain("<!-- review-ledger:start -->");
    expect(out).toContain("<!-- review-ledger:end -->");
    expect(out).toMatch(/Major/);
  });

  it("renders a placeholder row when there are no findings", () => {
    const out = renderLedger([]);
    expect(out).toContain("<!-- review-ledger:start -->");
    expect(out).toContain("<!-- review-ledger:end -->");
    expect(out).toContain("_none_");
  });

  it("slices finding_key to 7 characters", () => {
    const out = renderLedger([
      {
        finding_key: "abcdefghijk",
        severity: "Blocking",
        title: "test",
        status: "open",
        disposition: null,
        first_seen_round: 1,
        last_seen_round: 1,
      },
    ] as any);
    expect(out).toContain("abcdefg");
    expect(out).not.toContain("abcdefghijk");
  });
});
