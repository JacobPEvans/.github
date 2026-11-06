#!/usr/bin/env python3
"""Update root flake inputs only after their revisions have soaked."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


FIRST_PARTY = {"dryvist", "jacobpevans", "jacobpevans-personal", "jpe-nix"} | set(
    os.environ.get("FIRST_PARTY_OWNERS", "").lower().split()
)
S3_LISTING = "https://nix-releases.s3.amazonaws.com/?list-type=2"


class ChannelNotFound(Exception):
    """The requested Nix channel does not exist."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


@dataclass(frozen=True)
class Update:
    name: str
    owner: str
    repo: str
    old_rev: str
    new_rev: str
    released: str
    first_party: bool = False

    @property
    def command(self) -> list[str]:
        if self.first_party:
            return ["nix", "flake", "update", self.name]
        return [
            "nix",
            "flake",
            "lock",
            "--override-input",
            self.name,
            f"github:{self.owner}/{self.repo}/{self.new_rev}",
        ]


def is_first_party(owner: str | None) -> bool:
    normalized = (owner or "").casefold()
    return normalized in FIRST_PARTY or normalized.startswith("jpe-")


def github_headers() -> dict[str, str]:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "flake-soak-update"}
    if token := os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    return headers


def fetch_text(url: str, headers: dict[str, str] | None = None) -> str:
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode()


def fetch_json(url: str) -> Any:
    return json.loads(fetch_text(url, github_headers()))


def channel_release(channel: str, cutoff: dt.datetime) -> tuple[str, dt.datetime] | None:
    """Return the newest channel revision whose release artifact is old enough."""
    try:
        urllib.request.build_opener(NoRedirect).open(
            f"https://channels.nixos.org/{channel}", timeout=30
        )
    except urllib.error.HTTPError as error:
        if error.code == 404:
            error.close()
            raise ChannelNotFound(channel) from error
        location = error.headers.get("Location", "")
        error.close()
        marker = "releases.nixos.org/"
        if marker not in location:
            raise
        latest = location.split(marker, 1)[1]
    else:
        raise RuntimeError(f"{channel}: expected a release redirect")

    try:
        base = latest[: latest.rindex("pre") + 3]
    except ValueError:
        raise RuntimeError(f"{channel}: unrecognised channel release path {latest!r}")
    prefixes: list[str] = []
    after = ""
    while True:
        url = f"{S3_LISTING}&prefix={urllib.parse.quote(base)}&delimiter=/"
        if after:
            url += f"&start-after={urllib.parse.quote(after)}"
        page = fetch_text(url)
        found = [item for item in re.findall(r"<Prefix>([^<]+)</Prefix>", page) if item != base]
        prefixes.extend(found)
        if "<IsTruncated>true" not in page or not found:
            break
        after = found[-1]

    def release_number(prefix: str) -> int:
        release = re.search(r"pre(\d+)\.", prefix)
        return int(release.group(1)) if release else -1

    for prefix in reversed(sorted(prefixes, key=release_number)[-60:]):
        revision_key = fetch_text(f"{S3_LISTING}&prefix={urllib.parse.quote(prefix)}git-revision")
        modified = re.search(r"git-revision</Key><LastModified>([^<]+)", revision_key)
        if modified is None:
            continue
        released = dt.datetime.fromisoformat(modified.group(1).replace("Z", "+00:00"))
        if released <= cutoff:
            revision = fetch_text(f"https://releases.nixos.org/{prefix}git-revision").strip()
            if re.fullmatch(r"[0-9a-fA-F]{40}", revision) is None:
                raise RuntimeError(f"{channel}: invalid git revision in {prefix}git-revision")
            return revision, released
    return None


def github_ref_is_tag(owner: str, repo: str, ref: str) -> bool:
    url = f"https://api.github.com/repos/{owner}/{repo}/git/ref/tags/{urllib.parse.quote(ref, safe='')}"
    try:
        fetch_json(url)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            error.close()
            return False
        raise
    return True


