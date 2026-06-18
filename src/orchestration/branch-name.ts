const MAX_DESCRIPTOR_SEGMENTS = 3;

export function buildBranchSummarySlug(summary: string | null | undefined): string {
  if (!summary) return "";
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .split("-")
    .filter(Boolean)
    .slice(0, MAX_DESCRIPTOR_SEGMENTS)
    .join("-");
}

export function buildAgentBranchName(
  ticketKey: string,
  summary: string | null | undefined
): string {
  const summarySlug = buildBranchSummarySlug(summary);
  // Contract: if summary slug is empty after normalization, use ticket-only branch.
  // This fallback must stay aligned with worker branch creation instructions.
  return summarySlug ? `agent/${ticketKey}-${summarySlug}` : `agent/${ticketKey}`;
}
