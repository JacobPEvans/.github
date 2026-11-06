"""Network-free unit tests for flake-soak-update.py."""

from __future__ import annotations

import contextlib
import datetime as dt
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "flake-soak-update.py"
SPEC = importlib.util.spec_from_file_location("flake_soak_update", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


REVISION_A = "a" * 40
REVISION_B = "b" * 40
CUTOFF = dt.datetime(2026, 10, 30, tzinfo=dt.timezone.utc)


def node(owner: str, repo: str, rev: str, ref: str | None = "main") -> dict:
    return {
        "original": {"type": "github", "owner": owner, "repo": repo, **({"ref": ref} if ref else {})},
        "locked": {"type": "github", "owner": owner, "repo": repo, "rev": rev},
    }


def lock(nodes: dict[str, dict]) -> dict:
    return {
        "version": 7,
        "root": "root",
        "nodes": {"root": {"inputs": {name: name for name in nodes}}, **nodes},
    }


class FlakeSoakUpdateTests(unittest.TestCase):
    def test_floor_refusal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "flake.lock").write_text(json.dumps(lock({})))
            with patch("sys.argv", ["flake-soak-update.py", "--min-age-days", "2", directory]):
                with self.assertRaises(SystemExit) as raised:
                    MODULE.main()
        self.assertEqual(raised.exception.code, 2)

    def test_first_party_bypasses_soak(self) -> None:
        updates = MODULE.choose_updates(lock({"ours": node("jpe-nix", "tool", REVISION_A)}), CUTOFF)
        self.assertEqual(len(updates), 1)
        self.assertTrue(updates[0].first_party)
        self.assertEqual(updates[0].command, ["nix", "flake", "update", "ours"])

    def test_channel_pick_uses_soaked_release(self) -> None:
        source = lock({"nixpkgs": node("NixOS", "nixpkgs", REVISION_A, "nixos-unstable")})
        released = dt.datetime(2026, 10, 29, tzinfo=dt.timezone.utc)
        with patch.object(MODULE, "channel_release", return_value=(REVISION_B, released)) as channel:
            updates = MODULE.choose_updates(source, CUTOFF)
        channel.assert_called_once_with("nixos-unstable", CUTOFF)
        self.assertEqual(updates[0].new_rev, REVISION_B)
        self.assertEqual(updates[0].released, "2026-10-29")

    def test_branch_pick_uses_soaked_commit(self) -> None:
        source = lock({"home": node("nix-community", "home-manager", REVISION_A, "release-26.05")})
        released = dt.datetime(2026, 10, 28, tzinfo=dt.timezone.utc)
        with patch.object(MODULE, "github_ref_is_tag", return_value=False), patch.object(
            MODULE, "github_branch_revision", return_value=(REVISION_B, released)
        ) as branch:
            updates = MODULE.choose_updates(source, CUTOFF)
        branch.assert_called_once_with("nix-community", "home-manager", "release-26.05", CUTOFF)
        self.assertEqual(updates[0].new_rev, REVISION_B)

    def test_tag_is_skipped(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch.object(MODULE, "github_ref_is_tag", return_value=True):
            updates = MODULE.choose_updates(lock({"tagged": node("other", "repo", REVISION_A, "v1.2.3")}), CUTOFF)
        self.assertEqual(updates, [])
        self.assertIn("skip tagged: Renovate owns tag v1.2.3", output.getvalue())

    def test_unchanged_revision_is_not_updated(self) -> None:
        with patch.object(MODULE, "github_ref_is_tag", return_value=False), patch.object(
            MODULE, "github_branch_revision", return_value=(REVISION_A, CUTOFF)
        ):
            updates = MODULE.choose_updates(lock({"same": node("other", "repo", REVISION_A)}), CUTOFF)
        self.assertEqual(updates, [])


if __name__ == "__main__":
    unittest.main()
