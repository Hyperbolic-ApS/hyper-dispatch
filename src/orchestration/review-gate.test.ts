import { describe, it, expect } from "vitest";
import { decideReviewAction } from "./review-gate.js";

const base = { reviewState: "changes_requested", actionableCount: 1, round: 0, budget: 2, prState: "open", needsHuman: false };

describe("decideReviewAction", () => {
  it("revises when changes requested, under budget, actionable", () => {
    expect(decideReviewAction(base)).toEqual({ action: "revise" });
  });
  it("terminates on approval", () => {
    expect(decideReviewAction({ ...base, reviewState: "approved" })).toEqual({ action: "approve_terminal" });
  });
  it("ignores commented reviews", () => {
    expect(decideReviewAction({ ...base, reviewState: "commented" }).action).toBe("ignore");
  });
  it("escalates when budget spent", () => {
    expect(decideReviewAction({ ...base, round: 2 }).action).toBe("escalate_human");
  });
  it("ignores closed/merged PRs", () => {
    expect(decideReviewAction({ ...base, prState: "merged" }).action).toBe("ignore");
  });
  it("ignores once already flagged for human", () => {
    expect(decideReviewAction({ ...base, needsHuman: true }).action).toBe("ignore");
  });
  it("ignores changes_requested with no actionable findings", () => {
    expect(decideReviewAction({ ...base, actionableCount: 0 }).action).toBe("ignore");
  });
});
