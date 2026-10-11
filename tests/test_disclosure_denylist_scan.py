"""Unit tests for scripts/disclosure-denylist-scan.sh.

Builds a tiny throwaway git repo, runs the scanner against it, and asserts:
  - a hit exits 1 and prints only "path:line" (never the matched term)
  - a clean diff exits 0
  - a PR title/body hit is caught the same way, never echoing the text
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = (
    Path(__file__).resolve().parents[1] / "scripts" / "disclosure-denylist-scan.sh"
)


def run_git(repo, *args):
    subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
             "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"},
    )


class DisclosureDenylistScanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        run_git(self.repo, "init", "-q")
        (self.repo / "README.md").write_text("hello\n")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "base")
        run_git(self.repo, "rev-parse", "HEAD")
        self.base_sha = subprocess.run(
            ["git", "-C", str(self.repo), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()

        self.denylist = self.tmp / "denylist.txt"
        self.denylist.write_text("SECRET-TERM\n# a comment\n\nANOTHER-TERM\n")

    def _run(self, env_extra=None):
        env = {**os.environ}
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            ["bash", str(SCRIPT), str(self.denylist), self.base_sha],
            cwd=self.repo, capture_output=True, text=True, env=env,
        )

    def test_clean_diff_passes(self):
        (self.repo / "notes.txt").write_text("nothing sensitive here\n")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "clean change")

        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("SECRET-TERM", result.stdout)

    def test_denylisted_term_in_diff_fails_without_leaking_it(self):
        (self.repo / "notes.txt").write_text("contains SECRET-TERM right here\n")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "leaky change")

        result = self._run()
        self.assertEqual(result.returncode, 1)
        self.assertIn("notes.txt:1", result.stdout)
        self.assertNotIn("SECRET-TERM", result.stdout)
        self.assertNotIn("SECRET-TERM", result.stderr)

    def test_existing_term_in_touched_file_is_not_rescanned(self):
        (self.repo / "CHANGELOG.md").write_text("old SECRET-TERM entry\n")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "history")
        self.base_sha = subprocess.run(
            ["git", "-C", str(self.repo), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        (self.repo / "CHANGELOG.md").write_text("new entry\nold SECRET-TERM entry\n")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "prepend")

        result = self._run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_added_line_hit_reports_its_new_line_number(self):
        (self.repo / "README.md").write_text("hello\nfine\nnow ANOTHER-TERM\n")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "append")

        result = self._run()
        self.assertEqual(result.returncode, 1)
        self.assertIn("README.md:3", result.stdout)
        self.assertNotIn("ANOTHER-TERM", result.stdout + result.stderr)

    def test_added_line_starting_with_plus_plus_is_scanned(self):
        (self.repo / "README.md").write_text("hello\n++ ANOTHER-TERM\nafter\n")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "plus-prefixed line")

        result = self._run()
        self.assertEqual(result.returncode, 1)
        self.assertIn("README.md:2", result.stdout)
        self.assertNotIn("ANOTHER-TERM", result.stdout + result.stderr)

    def test_pr_title_hit_fails_without_leaking_it(self):
        result = self._run(env_extra={"PR_TITLE": "fix ANOTHER-TERM handling"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("PR title:1", result.stdout)
        self.assertNotIn("ANOTHER-TERM", result.stdout)

    def test_missing_denylist_is_instrument_error(self):
        result = subprocess.run(
            ["bash", str(SCRIPT), str(self.tmp / "nope.txt"), self.base_sha],
            cwd=self.repo, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
