#!/usr/bin/env python3
"""Check shared workflow timeout, dependency-depth and action-ref policy."""

from __future__ import annotations

import argparse
import math
import os
import re
import sys
from pathlib import Path

import yaml
from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode


FIRST_PARTY = ("dryvist",)
FIRST_PARTY_PREFIXES = ("jacobpevans-", "jpe-")
TIMEOUT_EXPRESSION = re.compile(
    r"^\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*&&\s*"
    r"(\d+(?:\.\d+)?)\s*\|\|\s*(.+?)\s*\}\}$"
)
SHA = re.compile(r"@[0-9a-fA-F]{40}$")
VERSION_COMMENT = re.compile(r"#\s*v\d+(?:\.\d+)*\b")
# A documented exception on the timeout line raises the pull-request cap; the reason is required.
TIMEOUT_EXCEPTION = re.compile(r"#\s*pr-policy:\s*timeout-exception\s+\S")
TIMEOUT_LIMIT = 5
TIMEOUT_EXCEPTION_LIMIT = 10


def scalar(node: Node | None) -> str | None:
    return node.value if isinstance(node, ScalarNode) else None


def pairs(node: Node | None, seen: set[int] | None = None) -> list[tuple[Node, Node]]:
    if not isinstance(node, MappingNode):
        return []
    seen = seen if seen is not None else set()
    if id(node) in seen:
        return []
    seen.add(id(node))
    explicit: list[tuple[Node, Node]] = []
    merged: list[tuple[Node, Node]] = []
    for key, value in node.value:
        if key.tag == "tag:yaml.org,2002:merge" or scalar(key) == "<<":
            sources = sequence_values(value) if isinstance(value, SequenceNode) else [value]
            for source in sources:
                merged.extend(pairs(source, seen))
        else:
            explicit.append((key, value))
    return explicit + merged


def get(node: Node | None, key: str) -> Node | None:
    return next((value for name, value in pairs(node) if scalar(name) == key), None)


def sequence_values(node: Node | None) -> list[Node]:
    return node.value if isinstance(node, SequenceNode) else []


def first_line(node: Node | None) -> int:
    return (node.start_mark.line + 1) if node is not None else 1


def is_first_party(owner: str) -> bool:
    owner = owner.casefold()
    # The calling repository's own owner is first-party too, so no org list has to name it.
    own = os.environ.get("GITHUB_REPOSITORY_OWNER", "").casefold()
    return owner in {"jacobpevans", own} - {""} or owner in FIRST_PARTY or owner.startswith(FIRST_PARTY_PREFIXES)


def workflow_events(root: Node) -> set[str]:
    trigger = get(root, "on")
    if isinstance(trigger, MappingNode):
        return {name for key, _ in pairs(trigger) if (name := scalar(key)) is not None}
    if isinstance(trigger, SequenceNode):
        return {name for item in sequence_values(trigger) if (name := scalar(item)) is not None}
    name = scalar(trigger)
    return {name} if name else set()


def excludes_pull_request(condition: str | None) -> bool:
    if not condition:
        return False
    condition = condition.strip()
    if condition.startswith("${{") and condition.endswith("}}"):
        condition = condition[3:-2].strip()
    if "||" in condition:
        return False
    equals = re.findall(r"github\.event_name\s*==\s*['\"]([^'\"]+)['\"]", condition)
    if equals:
        return "pull_request" not in equals
    return bool(re.search(r"github\.event_name\s*!=\s*['\"]pull_request['\"]", condition))


def timeout_is_valid(node: Node | None, limit: float = TIMEOUT_LIMIT) -> bool:
    if isinstance(node, ScalarNode) and node.tag in {
        "tag:yaml.org,2002:int",
        "tag:yaml.org,2002:float",
    }:
        try:
            value = float(node.value.replace("_", ""))
            return math.isfinite(value) and value <= limit
        except ValueError:
            return False
    value = scalar(node)
    if value is None:
        return False
    match = TIMEOUT_EXPRESSION.fullmatch(value)
    return bool(match and float(match.group(1)) <= limit)


def walk_uses(node: Node, seen: set[int] | None = None):
    seen = seen if seen is not None else set()
    if id(node) in seen:
        return
    seen.add(id(node))
    if isinstance(node, MappingNode):
        for key, value in pairs(node):
            if scalar(key) == "uses" and isinstance(value, ScalarNode):
                yield key, value
            yield from walk_uses(key, seen)
            yield from walk_uses(value, seen)
    elif isinstance(node, SequenceNode):
        for value in sequence_values(node):
            yield from walk_uses(value, seen)


