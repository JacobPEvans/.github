import importlib.util
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

    def test_documented_timeout_exception_allows_ten_minutes_only(self):
        source = """\
name: exception
on: pull_request
jobs:
  build:
    timeout-minutes: ${{ github.event_name == 'pull_request' && 10 || 30 }} # pr-policy: timeout-exception shared runner CPU
    steps: []
  bare:
    timeout-minutes: 10 # pr-policy: timeout-exception
    steps: []
  over:
    timeout-minutes: 11 # pr-policy: timeout-exception still too slow
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


if __name__ == "__main__":
    unittest.main()
