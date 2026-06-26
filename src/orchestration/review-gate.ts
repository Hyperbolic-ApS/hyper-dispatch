export interface GateInput {
  reviewState: string;
  actionableCount: number;
  round: number;
  budget: number;
  prState: string | null;
  needsHuman: boolean;
}

export type GateDecision =
  | { action: "revise" }
  | { action: "approve_terminal" }
  | { action: "escalate_human"; reason: string }
  | { action: "ignore"; reason: string };

export function decideReviewAction(i: GateInput): GateDecision {
  if (i.prState === "merged" || i.prState === "closed") return { action: "ignore", reason: "PR is merged/closed" };
  if (i.needsHuman) return { action: "ignore", reason: "PR already escalated to human" };
  const state = i.reviewState.toLowerCase();
  if (state === "approved") return { action: "approve_terminal" };
  if (state !== "changes_requested") return { action: "ignore", reason: `review state ${state} is advisory` };
  if (i.actionableCount === 0) return { action: "ignore", reason: "no actionable (Major+) findings" };
  if (i.round >= i.budget) return { action: "escalate_human", reason: `revision budget (${i.budget}) exhausted` };
  return { action: "revise" };
}
