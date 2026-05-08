#!/usr/bin/env python3
"""Select a review tier based on PR diff analysis.

Reads .github/review-tiers.yml, inspects the git diff between BASE_SHA and
HEAD_SHA, and writes the chosen tier's model (and metadata) to $GITHUB_OUTPUT.

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
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()


def diff_info(base, head):
    files = [f for f in run(f"git diff --name-only {base}..{head}").splitlines() if f]
    stat = run(f"git diff --shortstat {base}..{head}")
    nums = re.findall(r"(\d+)", stat)
    lines = sum(int(n) for n in nums[1:]) if len(nums) > 1 else 0
    # Only fetch full diff content if file count is manageable
    diff_text = run(f"git diff {base}..{head}") if len(files) <= 200 else ""
    return {"files": files, "file_count": len(files), "lines": lines, "diff": diff_text}

# ---------------------------------------------------------------------------
# Trigger → pattern mapping
# ---------------------------------------------------------------------------

TRIGGERS = {
    # ── escalated ──
    "tests changed": {
        "file": r"test|spec|__tests__|\.test\.|\.spec\.",
    },
    "public API changed": {
        "file": r"api/v\d|openapi|swagger|\.proto$|graphql.*schema|routes|endpoint",
    },
    "database query logic changed": {
        "file": r"query|repository|dao|\.sql$",
        "diff": r"\b(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE)\b",
    },
    "auth-adjacent code changed": {
        "file": r"auth|session|token|oauth|permission|login|credential|identity",
    },
    # ── high risk ──
    "migrations": {
        "file": r"migrat",
    },
    "permissions": {
        "file": r"permission|rbac|acl|role|policy|guard|authorize",
    },
    "payment or billing logic": {
        "file": r"payment|billing|invoice|subscription|ledger|pricing|charge|stripe",
    },
    "concurrency": {
        "file": r"lock|mutex|semaphore|concurrent|atomic|worker|thread|queue",
        "diff": r"synchronized|ReentrantLock|Mutex|\.lock\(|atomic|WaitGroup|Semaphore",
    },
    "event processing": {
        "file": r"event.*(process|handler)|consumer|producer|subscriber|listener|broker",
    },
    "security boundary": {
        "file": r"security|firewall|cors|csp|sanitiz|encrypt|crypto|vault|certificate",
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
    },
    "authentication/authorization rewrite": {
        "file": r"auth",
        "min_matching_files": 5,
    },
    "schema migration with irreversible data changes": {
        "file": r"migrat",
        "diff": r"drop_column|remove_column|DROP\s+(TABLE|COLUMN)|TRUNCATE|irreversible",
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
        for f in di["files"]:
            if re.search(spec["file"], f, re.I):
                matched_files += 1
        if matched_files == 0:
            return False
        if "min_matching_files" in spec and matched_files < spec["min_matching_files"]:
            return False

    if "diff" in spec:
        if not re.search(spec["diff"], di["diff"], re.I):
            # If there's also a file pattern that matched, diff is optional
            if "file" not in spec:
                return False
            # Both file AND diff required when both specified
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

    model = tier.get("model", "gpt-5.1-codex")
    effort = tier.get("reasoning_effort", "low")

    # Emit step outputs
    gh_out = os.environ.get("GITHUB_OUTPUT", "")
    if gh_out:
        with open(gh_out, "a") as f:
            f.write(f"tier={tier_name}\n")
            f.write(f"model={model}\n")
            f.write(f"reasoning_effort={effort}\n")

    fired = [name for name in TRIGGERS if trigger_hit(name, di, meta)]
    print(f"Tier: {tier_name}  |  Model: {model}  |  Effort: {effort}")
    print(f"Signals: {signals}  |  Files: {di['file_count']}  |  Lines: {di['lines']}")
    if fired:
        print(f"Matched: {', '.join(fired)}")


if __name__ == "__main__":
    main()
