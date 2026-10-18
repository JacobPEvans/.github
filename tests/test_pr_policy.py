import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "pr-policy.py"
SPEC = importlib.util.spec_from_file_location("pr_policy", MODULE_PATH)
pr_policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pr_policy)


class PrPolicyTests(unittest.TestCase):
    def test_accepts_pinned_actions_and_three_job_depth(self):
        source = """\
name: valid
on:
  workflow_call:
jobs:
  first:
    timeout-minutes: ${{ github.event_name == 'pull_request' && 5 || 30 }}
    steps:
      - uses: actions/checkout@0123456789012345678901234567890123456789 # v7
      - uses: JacobPEvans/.github/.github/workflows/_ci-gate.yml@v1
  second:
    needs: first
    timeout-minutes: 5
    steps: []
  third:
    needs: second
    timeout-minutes: 4
    steps: []
"""
        self.assertEqual([], pr_policy.analyze(Path("valid.yml"), source))

    def test_accepts_first_party_sha_with_or_without_version_comment(self):
        source = """\
name: first-party-pins
on: pull_request
jobs:
  build:
    timeout-minutes: 5
    steps:
      - uses: JacobPEvans/example@0123456789012345678901234567890123456789 # v1.2.3
      - uses: dryvist/example/.github/workflows/build.yml@abcdefabcdefabcdefabcdefabcdefabcdefabcd
"""
        self.assertEqual([], pr_policy.analyze(Path("first-party-pins.yml"), source))

    def test_documented_timeout_exception_allows_twenty_five_minutes_only(self):
        source = """\
name: exception
on: pull_request
jobs:
  build:
    timeout-minutes: ${{ github.event_name == 'pull_request' && 10 || 30 }} # pr-policy: timeout-exception shared runner CPU
    steps: []
  bare:
    timeout-minutes: 25 # pr-policy: timeout-exception
    steps: []
  over:
    timeout-minutes: 26 # pr-policy: timeout-exception still too slow
    steps: []
"""
        lines = [line for line, rule, _ in pr_policy.analyze(Path("exception.yml"), source) if rule == "timeout-minutes"]
        self.assertEqual([8, 11], lines)

    def test_reports_timeout_depth_and_ref_violations(self):
        source = """\
name: invalid
on: pull_request
jobs:
  first:
    steps:
      - uses: JacobPEvans/example@main
      - uses: actions/checkout@v4
  second:
    needs: first
    timeout-minutes: 6
    steps: []
  third:
    needs: second
    timeout-minutes: 5
    steps: []
  fourth:
    needs: third
    timeout-minutes: 5
    steps: []
"""
        violations = pr_policy.analyze(Path("invalid.yml"), source)
        rules = {rule for _, rule, _ in violations}
        self.assertEqual(
            {"timeout-minutes", "needs-depth", "first-party-ref", "third-party-pin"},
            rules,
        )

    def test_schedule_only_workflow_is_timeout_exempt(self):
        source = """\
name: scheduled
on:
  schedule:
    - cron: '0 0 * * *'
jobs:
  cleanup:
    timeout-minutes: 30
    steps: []
"""
        self.assertEqual([], pr_policy.analyze(Path("scheduled.yml"), source))

    def test_changed_lines_counts_only_added_lines_in_the_new_file(self):
        diff = """\
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -3,3 +3,4 @@ jobs:
   build:
-    timeout-minutes: 30
+    timeout-minutes: 5
+    steps: []
   test:
diff --git a/old.yml b/old.yml
--- a/old.yml
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/new.yml b/new.yml
--- /dev/null
+++ b/new.yml
@@ -0,0 +1,2 @@
+name: new
+on: pull_request
"""
        self.assertEqual(
            {".github/workflows/ci.yml": {4, 5}, "new.yml": {1, 2}},
            pr_policy.changed_lines(diff),
        )

    def test_diff_mode_reports_only_violations_on_changed_lines(self):
        import contextlib
        import io
        import sys
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflows = root / ".github" / "workflows"
            workflows.mkdir(parents=True)
            (workflows / "ci.yml").write_text(
                "on: pull_request\njobs:\n  old:\n    timeout-minutes: 30\n    steps: []\n"
                "  new:\n    timeout-minutes: 30\n    steps: []\n"
            )
            diff = root / "pr.diff"

            def run(diff_text):
                diff.write_text(diff_text)
                out = io.StringIO()
                argv = sys.argv
                sys.argv = ["pr-policy.py", str(root), "--diff", str(diff)]
                try:
                    with contextlib.redirect_stdout(out):
                        code = pr_policy.main()
                finally:
                    sys.argv = argv
                return code, out.getvalue()

            header = "--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n"
            code, out = run(header + "@@ -5,0 +6,3 @@\n+  new:\n+    timeout-minutes: 30\n+    steps: []\n")
            self.assertEqual(1, code)
            self.assertIn("ci.yml:7 timeout-minutes", out)
            self.assertNotIn("ci.yml:4", out)

            code, out = run("--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n")
            self.assertEqual(0, code)


DIFF_SCRIPT = Path(__file__).parents[1] / "scripts" / "pr-policy-diff.sh"
# A gh stub whose diff endpoint fails the way it does past 300 files and whose file list returns $FILES.
FAKE_GH = """\
#!/usr/bin/env bash
case "$*" in
  *vnd.github.diff*) exit 1 ;;
  *) cat "$FILES" ;;
esac
"""


class PrPolicyDiffTests(unittest.TestCase):
    def run_diff(self, files):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "gh").write_text(FAKE_GH)
            (tmp / "gh").chmod(0o755)
            (tmp / "files.json").write_text(json.dumps(files))
            env = {
                **os.environ,
                "PATH": f"{tmp}:{os.environ['PATH']}",
                "FILES": str(tmp / "files.json"),
                "REPO": "o/r",
                "PR": "1",
                "CHANGED_FILES": str(len(files)),
            }
            result = subprocess.run(["bash", str(DIFF_SCRIPT), str(tmp / "pr.diff")], env=env)
            diff = (tmp / "pr.diff").read_text() if result.returncode == 0 else None
            return result.returncode, diff

    def test_rebuilds_the_diff_from_file_patches_past_the_diff_cap(self):
        files = [
            {"filename": ".github/workflows/ci.yml", "patch": "@@ -1,2 +1,3 @@\n a\n+b\n c"},
            {"filename": "image.png"},
        ]
        code, diff = self.run_diff(files)
        self.assertEqual(0, code)
        self.assertEqual({".github/workflows/ci.yml": {2}, "image.png": set()}, pr_policy.changed_lines(diff))

    def test_falls_back_when_a_workflow_file_has_no_patch(self):
        code, _ = self.run_diff([{"filename": ".github/workflows/ci.yml"}])
        self.assertEqual(1, code)


if __name__ == "__main__":
    unittest.main()