def analyze(path: Path, source: str) -> list[tuple[int, str, str]]:
    try:
        root = yaml.compose(source)
    except yaml.YAMLError as error:
        mark = getattr(error, "problem_mark", None)
        return [(mark.line + 1 if mark else 1, "yaml", str(error).splitlines()[0])]
    if root is None:
        return []

    lines = source.splitlines()
    violations: list[tuple[int, str, str]] = []
    jobs_node = get(root, "jobs")
    jobs = [(scalar(key), key, value) for key, value in pairs(jobs_node) if scalar(key)]

    if "pull_request" in workflow_events(root) or "workflow_call" in workflow_events(root):
        for job_id, job_key, job_node in jobs:
            if get(job_node, "steps") is None:
                continue
            condition = scalar(get(job_node, "if"))
            if excludes_pull_request(condition):
                continue
            timeout_node = get(job_node, "timeout-minutes")
            timeout_line = first_line(timeout_node or job_key)
            excepted = timeout_node is not None and bool(TIMEOUT_EXCEPTION.search(lines[timeout_line - 1]))
            limit = TIMEOUT_EXCEPTION_LIMIT if excepted else TIMEOUT_LIMIT
            if not timeout_is_valid(timeout_node, limit):
                violations.append(
                    (
                        timeout_line,
                        "timeout-minutes",
                        f"job {job_id!r} needs a literal timeout at most 5 or the required pull_request expression",
                    )
                )

    needs: dict[str, list[str]] = {}
    job_lines: dict[str, int] = {}
    for job_id, job_key, job_node in jobs:
        needs_node = get(job_node, "needs")
        if isinstance(needs_node, SequenceNode):
            dependencies = [name for item in sequence_values(needs_node) if (name := scalar(item))]
        elif (name := scalar(needs_node)) is not None:
            dependencies = [name]
        else:
            dependencies = []
        needs[job_id] = dependencies
        job_lines[job_id] = first_line(job_key)

    depth_cache: dict[str, int] = {}

    def depth(job_id: str, visiting: set[str] | None = None) -> int:
        if job_id in depth_cache:
            return depth_cache[job_id]
        visiting = visiting or set()
        if job_id in visiting:
            return 1
        upstream = [dependency for dependency in needs[job_id] if dependency in needs]
        value = 1 + max((depth(dependency, visiting | {job_id}) for dependency in upstream), default=0)
        depth_cache[job_id] = value
        return value

    for job_id in needs:
        job_depth = depth(job_id)
        if job_depth > 3:
            violations.append(
                (job_lines[job_id], "needs-depth", f"job {job_id!r} is at depth {job_depth}; maximum is 3")
            )

    for _, uses_node in walk_uses(root):
        uses = uses_node.value.strip()
        if uses.startswith("./") or uses.startswith("docker://"):
            continue
        owner = uses.split("/", 1)[0]
        line_number = first_line(uses_node)
        line = lines[line_number - 1] if line_number <= len(lines) else ""
        if is_first_party(owner):
            if not re.search(r"@v\d+$", uses):
                violations.append(
                    (line_number, "first-party-ref", f"first-party use {uses!r} must end in @v<digits>")
                )
        elif not SHA.search(uses) or not VERSION_COMMENT.search(line):
            violations.append(
                (line_number, "third-party-pin", f"third-party use {uses!r} needs a 40-hex SHA and a # vX comment")
            )

    return sorted(violations, key=lambda item: (item[0], item[1]))


def policy_files(root: Path) -> list[Path]:
    files = set(root.joinpath(".github/workflows").rglob("*.yml"))
    files.update(root.joinpath(".github/workflows").rglob("*.yaml"))
    for filename in ("action.yml", "action.yaml"):
        files.update(path for path in root.rglob(filename) if ".git" not in path.parts)
    return sorted(path for path in files if path.is_file())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", type=Path, default=Path.cwd())
    root = parser.parse_args().root.resolve()
    violations = []
    for path in policy_files(root):
        for line, rule, message in analyze(path, path.read_text()):
            violations.append(f"{path.relative_to(root).as_posix()}:{line} {rule} {message}")
    for violation in violations:
        print(violation)
    if violations:
        return 1
    print("PR workflow policy passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
