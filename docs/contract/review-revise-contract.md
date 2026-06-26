# Review / Revise Contract

This contract is binding for THREE actors: the `pr-review-commenting` reviewer
skill, the dispatch reviser prompt (`buildPrompt`), and the dispatch harness
(`review-gate.ts`). Changing any rule here requires updating all three.

## Severity
`Blocking` > `Major` > `Minor` > `Nit`.
- **Actionable** = `Blocking` or `Major`. Only these may carry action-item
  markers and only these can trigger an auto-revision.
- `Minor` / `Nit` are advisory-only: list them under a non-blocking heading,
  NEVER with an action-item marker.

## Action-item marker format (machine-readable, one per actionable finding)
`<!-- finding key="<sha1>" severity="Major|Blocking" path="<repo/rel/path>" -->`
followed by a human-readable title line. The reviewer computes:
`key = sha1(lower(path) + ":" + slug(ruleOrTitle))`.
Stable across rounds — do NOT renumber. A finding that persists keeps its key.

## Verdict (GitHub review state)
- `APPROVED` — zero actionable findings remain. The reviewer MUST approve here;
  remaining `Minor`/`Nit` items do NOT justify withholding approval.
- `CHANGES_REQUESTED` — ≥1 actionable finding.
- `COMMENTED` — advisory only (never triggers auto-revision).
Verdict bodies are THIN: the verdict line + a link to the sticky ledger comment.
Superseded `CHANGES_REQUESTED` reviews are dismissed by the harness, not edited.
Inline findings are resolved (reply + resolve thread) when fixed, never reposted.

## YAGNI / scope (reviewer AND reviser)
Do not suggest or add features, hardening, or abstractions beyond the PR's
stated scope (ticket acceptance criteria). Before asking for something to be
"done properly," verify it is actually used/needed. Out-of-scope observations
go under a non-blocking "Future work" heading, never as an actionable finding.

## Reviser triage (per finding)
fix (correct + in-scope + actionable) | defer (out-of-scope/speculative →
reply on thread "out of scope for this slice", no code) | reject (wrong for
this codebase → reply with technical reasoning). No performative agreement.

## Sticky ledger comment
Single PR comment, upserted each round, delimited by:
`<!-- review-ledger:start -->` ... `<!-- review-ledger:end -->`
Projection of the authoritative `review_findings` DB rows. Columns:
key (short) | severity | status | first round | last round | disposition.
