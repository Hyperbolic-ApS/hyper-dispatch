# Reviewer skill changes — apply at the hosted skill source

> **Action required by a human.** The reviewer is the **hosted Oz skill
> `pr-review-commenting`** (referenced by `.github/workflows/oz-pr-review-commenting.yml`
> as `skill: pr-review-commenting`). Its prompt is **not in this repository** — it lives
> in the Warp/Oz skills registry. The two verbatim blocks below must be added to that
> skill's prompt at its source. They implement the reviewer half of
> [`review-revise-contract.md`](./review-revise-contract.md).
>
> Until applied, the harness still degrades safely: the budget cap and
> `approved`-terminates gating work regardless, and findings without the new markers
> are treated as actionable (legacy back-compat). But the terminal `APPROVE` signal,
> severity gating, stable IDs, and YAGNI discipline only take full effect once these
> blocks are live in the hosted skill.

## Block 1 — verdict + severity rules (add verbatim)

```
Submit your review with an explicit GitHub review state:
- APPROVE when zero Blocking/Major findings remain. You MUST approve here even
  if Minor/Nit nits exist — "I could still find nits" is NOT grounds to withhold.
- REQUEST_CHANGES when ≥1 Blocking/Major finding exists.
- COMMENT for advisory-only passes.
Classify every finding as Blocking | Major | Minor | Nit. Only Blocking/Major
are actionable. Tag each actionable finding with EXACTLY this marker on its own
line, then the title:
<!-- finding key="<sha1(lower(path)+':'+slug(title))>" severity="Major" path="<repo/rel/path>" -->
Reuse the SAME key for a finding that persists across rounds — never renumber.
List Minor/Nit under a "## Non-blocking" heading with NO marker.
Keep the review BODY thin: the verdict line + "See the ledger comment for status."
```

## Block 2 — YAGNI / scope guard (add verbatim)

```
Scope discipline (binding):
- Review against the ticket's acceptance criteria (fetch via jira-view <KEY>).
- Do NOT suggest adding features, hardening, abstractions, or "do it properly"
  beyond that scope. Before requesting something be added, confirm it is
  actually used/needed in this PR.
- Out-of-scope observations go under "## Future work (non-blocking)" — never as
  an actionable finding. Do not re-raise items already listed as deferred in the
  ledger comment.
- If a finding concerns code a prior revision added in response to YOUR earlier
  feedback, either confirm it is resolved or state your prior suggestion was
  wrong. Do not raise a renamed variant of the same point.
```

## Validation (after applying at the skill source)

Open a tiny throwaway PR and confirm the review:
1. submits a real GitHub state (APPROVE / REQUEST_CHANGES / COMMENT),
2. emits the HTML-comment markers with stable `finding_key`s,
3. puts nits under `## Non-blocking` (no markers),
4. APPROVES when only Minor/Nit remain.

The marker `finding_key` the reviewer emits must match what the harness parses
(`src/orchestration/findings.ts`) and stores (`review_findings`).
