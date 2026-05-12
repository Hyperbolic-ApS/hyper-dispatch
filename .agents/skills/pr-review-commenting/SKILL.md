---
name: pr-review-commenting
description: "Publish PR review feedback as inline GitHub review comments where possible, with a summary review body for the rest."
---

# PR Review Commenting

## Overview

Convert a completed technical review (from `pr-technical-review`) into a GitHub PR Review:
- **Inline comments** for code-level findings whose line appears in the diff
- **Review body** for summary, architecture assessment, third-party verification, and findings that do not map to diff lines

The review must be human-readable for engineers and agent-actionable for a follow-up implementing agent.

## Dependency

- Depends on `pr-technical-review`.
- If no completed review artifact is provided, run `pr-technical-review` first.

## Inputs

- PR number or URL
- Base and head refs (or SHAs) when needed
- Requirements source (ticket, plan, or acceptance criteria) when needed
- Optional: completed review artifact in the `pr-technical-review` output format

## Review Body Content

The top-level review body must contain:
1. Verdict, risk, scope, requirements source
2. Strengths
3. Architecture assessment
4. Third-party contract verification summary (when relevant)
5. Fallback findings (findings that could not be placed inline, with full location reference)
6. Complete agent action list (all REV-### items, inline or not)

## Inline Comment Content

Each inline comment must contain:
- Severity label and stable ID (`[REV-001] Critical — <title>`)
- Problem
- Impact
- Required fix
- Acceptance check

## Review Body Template

```md
## PR Review — Principal Engineer Assessment

**Verdict:** Ready | Ready with fixes | Not ready
**Risk:** Low | Medium | High
**Scope:** `<base..head>`
**Requirements:** `<source>`

### Strengths
- ...

### Architecture Assessment
- Vertical slice quality: ...
- Deep module quality: ...
- Testability/reasoning quality: ...

### Third-Party Contract Verification
- Service/version/endpoint checks and mismatches (if any)

### Unmapped Findings
_(findings whose lines are not in the diff — inline comment not possible)_
- [REV-00X] ...
  - Location: `path/file.ext:line`
  - Problem: ...
  - Impact: ...
  - Required fix: ...
  - Acceptance check: ...

### Action Plan For Implementing Agent
1. [REV-001] ...
2. [REV-002] ...

```yaml
actions:
  - id: REV-001
    severity: critical|important|minor
    location: path/file.ext:line
    change_required: ...
    acceptance_check: ...
```
```

## Inline Comment Template

```md
**[REV-001] Critical — <title>**

**Problem:** <what is wrong>
**Impact:** <why it matters>
**Required fix:** <what must change>
**Acceptance check:** <test/assertion/observable condition>
```

## Posting Procedure

1. Ensure review artifact exists. If missing, execute `pr-technical-review` first.

2. Fetch the PR diff:
   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr_number} \
     -H "Accept: application/vnd.github.diff" > /tmp/pr.diff
   ```

3. Parse the diff to build a map of valid RIGHT-side line numbers per file:
   ```bash
   python3 - > /tmp/diff_lines.json << 'EOF'
   import json, re
   def parse(diff):
       valid = {}
       cur = None
       nl = 0
       for line in diff.splitlines():
           if line.startswith('+++ b/'):
               cur = line[6:]
               valid.setdefault(cur, set())
           elif line.startswith('@@ ') and cur:
               m = re.search(r'\+(\d+)', line)
               if m: nl = int(m.group(1)) - 1
           elif cur:
               if line.startswith('-'): pass
               elif line.startswith(('+', ' ')):
                   nl += 1
                   valid[cur].add(nl)
       return {k: sorted(v) for k, v in valid.items()}
   with open('/tmp/pr.diff') as f:
       print(json.dumps(parse(f.read())))
   EOF
   ```

4. Classify each finding from the review artifact:
   - **Inline**: `location` path exists in `/tmp/diff_lines.json` AND the line number is in the valid set → inline comment
   - **Fallback**: architecture/test-gap concerns, or line not in the diff → include in review body under "Unmapped Findings"

5. Build the review JSON at `/tmp/pr_review.json` using Python (do NOT construct via shell string concatenation — multiline strings and special characters will break):
   ```json
   {
     "event": "COMMENT",
     "body": "<review body markdown>",
     "comments": [
       {
         "path": "src/foo.ts",
         "line": 42,
         "side": "RIGHT",
         "body": "**[REV-001] Critical — <title>**\n\n**Problem:** ...\n**Impact:** ...\n**Required fix:** ...\n**Acceptance check:** ..."
       }
     ]
   }
   ```

6. Post the review (each invocation of this skill posts a new review round — do not attempt to edit previous reviews):
   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews \
     -X POST --input /tmp/pr_review.json
   ```

7. Confirm the posted review URL in output.

## Quality Bar

- No finding without a location and an acceptance check.
- No `Critical` issue unless there is a concrete merge-blocking risk.
- All code-level findings must be attempted as inline comments first; only fall back to the review body if the line is not in the diff.
- Review body should be concise — keep it to architecture, summary, and unmapped findings when code-level items are covered inline.
- The agent action list must always be complete in the review body, regardless of whether individual findings are inline.
