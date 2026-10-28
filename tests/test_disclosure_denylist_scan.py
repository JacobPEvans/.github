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

    def _run(self, env_extra=None, allowlist=None):
        env = {**os.environ}
        if env_extra:
            env.update(env_extra)
        args = ["bash", str(SCRIPT), str(self.denylist), self.base_sha]
        if allowlist is not None:
            args.append(str(allowlist))
        return subprocess.run(args, cwd=self.repo, capture_output=True, text=True, env=env)

    def _allowlist(self, text):
        path = self.tmp / "allowlist.txt"
        path.write_text(text)
        return path

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

    def test_own_repository_name_is_not_a_hit(self):
        body = "View the job log at https://example.test/github/acme/SECRET-TERM."
        own = self._run(env_extra={"PR_BODY": body, "GITHUB_REPOSITORY": "acme/secret-term"})
        self.assertEqual(own.returncode, 0, own.stdout + own.stderr)

        other = self._run(env_extra={"PR_BODY": body, "GITHUB_REPOSITORY": "acme/elsewhere"})
        self.assertEqual(other.returncode, 1)
        self.assertIn("PR body:1", other.stdout)

    def test_pr_title_hit_fails_without_leaking_it(self):
        result = self._run(env_extra={"PR_TITLE": "fix ANOTHER-TERM handling"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("PR title:1", result.stdout)
        self.assertNotIn("ANOTHER-TERM", result.stdout)

    def test_term_inside_a_larger_word_does_not_hit(self):
        """The false-positive fix: a denylisted term is only a hit as a whole token.

        Without `grep -w` these three lines each matched, which is what made the
        gate fire on ordinary prose that merely contains the term as a substring.
        """
        (self.repo / "notes.txt").write_text(
            "prefixSECRET-TERM\n"
            "SECRET-TERMsuffix\n"
            "wrappedSECRET-TERMinside\n"
        )
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "substring only")

        result = self._run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_standalone_term_still_hits(self):
        """Effectiveness is preserved: the same term as its own token still fails.

        Paired with the test above — the fix must narrow matching without
        blinding the gate, so this asserts recall at each separator a real leak
        would use.
        """
        for line in ("SECRET-TERM", "host SECRET-TERM here",
                     "(SECRET-TERM)", "SECRET-TERM.example", "a/SECRET-TERM/b"):
            with self.subTest(line=line):
                (self.repo / "notes.txt").write_text(line + "\n")
                run_git(self.repo, "add", "-A")
                run_git(self.repo, "commit", "-q", "-m", "leak")

                result = self._run()
                self.assertEqual(result.returncode, 1, f"missed: {line!r}")
                self.assertIn("notes.txt:1", result.stdout)
                self.assertNotIn("SECRET-TERM", result.stdout)
                self.assertNotIn("SECRET-TERM", result.stderr)

    def test_underscore_bounds_a_term(self):
        """`grep -w` counts `_` as a word character, so it is normalized away.

        Without the normalization this line escapes the gate, because `_` glues
        the term to the neighbouring token and `-w` then sees one long word.
        """
        (self.repo / "notes.txt").write_text("prefix_SECRET-TERM_suffix\n")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "underscore adjacent")

        result = self._run()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("notes.txt:1", result.stdout)
        self.assertNotIn("SECRET-TERM", result.stdout)

    RENOVATE_BODY = (
        "Bumps a dependency.\n"
        "### Release Notes\n"
        "upstream says SECRET-TERM\n"
        "### Configuration\n"
        "{config}\n"
    )

    def test_renovate_release_notes_are_not_scanned(self):
        body = self.RENOVATE_BODY.format(config="schedule: at any time")
        result = self._run(env_extra={"PR_BODY": body, "PR_AUTHOR": "renovate[bot]"})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_self_hosted_renovate_release_notes_are_not_scanned(self):
        body = self.RENOVATE_BODY.format(config="schedule: at any time")
        result = self._run(
            env_extra={"PR_BODY": body, "PR_AUTHOR": "jacobpevans-release-please[bot]"}
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_other_author_release_notes_are_scanned(self):
        body = self.RENOVATE_BODY.format(config="schedule: at any time")
        result = self._run(env_extra={"PR_BODY": body, "PR_AUTHOR": "someone"})
        self.assertEqual(result.returncode, 1)

    def test_renovate_body_outside_release_notes_still_hits(self):
        body = self.RENOVATE_BODY.format(config="ANOTHER-TERM")
        result = self._run(env_extra={"PR_BODY": body, "PR_AUTHOR": "renovate[bot]"})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.split(), ["PR", "body:5"])
        self.assertNotIn("ANOTHER-TERM", result.stdout + result.stderr)

    def test_release_notes_heading_from_a_person_is_still_scanned(self):
        body = self.RENOVATE_BODY.format(config="nothing")
        result = self._run(env_extra={"PR_BODY": body, "PR_AUTHOR": "someone"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("PR body:3", result.stdout)



    def test_allowlisted_identifier_is_not_a_hit(self):
        """A term inside a listed identifier does not hit; matching ignores case.

        ANOTHER-TERM is a whole token inside ANOTHER-TERM-PACK, so it hits on its own.
        """
        (self.repo / "notes.txt").write_text(
            "uses ANOTHER-TERM-PACK here\n"
            "and another-term-pack too\n"
        )
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "allowlisted identifier")

        self.assertEqual(self._run().returncode, 1, "term hits without the allowlist")
        result = self._run(allowlist=self._allowlist("ANOTHER-TERM-PACK\n"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_term_outside_an_allowlisted_identifier_still_hits(self):
        (self.repo / "notes.txt").write_text(
            "ANOTHER-TERM-PACK\n"
            "plain ANOTHER-TERM here\n"
        )
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "identifier then term")

        result = self._run(allowlist=self._allowlist("ANOTHER-TERM-PACK\n"))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.split(), ["notes.txt:2"])
        self.assertNotIn("ANOTHER-TERM", result.stdout + result.stderr)

    def test_identifier_is_removed_only_as_a_whole_token(self):
        """A listed identifier glued to a word stays in place; a bounded one is removed.

        Line 1 joins it with `_`, line 2 with `-` then a capital letter, line 3 with
        `-` then a lowercase letter: the term still hits on all three. Line 4 bounds it
        with `/`, so it is removed and the line is clean.
        """
        (self.repo / "notes.txt").write_text(
            "CRIBL_ANOTHER-TERM-PACK_CONF\n"
            "ANOTHER-TERM-PACK-V2\n"
            "ANOTHER-TERM-PACK-x\n"
            "dir/ANOTHER-TERM-PACK/conf.yml\n"
        )
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "glued identifiers")

        result = self._run(allowlist=self._allowlist("ANOTHER-TERM-PACK\n"))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(
            result.stdout.split(), ["notes.txt:1", "notes.txt:2", "notes.txt:3"]
        )

    def test_version_suffix_after_identifier_is_removed(self):
        """`<id>-` then a digit is a version suffix, so the identifier is removed.

        The released asset name `<id>-0.1.0.crbl` clears; the term hits without the
        allowlist.
        """
        (self.repo / "notes.txt").write_text(
            "asset ANOTHER-TERM-PACK-0.1.0.crbl here\n"
            "ANOTHER-TERM-PACK-2\n"
        )
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "version suffix")

        self.assertEqual(self._run().returncode, 1, "term hits without the allowlist")
        result = self._run(allowlist=self._allowlist("ANOTHER-TERM-PACK\n"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_allowlist_entries_match_literally(self):
        (self.repo / "notes.txt").write_text("uses ANOTHER-TERM-PACK here\n")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-q", "-m", "regex metacharacter entry")

        result = self._run(allowlist=self._allowlist("ANOTHER.TERM-PACK\n"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("notes.txt:1", result.stdout)

    def test_allowlist_does_not_cover_pr_title(self):
        result = self._run(
            env_extra={"PR_TITLE": "fix ANOTHER-TERM-PACK wiring"},
            allowlist=self._allowlist("ANOTHER-TERM-PACK\n"),
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("PR title:1", result.stdout)
        self.assertNotIn("ANOTHER-TERM", result.stdout + result.stderr)

    def test_missing_allowlist_is_instrument_error(self):
        result = self._run(allowlist=self.tmp / "nope.txt")
        self.assertEqual(result.returncode, 2)

    def test_missing_denylist_is_instrument_error(self):
        result = subprocess.run(
            ["bash", str(SCRIPT), str(self.tmp / "nope.txt"), self.base_sha],
            cwd=self.repo, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
