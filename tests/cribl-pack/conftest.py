"""Shared pytest configuration for Cribl pack validation."""

import json
from pathlib import Path

import pytest
import yaml


def pytest_addoption(parser):
    parser.addoption("--pack-root", default=".", help="Root directory of the pack repo")
    parser.addoption("--pack-type", default="edge", help="Pack type: edge or stream")


@pytest.fixture(scope="session")
def pack_root(request):
    return Path(request.config.getoption("--pack-root"))


@pytest.fixture(scope="session")
def pack_type(request):
    value = request.config.getoption("--pack-type")
    allowed = {"edge", "stream"}
    if value not in allowed:
        pytest.fail(
            f"Invalid --pack-type value: {value!r}. "
            f"Expected one of: {', '.join(sorted(allowed))}."
        )
    return value


@pytest.fixture(scope="session")
def pack_dir(pack_root):
    """The default/ directory containing pack configuration."""
    d = pack_root / "default"
    assert d.is_dir(), f"Pack directory not found: {d}"
    return d


@pytest.fixture(scope="session")
def package_json(pack_root):
    p = pack_root / "package.json"
    assert p.exists(), f"package.json not found: {p}"
    return json.loads(p.read_text())


@pytest.fixture(scope="session")
def pack_yml(pack_dir):
    p = pack_dir / "pack.yml"
    if not p.exists():
        pytest.skip("No pack.yml found")
    text = p.read_text().strip()
    # pack.yml can be single-line JSON or YAML
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return yaml.safe_load(text)


@pytest.fixture(scope="session")
def inputs_yml(pack_dir):
    p = pack_dir / "inputs.yml"
    if not p.exists():
        pytest.skip("No inputs.yml found")
    return yaml.safe_load(p.read_text())


@pytest.fixture(scope="session")
def inputs_text(pack_dir):
    """Raw text of inputs.yml for pattern matching."""
    p = pack_dir / "inputs.yml"
    if not p.exists():
        pytest.skip("No inputs.yml found")
    return p.read_text()


@pytest.fixture(scope="session")
def route_yml(pack_dir):
    p = pack_dir / "pipelines" / "route.yml"
    if not p.exists():
        pytest.skip("No route.yml found")
    return yaml.safe_load(p.read_text())


@pytest.fixture(scope="session")
def all_yaml_files(pack_dir):
    return list(pack_dir.rglob("*.yml")) + list(pack_dir.rglob("*.yaml"))


@pytest.fixture(scope="session")
def sample_json_files(pack_root):
    samples_dir = pack_root / "data" / "samples"
    if not samples_dir.exists():
        return []
    files = []
    files.extend(samples_dir.rglob("*.json"))
    files.extend(samples_dir.rglob("*.jsonl"))
    files.extend(samples_dir.rglob("*.ndjson"))
    return list(files)
