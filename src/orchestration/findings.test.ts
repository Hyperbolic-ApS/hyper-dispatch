import { describe, it, expect } from "vitest";
import { parseFindings, actionableFindings } from "./findings.js";

describe("parseFindings", () => {
  it("parses contract markers with stable keys", () => {
    const body = `<!-- finding key="abc123" severity="Major" path="src/a.ts" -->\nFix the thing`;
    const f = parseFindings([body]);
    expect(f).toEqual([{ key: "abc123", severity: "Major", title: "Fix the thing", path: "src/a.ts" }]);
  });

  it("treats legacy REV markers as actionable", () => {
    const f = parseFindings(["[REV-001] do x"]);
    expect(actionableFindings(f)).toHaveLength(1);
  });

  it("drops Minor findings from actionable set", () => {
    const body = `<!-- finding key="k" severity="Minor" path="a.ts" -->\nnit`;
    expect(actionableFindings(parseFindings([body]))).toHaveLength(0);
  });

  // Regression: a global regex's lastIndex must not leak between inputs.
  //
  // The naive implementation gated the legacy fallback with a stateful
  // `MARKER.test(text)` call. `.test()` on a global regex advances
  // `MARKER.lastIndex`, and — critically — `String.prototype.matchAll` copies
  // the regex's *current* lastIndex into its internal matcher. So once the
  // first text's `.test()` leaves lastIndex past the start of the marker,
  // `matchAll()` on the SECOND text begins scanning mid-string and silently
  // skips its marker entirely — the second finding is DROPPED.
  //
  // This test uses two texts that BOTH contain a contract marker (the second's
  // marker starts before the leaked lastIndex). It fails against the naive
  // global-`.test()` code (second marker dropped) and passes once the
  // marker-vs-legacy decision is derived from `matchAll()` results instead.
  it("parses markers in every input regardless of lastIndex from prior inputs", () => {
    const first = `<!-- finding key="abc" severity="Major" path="src/a.ts" -->\nFix the first thing thoroughly`;
    const second = `<!-- finding key="def" severity="Blocking" path="src/b.ts" -->\nFix the second thing`;
    const results = parseFindings([first, second]);

    expect(results).toEqual([
      { key: "abc", severity: "Major", title: "Fix the first thing thoroughly", path: "src/a.ts" },
      { key: "def", severity: "Blocking", title: "Fix the second thing", path: "src/b.ts" },
    ]);
  });
});
