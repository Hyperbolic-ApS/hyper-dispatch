---
name: pr-review-commenting
description: "Publish PR review feedback as a single top-level PR comment that is human-readable and agent-actionable."
---

# PR Review Commenting

## Overview

Convert a completed technical review (from `pr-technical-review`) into a high-signal PR comment.

The comment must be:
- **Human-readable** for engineers and reviewers.
- **Agent-actionable** for a follow-up implementation agent.

## Dependency

- Depends on `pr-technical-review`.
- If no completed review artifact is provided, run `pr-technical-review` first and use its output as the source of truth.

## Inputs

- PR number or URL
- Base and head refs (or SHAs) when needed
- Requirements source (ticket, plan, or acceptance criteria) when needed
- Optional: completed review artifact in the `pr-technical-review` output format

## Comment Requirements

1. One top-level PR comment containing:
   - concise summary and verdict
   - severity-grouped findings
   - architecture assessment
   - third-party contract verification summary (when relevant)
   - explicit agent action list
2. Every blocking/non-blocking finding must include:
   - stable ID (`REV-###`)
   - precise file location
   - required change
   - acceptance check
3. Tone:
   - strict and direct on risk
   - pragmatic on lower-priority issues
   - no vague feedback

## Suggested Comment Template

```md
## PR Review — Principal Engineer Assessment

**Verdict:** Ready | Ready with fixes | Not ready
**Risk:** Low | Medium | High
**Scope:** `<base..head>`
**Requirements:** `<source>`

### Strengths
- ...

### Findings
#### Critical (must fix before merge)
- [REV-001] ...
  - Location: ...
  - Problem: ...
  - Impact: ...
  - Required fix: ...
  - Acceptance check: ...

#### Important (should fix before merge)
- [REV-002] ...

#### Minor (non-blocking)
- [REV-003] ...

### Architecture Assessment
- Vertical slice quality: ...
- Deep module quality: ...
- Testability/reasoning quality: ...

### Third-Party Contract Verification
- Service/version/endpoint checks and mismatches (if any)

### Action Plan For Implementing Agent
1. [REV-001] ...
2. [REV-002] ...

```yaml
actions:
  - id: REV-001
    severity: critical
    location: path/file.ext:line
    change_required: ...
    acceptance_check: ...
```
```

## Posting Procedure

1. Ensure review artifact exists:
   - If provided, validate it matches `pr-technical-review` output format.
   - If missing, execute `pr-technical-review` for the same PR context and use that artifact.
2. Build the comment body exactly once from the review artifact.
3. Write the full comment body to a fixed file path in a **single shell command**:
   ```bash
   cat > /tmp/pr_review_comment.md << 'COMMENT_EOF'
   <full comment body here>
   COMMENT_EOF
   ```
   Do NOT store the path in a shell variable and reference it in a later shell call — each tool call runs in a separate shell and variables do not persist between calls.
4. Post or update using the file directly:
   - **Create** (no existing comment):
     ```bash
     jq -n --rawfile body /tmp/pr_review_comment.md '{"body": $body}' \
       | gh api repos/{owner}/{repo}/issues/{pr_number}/comments -X POST --input -
     ```
   - **Update** (existing comment found):
     ```bash
     jq -n --rawfile body /tmp/pr_review_comment.md '{"body": $body}' \
       | gh api repos/{owner}/{repo}/issues/comments/{comment_id} -X PATCH --input -
     ```
   Using `--input -` with piped JSON avoids shell variable expansion and correctly handles multiline content and special characters.
5. Confirm the posted/updated comment URL in output.

## Quality Bar

- No finding without a location and an acceptance check.
- No `Critical` issue unless there is a concrete merge-blocking risk.
- No omission of integration-contract mismatches when external APIs are touched.
- Keep the comment concise but complete enough for implementation without back-and-forth.
