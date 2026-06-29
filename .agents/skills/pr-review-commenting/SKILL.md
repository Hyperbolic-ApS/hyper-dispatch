---
name: pr-review-commenting
description: "Publish PR review feedback as inline GitHub review comments where possible, with a thin summary review body. Uses the recommended GitHub state from pr-technical-review (APPROVE / REQUEST_CHANGES / COMMENT)."
---

# PR Review Commenting

## Overview

Convert a completed technical review (from `pr-technical-review`) into a GitHub PR Review:
- **Inline comments** for Critical/Important findings whose line appears in the diff, each starting
  with the machine-readable marker so the dispatch harness (`findings.ts`) can parse them.
- **Thin review body** containing only: verdict, risk, scope, and a pointer to the sticky ledger
  comment the harness maintains (`<!-- review-ledger:start -->`). Do NOT repaste the full
  rubric, architecture assessment, or finding list in the review body each round.

The review is human-readable for engineers and agent-actionable for the dispatch harness.

## Dependency

- Depends on `pr-technical-review`.
- If no completed review artifact is provided, run `pr-technical-review` first.

## Inputs

- PR number or URL
- Base and head refs (or SHAs) when needed
- Requirements source (ticket, plan, or acceptance criteria) when needed
- Optional: completed review artifact in the `pr-technical-review` output format

## Verdict → GitHub review event mapping

Use the recommended GitHub review state from `pr-technical-review` directly:

| Technical-review verdict | GitHub `event` field |
|--------------------------|----------------------|
| `APPROVE`                | `"APPROVE"`          |
| `REQUEST_CHANGES`        | `"REQUEST_CHANGES"`  |
| `COMMENT`                | `"COMMENT"`          |

Never hardcode `"COMMENT"` when the technical review recommends `APPROVE` or `REQUEST_CHANGES`.

## Review Body Content (thin)

The top-level review body must contain ONLY:
1. Verdict line (APPROVED / CHANGES REQUESTED / COMMENT) + risk + scope
2. A pointer: "See the [review ledger comment](#) for finding status."
3. Fallback findings only — findings that could not be placed inline (line not in diff), listed
   with their full marker so the harness can parse them.

Do NOT include: architecture assessment, strengths, full rubric, third-party verification table,
or the complete action list in the review body. Those are verbose and cause review-body churn.

## Inline Comment Content

Each inline comment body MUST START with the machine-readable marker line (so `findings.ts`
can parse the key, severity, and path), then the human-readable text:

```
<!-- finding key="<sha1>" severity="Critical|Important" path="<repo/rel/path>" -->
**Critical — <title>**

**Problem:** <what is wrong>
**Impact:** <why it matters>
**Required fix:** <what must change>
**Acceptance check:** <test/assertion/observable condition>
```

Minor findings do NOT get a marker. If Minor items need mentioning, include them under a
"Non-blocking notes" section in the review body with no marker.

## Review Body Template

```md
## PR Review

**Verdict:** APPROVED | CHANGES REQUESTED | COMMENT
**Risk:** Low | Medium | High
**Scope:** `<base..head>`

See the [review ledger comment] for finding status (<!-- review-ledger:start -->).

### Unmapped Findings
_(findings whose lines are not in the diff — inline comment not possible)_

<!-- finding key="<sha1>" severity="Critical" path="<repo/rel/path>" -->
**Critical — <title>**
- Location: `path/file.ext:line`
- Problem: ...
- Required fix: ...
- Acceptance check: ...

### Non-blocking notes
_(Minor / advisory — no action required)_
- ...
```

## Inline Comment Template

```md
<!-- finding key="<sha1>" severity="Critical|Important" path="<repo/rel/path>" -->
**Critical — <title>**

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

4. Classify each Critical/Important finding from the review artifact:
   - **Inline**: `location` path exists in `/tmp/diff_lines.json` AND the line number is in the valid set → inline comment with marker
   - **Fallback**: line not in the diff → include in review body under "Unmapped Findings" with the marker so the harness can still parse it

5. Build the review JSON at `/tmp/pr_review.json` using Python (do NOT construct via shell string concatenation — multiline strings and special characters will break):
   ```json
   {
     "event": "APPROVE",
     "body": "<thin review body markdown — verdict + ledger pointer + any unmapped findings>",
     "comments": [
       {
         "path": "src/foo.ts",
         "line": 42,
         "side": "RIGHT",
         "body": "<!-- finding key=\"<sha1>\" severity=\"Critical\" path=\"src/foo.ts\" -->\n**Critical — <title>**\n\n**Problem:** ...\n**Impact:** ...\n**Required fix:** ...\n**Acceptance check:** ..."
       }
     ]
   }
   ```
   Set `"event"` to `"APPROVE"`, `"REQUEST_CHANGES"`, or `"COMMENT"` per the technical-review verdict.

6. Post the review as a fresh GitHub review submission (review states are immutable after submission,
   so each round is a new review object — do NOT edit previous reviews):
   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews \
     -X POST --input /tmp/pr_review.json
   ```
   The dispatch harness dismisses superseded `REQUEST_CHANGES` reviews automatically.
   Do NOT repost inline findings that were already resolved — reply on and resolve those threads
   instead.

7. Confirm the posted review URL in output.

## Quality Bar

- Every Critical/Important finding must have: a location, the machine-readable marker, and an acceptance check.
- No `Critical` issue unless there is a concrete merge-blocking risk.
- All code-level findings must be attempted as inline comments first; only fall back to the review body if the line is not in the diff.
- Review body must be thin — verdict + ledger pointer + unmapped findings only; do not repaste the full assessment each round.
- Minor findings: no markers, no action list entries.
