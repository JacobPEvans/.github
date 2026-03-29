"""Cribl Pack Validation Tests.

Tier 1: YAML/JSON schema validation
Tier 2: Security exclusion scanning
Tier 3: Configuration cross-reference
Tier 4: Sample data validation
"""

import json
import re

import pytest
import yaml


# -- Tier 1: Schema Validation -----------------------------------------------


class TestYamlSyntax:
    """All YAML files must be valid."""

    def test_all_yaml_files_parse(self, all_yaml_files):
        errors = []
        for yf in all_yaml_files:
            try:
                yaml.safe_load(yf.read_text())
            except yaml.YAMLError as e:
                errors.append(f"{yf.name}: {e}")
        assert not errors, "YAML parse errors:\n" + "\n".join(errors)


class TestPackageJson:
    """package.json must have required metadata."""

    def test_has_name(self, package_json):
        assert "name" in package_json, "package.json missing 'name'"
        assert package_json["name"], "package.json 'name' is empty"

    def test_has_version(self, package_json):
        assert "version" in package_json, "package.json missing 'version'"
        assert re.match(r"^\d+\.\d+\.\d+", package_json["version"]), (
            f"Version '{package_json['version']}' doesn't follow semver"
        )

    def test_has_description(self, package_json):
        assert "description" in package_json, "package.json missing 'description'"
        assert len(package_json["description"]) > 10, "package.json 'description' too short"

    def test_has_min_logstream_version(self, package_json):
        assert "minLogStreamVersion" in package_json, (
            "package.json missing 'minLogStreamVersion'"
        )


class TestInputsSchema:
    """inputs.yml must have valid structure."""

    def test_has_inputs_key(self, inputs_yml):
        assert "inputs" in inputs_yml, "inputs.yml missing top-level 'inputs' key"

    def test_each_input_has_type(self, inputs_yml):
        for input_id, cfg in inputs_yml.get("inputs", {}).items():
            assert "type" in cfg, f"Input '{input_id}' missing 'type' field"

    def test_each_input_has_metadata(self, inputs_yml):
        for input_id, cfg in inputs_yml.get("inputs", {}).items():
            metadata = cfg.get("metadata", [])
            datatypes = [m for m in metadata if m.get("name") == "datatype"]
            assert datatypes, f"Input '{input_id}' missing datatype metadata"

    def test_file_inputs_have_path(self, inputs_yml):
        for input_id, cfg in inputs_yml.get("inputs", {}).items():
            if cfg.get("type") == "file":
                assert "path" in cfg, f"File input '{input_id}' missing 'path'"


# -- Tier 2: Security Exclusion Scanning -------------------------------------


class TestSecurityExclusions:
    """Sensitive paths must not be monitored."""

    FORBIDDEN_PATTERNS = [
        ".credentials.json", "settings.json", "settings.local.json",
        "security_warnings_state_", "debug/", "telemetry/",
        "paste-cache/", "file-history/", "backups/", "cache/",
    ]

    @pytest.mark.parametrize("pattern", FORBIDDEN_PATTERNS)
    def test_forbidden_pattern_not_in_inputs(self, pattern, inputs_text):
        for line in inputs_text.splitlines():
            stripped = line.strip()
            if not (stripped.startswith("path:") or stripped.startswith("filenames:")):
                continue
            assert pattern not in stripped, (
                f"Forbidden pattern '{pattern}' found in inputs.yml: {stripped}"
            )

    def test_no_plaintext_secrets_in_inputs(self, inputs_text):
        """inputs.yml must not contain hardcoded API keys or tokens."""
        secret_patterns = [
            # Quoted values: token: "abc123..."
            r"(?i)(api[_-]?key|token|password|secret)\s*[:=]\s*['\"][^$][^'\"]{8,}",
            # Unquoted YAML scalars: token: abc123... (excluding env-var refs)
            r"(?i)(api[_-]?key|token|password|secret)\s*:\s*(?!['\"\s$])([^\s#]{8,})",
        ]
        for pat in secret_patterns:
            match = re.search(pat, inputs_text)
            assert not match, f"Possible plaintext secret in inputs.yml: {match.group()}"


class TestSecuritySamples:
    """Sample data must use redaction markers, not real values."""

    SECRET_INDICATORS = [
        r"sk-[a-zA-Z0-9]{20,}",
        r"ghp_[a-zA-Z0-9]{36}",
        r"gho_[a-zA-Z0-9]{36}",
        r"xoxb-[0-9]{10,}",
    ]

    def test_sample_files_have_no_real_secrets(self, sample_json_files):
        if not sample_json_files:
            pytest.skip("No sample JSON files")
        errors = []
        for sf in sample_json_files:
            text = sf.read_text()
            for pat in self.SECRET_INDICATORS:
                if re.findall(pat, text):
                    errors.append(f"{sf.name}: possible real secret matching {pat}")
        assert not errors, "Sample files contain possible secrets:\n" + "\n".join(errors)


