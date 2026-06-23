#!/usr/bin/env python3

import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("select-review-tier.py")
spec = importlib.util.spec_from_file_location("select_review_tier", SCRIPT_PATH)
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)

CONFIG_PATH = Path(__file__).resolve().parent.parent / "review-tiers.yml"
META = {"title": "", "labels": [], "branch": ""}


def load_config():
    return selector.parse_config(CONFIG_PATH.read_text())


def diff_info_for_files(files, *, all_files=None, diff="", lines=10):
    if all_files is None:
        all_files = files
    return {
        "files": files,
        "non_test_files": [f for f in files if not selector.is_test_file(f)],
        "all_files": all_files,
        "file_count": len(all_files),
        "lines": lines,
        "diff": diff,
        "diff_base": "base",
    }


class ReviewTierSelectorTest(unittest.TestCase):
    def test_internal_dashboard_route_and_tests_do_not_escalate(self):
        config = load_config()
        di = diff_info_for_files(
            ["src/routes/dashboard.ts", "src/routes/dashboard.test.ts"],
            all_files=["docs/dashboard.md", "src/routes/dashboard.ts", "src/routes/dashboard.test.ts"],
        )

        tier_name, _tier, signals = selector.select_tier(config, di, META)

        self.assertTrue(selector.trigger_hit("tests changed", di, META))
        self.assertFalse(selector.trigger_hit("public API changed", di, META))
        self.assertEqual(signals, 1)
        self.assertEqual(tier_name, "default_review")

    def test_explicit_api_route_escalates(self):
        config = load_config()
        di = diff_info_for_files(["src/routes/api.ts", "src/routes/api.test.ts"])

        tier_name, _tier, _signals = selector.select_tier(config, di, META)

        self.assertTrue(selector.trigger_hit("public API changed", di, META))
        self.assertEqual(tier_name, "escalated_review")

    def test_openapi_spec_escalates_even_when_non_code(self):
        config = load_config()
        di = diff_info_for_files([], all_files=["openapi.yml"])

        tier_name, _tier, _signals = selector.select_tier(config, di, META)

        self.assertTrue(selector.trigger_hit("public API changed", di, META))
        self.assertEqual(tier_name, "escalated_review")

    def test_test_only_destructive_text_does_not_escalate(self):
        config = load_config()
        di = diff_info_for_files(["src/db/queries.test.ts"], diff="")

        tier_name, _tier, signals = selector.select_tier(config, di, META)

        self.assertTrue(selector.trigger_hit("tests changed", di, META))
        self.assertFalse(selector.trigger_hit("database query logic changed", di, META))
        self.assertFalse(selector.trigger_hit("data deletion or destructive updates", di, META))
        self.assertEqual(signals, 1)
        self.assertEqual(tier_name, "default_review")

    def test_diff_info_uses_merge_base_not_current_base_tip(self):
        original_cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)

            def git(*args):
                result = subprocess.run(
                    ["git", *args],
                    cwd=repo,
                    check=True,
                    capture_output=True,
                    text=True,
                )
                return result.stdout.strip()

            def write(path, content):
                file_path = repo / path
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_text(content)

            git("init", "-b", "main")
            git("config", "user.email", "test@example.com")
            git("config", "user.name", "Test User")

            write("README.md", "initial\n")
            git("add", ".")
            git("commit", "-m", "initial")

            git("checkout", "-b", "feature")
            write("docs/dashboard.md", "dashboard docs\n")
            write("src/routes/dashboard.ts", "export const dashboardRouter = true;\n")
            write("src/routes/dashboard.test.ts", "test('dashboard', () => {});\n")
            git("add", ".")
            git("commit", "-m", "dashboard ui change")
            head = git("rev-parse", "HEAD")

            git("checkout", "main")
            write(".github/workflows/review.yml", "name: review\n")
            write("src/db/queries.ts", "export const cleanup = 'DELETE FROM dispatch_runs';\n")
            git("add", ".")
            git("commit", "-m", "unrelated main changes")
            base = git("rev-parse", "HEAD")

            try:
                os.chdir(repo)
                di = selector.diff_info(base, head)
            finally:
                os.chdir(original_cwd)

        self.assertEqual(
            di["all_files"],
            ["docs/dashboard.md", "src/routes/dashboard.test.ts", "src/routes/dashboard.ts"],
        )
        self.assertNotIn(".github/workflows/review.yml", di["all_files"])
        self.assertNotIn("src/db/queries.ts", di["files"])


if __name__ == "__main__":
    unittest.main()
