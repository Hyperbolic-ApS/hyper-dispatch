#!/usr/bin/env python3
"""Select a review tier based on PR diff analysis.

Reads .github/review-tiers.yml, inspects the PR diff between the merge-base of
BASE_SHA/HEAD_SHA and HEAD_SHA, and writes the chosen tier's model (and metadata)
to $GITHUB_OUTPUT.

No external dependencies — stdlib only.
"""

import os
import re
import subprocess
import sys

# ---------------------------------------------------------------------------
# Minimal YAML parser (handles only the flat structure of review-tiers.yml)
# ---------------------------------------------------------------------------

def parse_config(text):
    """Parse the review-tiers config into {tier_name: {key: value|list}}."""
    config = {}
    tier = None
    list_key = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        # Top-level tier key (no leading whitespace, ends with colon)
        if not line[0].isspace() and line.endswith(":"):
            tier = line[:-1].strip()
            config[tier] = {}
            list_key = None
            continue
        if tier is None:
            continue
        stripped = line.strip()
        # List item under current list_key
        if stripped.startswith("- ") and list_key:
            config[tier].setdefault(list_key, []).append(stripped[2:])
            continue
        # Key: value
        if ":" in stripped:
            k, v = stripped.split(":", 1)
            k, v = k.strip(), v.strip().strip('"')
            if v:
                config[tier][k] = v
                list_key = None
            else:
                list_key = k
    return config

# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------

def run(cmd):
    """Run a command given as a list of arguments. Never uses shell=True."""
    return subprocess.run(cmd, capture_output=True, text=True).stdout.strip()


# Files that should not trigger risk signals (docs, config, assets, CI)
NON_CODE = re.compile(
    r"(\.(md|txt|rst|adoc|csv|svg|png|jpg|gif|ico|lock|toml|yml|yaml|json)$"
    r"|\.github/)", re.I
)
TEST_FILE = re.compile(
    r"(^|/)(__tests__|tests?)(/|$)|(\.|-)(test|spec)\.[^.]+$",
    re.I,
)


def is_test_file(path):
    return bool(TEST_FILE.search(path))


def merge_base(base, head):
    """Return the merge-base for PR-style diffing; fall back to base if unavailable."""
    return run(["git", "merge-base", base, head]) or base


def diff_info(base, head):
    diff_base = merge_base(base, head)
    ref = f"{diff_base}..{head}"
    all_files = [f for f in run(["git", "diff", "--name-only", ref]).splitlines() if f]
    code_files = [f for f in all_files if not NON_CODE.search(f)]
    non_test_code_files = [f for f in code_files if not is_test_file(f)]
    stat = run(["git", "diff", "--shortstat", ref])
    nums = re.findall(r"(\d+)", stat)
    lines = sum(int(n) for n in nums[1:]) if len(nums) > 1 else 0
    # Only fetch diff for non-test code files to avoid false positives in docs
    # and test fixtures/assertions.
    diff_text = ""
    if non_test_code_files and len(non_test_code_files) <= 200:
        diff_text = run(["git", "diff", ref, "--"] + non_test_code_files)
    return {
        "files": code_files,
        "non_test_files": non_test_code_files,
        "all_files": all_files,
        "file_count": len(all_files),
        "lines": lines,
        "diff": diff_text,
        "diff_base": diff_base,
    }

# ---------------------------------------------------------------------------
# Trigger → pattern mapping
# ---------------------------------------------------------------------------