class TestSecurityVars:
    """Stream pack vars.yml must not contain plaintext secrets."""

    def test_encrypted_vars_not_plaintext(self, pack_dir, pack_type):
        if pack_type != "stream":
            pytest.skip("vars.yml check only for stream packs")
        vars_path = pack_dir / "vars.yml"
        if not vars_path.exists():
            pytest.skip("No vars.yml")
        data = yaml.safe_load(vars_path.read_text()) or {}
        if not isinstance(data, dict):
            pytest.fail("vars.yml must contain a mapping at the top level")
        for var in data.get("vars", []):
            name = var.get("id", "").lower()
            value = str(var.get("value", ""))
            is_sensitive = any(
                kw in name for kw in ["token", "key", "secret", "password", "pat"]
            )
            if (
                is_sensitive and value
                and not value.startswith("~{") and not value.startswith("$")
            ):
                if value.strip("'\"") not in ("changeme", ""):
                    pytest.fail(
                        f"Variable '{var.get('id')}' appears sensitive "
                        f"but value is not encrypted"
                    )


# -- Tier 3: Configuration Cross-Reference -----------------------------------

# Regex shared by route cross-reference tests
_INPUT_ID_RE = re.compile(r"__inputId\s*==\s*['\"](?:\w+):[\w-]+\.([\w-]+)['\"]")


class TestRouteCrossReference:
    """Route filters must reference valid input IDs."""

    BUILTIN_PIPELINES = {"main", "devnull", "passthru"}

    def test_route_filters_reference_valid_inputs(self, route_yml, inputs_yml):
        if not route_yml or not inputs_yml:
            pytest.skip("Missing route.yml or inputs.yml")
        input_ids = set(inputs_yml.get("inputs", {}).keys())
        for route in route_yml.get("routes", []):
            filt = route.get("filter", "")
            if not filt or route.get("disabled", False):
                continue
            match = _INPUT_ID_RE.search(filt)
            if match:
                ref_id = match.group(1)
                assert ref_id in input_ids, (
                    f"Route '{route.get('id')}' references input '{ref_id}' "
                    f"not found in inputs.yml. Valid: {sorted(input_ids)}"
                )

    def test_all_inputs_have_routes(self, route_yml, inputs_yml):
        """Every input should have at least one route (no orphaned inputs)."""
        if not route_yml or not inputs_yml:
            pytest.skip("Missing route.yml or inputs.yml")
        input_ids = set(inputs_yml.get("inputs", {}).keys())
        routed_ids = set()
        for route in route_yml.get("routes", []):
            match = _INPUT_ID_RE.search(route.get("filter", ""))
            if match:
                routed_ids.add(match.group(1))
        orphaned = input_ids - routed_ids
        assert not orphaned, f"Inputs without routes (orphaned): {sorted(orphaned)}"

    def test_route_pipelines_exist(self, route_yml, pack_dir):
        """Pipeline references in routes must point to existing files."""
        if not route_yml:
            pytest.skip("No route.yml")
        pipelines_dir = pack_dir / "pipelines"
        for route in route_yml.get("routes", []):
            pipeline = route.get("pipeline")
            if not pipeline or route.get("disabled", False):
                continue
            if pipeline in self.BUILTIN_PIPELINES:
                continue
            yml = pipelines_dir / f"{pipeline}.yml"
            conf = pipelines_dir / f"{pipeline}.conf.yml"
            assert yml.exists() or conf.exists(), (
                f"Route '{route.get('id')}' references pipeline "
                f"'{pipeline}' but {yml} not found"
            )


# -- Tier 4: Sample Data Validation ------------------------------------------


class TestSampleData:
    """Sample data files must be valid."""

    def test_sample_json_files_are_valid(self, sample_json_files):
        if not sample_json_files:
            pytest.skip("No sample JSON files")
        errors = []
        for sf in sample_json_files:
            text = sf.read_text().strip()
            if not text:
                continue
            # Try as a single JSON document first (pretty-printed)
            try:
                json.loads(text)
                continue
            except json.JSONDecodeError:
                pass
            # Fall back to JSONL (one JSON object per line)
            for i, line in enumerate(text.splitlines(), 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    json.loads(line)
                except json.JSONDecodeError as e:
                    errors.append(f"{sf.name}:{i}: {e}")
                    break
        assert not errors, "Invalid JSON in sample files:\n" + "\n".join(errors)
