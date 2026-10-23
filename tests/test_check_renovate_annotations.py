"""Unit tests for scripts/check-renovate-annotations.sh.

Covers the git-refs requirements.yml gap this script exists to close: a
`type: git` collection entry's annotation sits above `- name:`/`type: git`
carrier lines, not immediately above the `version:` SHA line those managers
in most other file classes require. Asserts:
  - an annotated git-refs pin in requirements.yml passes despite the carrier
    lines (the actual bug this suite guards against regressing)
  - an unannotated git-refs pin in requirements.yml still fails
  - the stricter comment-only gap is unchanged for a role-defaults pin (the
    requirements.yml relaxation must not leak into other file classes)
  - zero covered files is reported as an instrument error (exit 2), never a
    silent pass
  - floating pins in role defaults and group_vars (container images without an
    exact x.y.z tag and sha256 digest, versions set to latest/release/stable)
    are warnings in the default warn mode and failures in enforce mode, with
    a same-line pin-exempt opt-out
"""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = (
    Path(__file__).resolve().parents[1] / "scripts" / "check-renovate-annotations.sh"
)

SHA = "c5e139cb7ccb286016020dd85c2f1d9c3b5a376f"
DIGEST = "sha256:" + "0123456789abcdef" * 4


class CheckRenovateAnnotationsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(
            subprocess.run, ["rm", "-rf", str(self.tmp)], check=False
        )

    def _run(self, mode=None):
        env = {k: v for k, v in os.environ.items() if k != "PIN_CHECK_MODE"}
        if mode is not None:
            env["PIN_CHECK_MODE"] = mode
        return subprocess.run(
            ["bash", str(SCRIPT), str(self.tmp)],
            capture_output=True,
            text=True,
            env=env,
        )

    def _write_defaults(self, body):
        role_dir = self.tmp / "roles" / "app" / "defaults"
        role_dir.mkdir(parents=True, exist_ok=True)
        (role_dir / "main.yml").write_text("---\n" + body)

    def test_annotated_git_ref_pin_with_carrier_lines_passes(self):
        (self.tmp / "requirements.yml").write_text(
            "---\n"
            "collections:\n"
            "  # renovate: datasource=git-refs depName=https://github.com/dryvist/homelab-contracts.git currentValue=main\n"
            "  - name: https://github.com/dryvist/homelab-contracts.git#/ansible/\n"
            "    type: git\n"
            f"    version: {SHA}\n"
        )
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("0 unannotated", result.stderr)

    def test_unannotated_git_ref_pin_fails(self):
        (self.tmp / "requirements.yml").write_text(
            "---\n"
            "collections:\n"
            "  - name: https://github.com/dryvist/homelab-contracts.git#/ansible/\n"
            "    type: git\n"
            f"    version: {SHA}\n"
        )
        result = self._run()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("unannotated version pin", result.stderr)

    def test_role_defaults_pin_keeps_comment_only_gap(self):
        # The requirements.yml relaxation must not leak into role defaults:
        # a real (non-comment) line between the annotation and the pin still
        # fails here, mirroring that customManager's comment-only regex gap.
        role_dir = self.tmp / "roles" / "example" / "defaults"
        role_dir.mkdir(parents=True)
        (role_dir / "main.yml").write_text(
            "---\n"
            "# renovate: datasource=github-releases depName=example/example\n"
            "unrelated_key: some_value\n"
            'traefik_version: "3.1.0"\n'
        )
        result = self._run()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("unannotated version pin", result.stderr)

    def test_zero_covered_files_is_instrument_error(self):
        (self.tmp / "README.md").write_text("nothing covered here\n")
        result = self._run()
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_floating_image_tag_warns_by_default_and_fails_when_enforced(self):
        self._write_defaults('app_image: "nginx:latest"\n')
        warned = self._run()
        self.assertEqual(warned.returncode, 0, warned.stderr)
        self.assertIn("::warning", warned.stderr)
        self.assertIn("container image app_image 'nginx:latest'", warned.stderr)
        enforced = self._run("enforce")
        self.assertEqual(enforced.returncode, 1, enforced.stderr)
        self.assertIn("::error", enforced.stderr)

    def test_image_without_digest_is_flagged(self):
        self._write_defaults("app_image: nginx:1.27.2\n")
        result = self._run("enforce")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("no sha256 digest", result.stderr)

    def test_minor_only_and_variant_major_tags_are_floating(self):
        self._write_defaults(
            f'a_image: "postgres:1.31-alpine@{DIGEST}"\n'
            f'b_image: "postgres:24-alpine@{DIGEST}"\n'
            f'c_image: "postgres:17@{DIGEST}"\n'
        )
        result = self._run("enforce")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stderr.count("floating tag"), 3, result.stderr)

    def test_exact_tag_with_digest_passes(self):
        self._write_defaults(
            f'app_image: "nginx:1.27.2-alpine@{DIGEST}"\n'
            f"digest_only_image: nginx@{DIGEST}\n"
        )
        result = self._run("enforce")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("::error", result.stderr)
        self.assertIn("pin check (enforce): scanned 1 files, 0 pin finding(s)", result.stderr)

    def test_bare_image_name_is_implicit_latest(self):
        self._write_defaults("app_image: nginx\n")
        result = self._run("enforce")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("implicit latest", result.stderr)

    def test_floating_version_keyword_is_flagged(self):
        self._write_defaults("app_version: latest\nother_version: release\n")
        result = self._run("enforce")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("app_version is 'latest'", result.stderr)
        self.assertIn("other_version is 'release'", result.stderr)

    def test_pin_exempt_on_the_same_line_passes(self):
        self._write_defaults(
            'other_image: "local/app:dev" # pin-exempt: locally built\n'
            "channel_version: stable # pin-exempt: upstream channel name\n"
        )
        result = self._run("enforce")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("::error", result.stderr)

    def test_pin_exempt_on_the_line_above_does_not_exempt(self):
        self._write_defaults(
            "# pin-exempt: locally built image\n"
            "local_image: local/app:dev\n"
        )
        result = self._run("enforce")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("floating tag 'dev'", result.stderr)

    def test_pin_exempt_without_reason_does_not_exempt(self):
        self._write_defaults("app_image: local/app:dev # pin-exempt:\n")
        result = self._run("enforce")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("floating tag 'dev'", result.stderr)

    def test_jinja_templated_image_is_resolved_from_its_variable(self):
        self._write_defaults(
            'traefik_image: "traefik:{{ traefik_version }}"\n'
            "# renovate: datasource=docker depName=traefik\n"
            'traefik_version: "3.1.0"\n'
        )
        result = self._run("enforce")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("::error", result.stderr)

    def test_folded_image_value_is_judged_on_the_following_line(self):
        self._write_defaults(f"app_image: >-\n  nginx:1.27@{DIGEST}\n")
        result = self._run("enforce")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("floating tag '1.27'", result.stderr)

    def test_group_vars_are_covered_and_other_paths_are_not(self):
        group_dir = self.tmp / "inventory" / "group_vars"
        group_dir.mkdir(parents=True)
        (group_dir / "all.yml").write_text("---\nops_version: stable\n")
        playbook_dir = self.tmp / "playbooks"
        playbook_dir.mkdir()
        (playbook_dir / "site.yml").write_text("---\nsite_image: nginx:latest\n")
        result = self._run("enforce")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("inventory/group_vars/all.yml", result.stderr)
        self.assertNotIn("playbooks/site.yml", result.stderr)

    def test_pin_findings_do_not_mask_an_unannotated_pin(self):
        self._write_defaults('app_image: "nginx:latest"\ntraefik_version: "3.1.0"\n')
        result = self._run("warn")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("unannotated version pin", result.stderr)
        self.assertIn("pin check (warn)", result.stderr)

    def test_unknown_pin_check_mode_is_instrument_error(self):
        self._write_defaults("app_image: nginx:1.27.2\n")
        result = self._run("loud")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("PIN_CHECK_MODE must be 'warn' or 'enforce'", result.stderr)


if __name__ == "__main__":
    unittest.main()
