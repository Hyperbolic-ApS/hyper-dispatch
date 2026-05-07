---
name: pr-technical-review
description: "Review a PR with a strict-but-pragmatic principal engineer lens. Produces a human-readable and agent-actionable review artifact with severity, rationale, and concrete fixes."
---

# PR Technical Review

## Overview

Review pull requests for production readiness with high technical standards and pragmatic severity calibration.

This skill focuses on the technical review itself. It does NOT post to GitHub. Use `pr-review-commenting` to publish the result.

## Review Philosophy

- **Strict on correctness and risk**: bugs, data integrity, security, reliability, and contract breaks are non-negotiable.
- **Pragmatic on trade-offs**: avoid blocking for style-only preferences or speculative refactors.
- **Architecture preferences**:
  - Prefer **vertical slices** over horizontal layering that spreads a single feature across many disconnected files.
  - Prefer **deep modules** with slim, stable interfaces and rich, encapsulated implementation internals.
  - Prefer changes that are **testable and reasoned about as a coherent whole**.

## Required Inputs

- PR number or URL
- Base and head refs (or SHAs)
- Requirements source (ticket, plan, or acceptance criteria)

## Workflow

1. **Load PR context**
   - Title, description, linked ticket/spec, changed files, commit range.
2. **Inspect the diff**
   - Understand behavior changes before judging implementation details.
3. **Check requirements alignment**
   - Confirm what was requested vs what was implemented.
4. **Evaluate architecture**
   - Is the change a coherent vertical slice?
   - Are module boundaries clean?
   - Are interfaces slim while internals remain deep and cohesive?
5. **Evaluate quality and safety**
   - Error handling, edge cases, rollback/failure behavior, observability.
6. **Evaluate tests**
   - Correctness-focused tests, not just superficial coverage.
   - New behavior has targeted tests.
7. **Validate third-party integrations (mandatory when touched)**
   - Identify each changed external API call.
   - For cloud/SaaS platforms, assume the **latest API version** unless the repository explicitly pins a version.
   - Confirm the **target service version** used by this codebase (or latest when unpinned as above).
   - Never validate from memory.
   - Documentation sources must be used in this order:
     1. Ref MCP
     2. Exo MCP
     3. Internet search (prefer vendor-owned official documentation)
   - Verify endpoint path, method, auth, request fields, response shape, pagination, limits, and error model against official docs for that exact version.
   - Flag any mismatch as at least `Important`, `Critical` if it can break runtime behavior or data correctness.
8. **Classify findings by severity**
   - `Critical`: must fix before merge (correctness/security/data-loss/outage risk/contract break).
   - `Important`: should fix before merge (missing safeguards, significant test gaps, brittle design likely to fail).
   - `Minor`: non-blocking improvements (clarity, maintainability, low-risk polish).
9. **Produce structured review artifact**
   - Must be readable by humans and directly actionable by an implementing agent.

## Output Format

Use this format exactly so `pr-review-commenting` can publish it without reinterpretation.

### Review Summary

- Verdict: `Ready` | `Ready with fixes` | `Not ready`
- Scope reviewed: `<base..head>`
- Requirements checked against: `<source>`
- Overall risk: `Low` | `Medium` | `High`

### Strengths

- Concise bullets of what was done well.

### Findings

#### Critical
- `[REV-###] <title>`
  - Location: `path/file.ext:start[-end]`
  - Problem: `<what is wrong>`
  - Impact: `<why it matters>`
  - Required fix: `<what must change>`
  - Acceptance check: `<test/assertion/observable condition>`

#### Important
- Same structure as above.

#### Minor
- Same structure as above (can be shorter).

### Architecture Assessment

- Vertical slice quality: `<Strong | Mixed | Weak>` with brief justification
- Deep module quality: `<Strong | Mixed | Weak>` with brief justification
- Testability/reasoning quality: `<Strong | Mixed | Weak>` with brief justification

### Third-Party Contract Verification

For each touched integration:
- Service: `<name>`
- Target version: `<version>`
- Endpoints checked: `<list>`
- Status: `Match` | `Mismatch`
- Notes: `<exact mismatch or confirmation>`

### Agent Action List

```yaml
actions:
  - id: REV-001
    severity: critical|important|minor
    location: path/file.ext:line
    title: Short action title
    change_required: Specific implementation instruction
    acceptance_check: Concrete verification step
```

## Guardrails

- Do not inflate severity for preference-only nits.
- Do not approve if correctness or integration contracts are uncertain.
- Do not request broad refactors outside PR scope unless they are required to prevent concrete risk.
- Be explicit, file-referenced, and test-oriented.