def github_branch_revision(
    owner: str, repo: str, ref: str | None, cutoff: dt.datetime
) -> tuple[str, dt.datetime] | None:
    selected_ref = ref
    if selected_ref is None:
        metadata = fetch_json(f"https://api.github.com/repos/{owner}/{repo}")
        selected_ref = metadata["default_branch"]
    query = urllib.parse.urlencode(
        {"sha": selected_ref, "until": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"), "per_page": 1}
    )
    commits = fetch_json(f"https://api.github.com/repos/{owner}/{repo}/commits?{query}")
    if not commits:
        return None
    commit = commits[0]
    released = dt.datetime.fromisoformat(commit["commit"]["committer"]["date"].replace("Z", "+00:00"))
    return commit["sha"], released


def root_inputs(lock: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    root = lock["nodes"][lock["root"]]
    found: list[tuple[str, dict[str, Any]]] = []
    for name, target in root.get("inputs", {}).items():
        if not isinstance(target, str):
            print(f"skip {name}: follows another input")
            continue
        node = lock["nodes"].get(target)
        if node is None:
            print(f"skip {name}: lock node is missing")
            continue
        found.append((name, node))
    return found


def choose_updates(lock: dict[str, Any], cutoff: dt.datetime) -> list[Update]:
    updates: list[Update] = []
    for name, node in root_inputs(lock):
        original = node.get("original", {})
        locked = node.get("locked", {})
        owner = original.get("owner", "")
        repo = original.get("repo", "")
        old_rev = locked.get("rev", "")
        if is_first_party(owner):
            updates.append(Update(name, owner, repo, old_rev, "latest", "exempt", first_party=True))
            continue
        if original.get("type") != "github":
            print(f"skip {name}: Renovate owns non-GitHub input")
            continue
        ref = original.get("ref")
        is_nixpkgs_channel = repo == "nixpkgs" and bool(ref and re.fullmatch(r"(?:nixos|nixpkgs)-.+", ref))
        if ref and not is_nixpkgs_channel and github_ref_is_tag(owner, repo, ref):
            print(f"skip {name}: Renovate owns tag {ref}")
            continue

        selected: tuple[str, dt.datetime] | None
        if is_nixpkgs_channel:
            try:
                selected = channel_release(ref, cutoff)
            except ChannelNotFound:
                selected = github_branch_revision(owner, repo, ref, cutoff)
        else:
            selected = github_branch_revision(owner, repo, ref, cutoff)
        if selected is None:
            print(f"skip {name}: no revision old enough for the soak window")
            continue
        new_rev, released = selected
        if new_rev == old_rev:
            print(f"{name}: already at the selected revision")
            continue
        updates.append(Update(name, owner, repo, old_rev, new_rev, released.date().isoformat()))
    return updates


def render_summary(updates: list[Update]) -> str:
    rows = ["| input | old rev | new rev | released |", "| --- | --- | --- | --- |"]
    rows.extend(
        f"| {item.name} | {item.old_rev or 'unknown'} | {item.new_rev} | {item.released} |"
        for item in updates
    )
    return "\n".join(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("flake_dir", nargs="?", type=Path, default=Path("."))
    parser.add_argument("--min-age-days", type=int, default=7)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.min_age_days < 3:
        parser.error("--min-age-days must be at least 3")
    lock_path = args.flake_dir / "flake.lock"
    try:
        lock = json.loads(lock_path.read_text())
    except FileNotFoundError:
        print(f"error: no flake.lock at {lock_path}", file=sys.stderr)
        return 2

    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=args.min_age_days)
    updates = choose_updates(lock, cutoff)
    for update in updates:
        print(" ".join(update.command))
    if not args.dry_run:
        for update in updates:
            subprocess.run(update.command, cwd=args.flake_dir, check=True)
    print(render_summary(updates))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