TRIGGERS = {
    # ── escalated ──
    "tests changed": {
        "file": r"test|spec|__tests__|\.test\.|\.spec\.",
    },
    "public API changed": {
        "file": (
            r"(^|/)api/v\d(/|$)"
            r"|(^|/)src/routes/api\.(ts|tsx|js|jsx)$"
            r"|(^|/)routes/api\.(ts|tsx|js|jsx)$"
            r"|(^|/)(openapi|swagger)(\.|/)"
            r"|(^|/).*(openapi|swagger).*\.(ya?ml|json)$"
            r"|\.proto$"
            r"|graphql.*schema|schema\.graphql"
        ),
        "scope": "all_files",
        "exclude_tests": True,
    },
    "database query logic changed": {
        "file": r"query|repository|dao|\.sql$",
        "diff": r"\b(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE)\b",
        "exclude_tests": True,
    },
    "auth-adjacent code changed": {
        "file": r"auth|session|token|oauth|permission|login|credential|identity",
        "exclude_tests": True,
    },
    "ci or automation changes": {
        "file": r"^\.github/(workflows|scripts)/",
        "scope": "all_files",
    },
    # ── high risk ──
    "migrations": {
        "file": r"migrat",
        "exclude_tests": True,
    },
    "permissions": {
        "file": r"permission|rbac|acl|role|policy|guard|authorize",
        "exclude_tests": True,
    },
    "payment or billing logic": {
        "file": r"payment|billing|invoice|subscription|ledger|pricing|charge|stripe",
        "exclude_tests": True,
    },
    "concurrency": {
        "file": r"lock|mutex|semaphore|concurrent|atomic|thread|worker.*(pool|thread|process)|queue.*(process|consum|handl)",
        "diff": r"synchronized|ReentrantLock|Mutex|\.lock\(|atomic|WaitGroup|Semaphore|Promise\.all|asyncio\.gather",
        "exclude_tests": True,
    },
    "event processing": {
        "file": r"event.*(process|handler)|consumer|producer|subscriber|listener|broker",
        "exclude_tests": True,
    },
    "security boundary": {
        "file": r"security|firewall|cors|csp|sanitiz|encrypt|crypto|vault|certificate",
        "exclude_tests": True,
    },
    "data deletion or destructive updates": {
        "diff": r"DELETE\s+FROM|DROP\s+(TABLE|COLUMN|INDEX)|TRUNCATE|\.destroy|\.delete_all|remove_column|drop_column",
    },
    # ── critical ──
    "production incident fix": {
        "branch": r"hotfix/|incident/|fix/prod|emergency/",
        "title": r"hotfix|incident|production.*(fix|patch)|emergency|p0|sev[- ]?[01]",
    },
    "large refactor in critical path": {
        "min_lines": 1000,
        "file": r"src/(core|lib|domain|engine|kernel)|packages/(core|shared)",
        "exclude_tests": True,
    },
    "authentication/authorization rewrite": {
        "file": r"auth",
        "min_matching_files": 5,
        "exclude_tests": True,
    },
    "schema migration with irreversible data changes": {
        "file": r"migrat",
        "diff": r"drop_column|remove_column|DROP\s+(TABLE|COLUMN)|TRUNCATE|irreversible",
        "exclude_tests": True,
    },
}

# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def trigger_hit(name, di, meta):
    """Return True if the named trigger fires."""
    spec = TRIGGERS.get(name)
    if spec is None:
        return False

    matched_files = 0
    if "file" in spec:
        files = di["all_files"] if spec.get("scope") == "all_files" else di["files"]
        if spec.get("exclude_tests"):
            files = [f for f in files if not is_test_file(f)]
        for f in files:
            if re.search(spec["file"], f, re.I):
                matched_files += 1
        if matched_files == 0:
            return False
        if "min_matching_files" in spec and matched_files < spec["min_matching_files"]:
            return False

    if "diff" in spec:
        if not re.search(spec["diff"], di["diff"], re.I):
            return False

    if "branch" in spec and not re.search(spec["branch"], meta["branch"], re.I):
        if "title" not in spec:
            return False
        if not re.search(spec["title"], meta["title"], re.I):
            return False

    if "title" in spec and "branch" not in spec:
        if not re.search(spec["title"], meta["title"], re.I):
            return False

    if "min_lines" in spec and di["lines"] < spec["min_lines"]:
        return False

    return True


def select_tier(config, di, meta):
    """Walk tiers from highest to lowest; return first match."""
    # Count total signals for the risk_score trigger
    signal_count = sum(1 for name in TRIGGERS if trigger_hit(name, di, meta))

    ordered = ["critical_review", "high_risk_review", "escalated_review"]
    for tier_name in ordered:
        tier = config.get(tier_name)
        if not tier:
            continue
        triggers = tier.get("trigger", [])
        for t in triggers:
            if t.startswith("risk_score"):
                threshold = int(re.search(r"\d+", t).group())
                if signal_count >= threshold:
                    return tier_name, tier, signal_count
            elif t == "model uncertainty after lower-tier review":
                continue  # meta-trigger, not evaluable from diff
            elif trigger_hit(t, di, meta):
                return tier_name, tier, signal_count

    return "default_review", config.get("default_review", {}), signal_count


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    base = os.environ["BASE_SHA"]
    head = os.environ["HEAD_SHA"]

    config_path = os.path.join(os.path.dirname(__file__), "..", "review-tiers.yml")
    with open(config_path) as f:
        config = parse_config(f.read())

    di = diff_info(base, head)
    meta = {
        "title": os.environ.get("PR_TITLE", ""),
        "labels": os.environ.get("PR_LABELS", "").split(","),
        "branch": os.environ.get("PR_BRANCH", ""),
    }

    tier_name, tier, signals = select_tier(config, di, meta)

    model = tier.get("model") or "auto-efficient"

    # Emit step outputs
    gh_out = os.environ.get("GITHUB_OUTPUT", "")
    if gh_out:
        with open(gh_out, "a") as f:
            f.write(f"tier={tier_name}\n")
            f.write(f"model={model}\n")

    fired = [name for name in TRIGGERS if trigger_hit(name, di, meta)]
    print(f"Tier: {tier_name}  |  Model: {model}")
    print(f"Signals: {signals}  |  Files: {di['file_count']}  |  Lines: {di['lines']}  |  Diff base: {di['diff_base']}")
    if fired:
        print(f"Matched: {', '.join(fired)}")


if __name__ == "__main__":
    main()
