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
        assert not errors, f"YAML parse errors:\n" + "\n".join(errors)


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
        assert len(package_json["description"]) > 10, (
            "package.json 'description' too short"
        )

    def test_has_min_logstream_version(self, package_json):
        assert "minLogStreamVersion" in package_json, (
            "package.json missing 'minLogStreamVersion'"
        )


class TestInputsSchema:
    """inputs.yml must have valid structure."""

    def test_has_inputs_key(self, inputs_yml):
        assert "inputs" in inputs_yml, "inputs.yml missing top-level 'inputs' key"

    def test_each_input_has_type(self, inputs_yml):
        for input_id, config in inputs_yml.get("inputs", {}).items():
            assert "type" in config, f"Input '{input_id}' missing 'type' field"

    def test_each_input_has_metadata(self, inputs_yml):
        for input_id, config in inputs_yml.get("inputs", {}).items():
            metadata = config.get("metadata", [])
            datatypes = [m for m in metadata if m.get("name") == "datatype"]
            assert datatypes, f"Input '{input_id}' missing datatype metadata"

    def test_file_inputs_have_path(self, inputs_yml):
        for input_id, config in inputs_yml.get("inputs", {}).items():
            if config.get("type") == "file":
                assert "path" in config, f"File input '{input_id}' missing 'path'"


# -- Tier 2: Security Exclusion Scanning -------------------------------------


class TestSecurityExclusions:
    """Sensitive paths must not be monitored."""

    FORBIDDEN_PATTERNS = [
        ".credentials.json",
        "settings.json",
        "settings.local.json",
        "security_warnings_state_",
        "debug/",
        "telemetry/",
        "paste-cache/",
        "file-history/",
        "backups/",
        "cache/",
    ]

    @pytest.mark.parametrize("pattern", FORBIDDEN_PATTERNS)
    def test_forbidden_pattern_not_in_inputs(self, pattern, inputs_text):
        for line in inputs_text.splitlines():
            stripped = line.strip()
            if not (
                stripped.startswith("path:") or stripped.startswith("filenames:")
            ):
                continue
            assert pattern not in stripped, (
                f"Forbidden pattern '{pattern}' found in inputs.yml: {stripped}"
            )

    def test_no_plaintext_secrets_in_inputs(self, inputs_text):
        """inputs.yml must not contain hardcoded API keys or tokens."""
        secret_patterns = [
            r"(?i)(api[_-]?key|token|password|secret)\s*[:=]\s*['\"][^$][^'\"]{8,}",
        ]
        for pat in secret_patterns:
            match = re.search(pat, inputs_text)
            assert not match, (
                f"Possible plaintext secret in inputs.yml: {match.group()}"
            )


class TestSecuritySamples:
    """Sample data must use redaction markers, not real values."""

    SECRET_INDICATORS = [
        r"sk-[a-zA-Z0-9]{20,}",  # Anthropic/OpenAI API keys
        r"ghp_[a-zA-Z0-9]{36}",  # GitHub PATs
        r"gho_[a-zA-Z0-9]{36}",  # GitHub OAuth tokens
        r"xoxb-[0-9]{10,}",  # Slack bot tokens
    ]

    def test_sample_files_have_no_real_secrets(self, sample_json_files):
        if not sample_json_files:
            pytest.skip("No sample JSON files")
        errors = []
        for sf in sample_json_files:
            text = sf.read_text()
            for pat in self.SECRET_INDICATORS:
                matches = re.findall(pat, text)
                if matches:
                    errors.append(
                        f"{sf.name}: possible real secret matching {pat}"
                    )
        assert not errors, (
            "Sample files contain possible secrets:\n" + "\n".join(errors)
        )


class TestSecurityVars:
    """Stream pack vars.yml must not contain plaintext secrets."""

    def test_encrypted_vars_not_plaintext(self, pack_dir, pack_type):
        if pack_type != "stream":
            pytest.skip("vars.yml check only for stream packs")
        vars_path = pack_dir / "vars.yml"
        if not vars_path.exists():
            pytest.skip("No vars.yml")
        text = vars_path.read_text()
        # Encrypted values in Cribl are wrapped in ~{...}~
        # Any var with "token", "key", "secret", "password" in the name
        # should either use ~{}~ encryption or reference an env var
        data = yaml.safe_load(text)
        for var in data.get("vars", []):
            name = var.get("id", "").lower()
            value = str(var.get("value", ""))
            is_sensitive = any(
                kw in name
                for kw in ["token", "key", "secret", "password", "pat"]
            )
            if (
                is_sensitive
                and value
                and not value.startswith("~{")
                and not value.startswith("$")
            ):
                # Allow "changeme" placeholder values
                if value.strip("'\"") not in ("changeme", ""):
                    assert False, (
                        f"Variable '{var.get('id')}' appears sensitive "
                        f"but value is not encrypted"
                    )


# -- Tier 3: Configuration Cross-Reference -----------------------------------


class TestRouteCrossReference:
    """Route filters must reference valid input IDs."""

    def test_route_filters_reference_valid_inputs(
        self, route_yml, inputs_yml, package_json
    ):
        if not route_yml or not inputs_yml:
            pytest.skip("Missing route.yml or inputs.yml")

        input_ids = set(inputs_yml.get("inputs", {}).keys())
        routes = route_yml.get("routes", [])

        for route in routes:
            filt = route.get("filter", "")
            if not filt or route.get("disabled", False):
                continue
            # Extract input ID from filter like:
            #   __inputId=='file:pack-name.input-id'
            #   __inputId=='open_telemetry:pack-name.input-id'
            match = re.search(
                r"__inputId\s*==\s*['\"](?:\w+):[\w-]+\.([\w-]+)['\"]", filt
            )
            if match:
                referenced_id = match.group(1)
                assert referenced_id in input_ids, (
                    f"Route '{route.get('id')}' references input "
                    f"'{referenced_id}' not found in inputs.yml. "
                    f"Valid inputs: {sorted(input_ids)}"
                )

    def test_all_inputs_have_routes(self, route_yml, inputs_yml):
        """Every input should have at least one route (no orphaned inputs)."""
        if not route_yml or not inputs_yml:
            pytest.skip("Missing route.yml or inputs.yml")

        input_ids = set(inputs_yml.get("inputs", {}).keys())
        routes = route_yml.get("routes", [])

        # Collect all input IDs referenced in route filters
        routed_ids = set()
        for route in routes:
            filt = route.get("filter", "")
            match = re.search(
                r"__inputId\s*==\s*['\"](?:\w+):[\w-]+\.([\w-]+)['\"]", filt
            )
            if match:
                routed_ids.add(match.group(1))

        orphaned = input_ids - routed_ids
        assert not orphaned, (
            f"Inputs without routes (orphaned): {sorted(orphaned)}"
        )

    # Cribl built-in pipelines that don't require a file on disk
    BUILTIN_PIPELINES = {"main", "devnull", "passthru"}

    def test_route_pipelines_exist(self, route_yml, pack_dir):
        """Pipeline references in routes must point to existing files."""
        if not route_yml:
            pytest.skip("No route.yml")

        pipelines_dir = pack_dir / "pipelines"
        routes = route_yml.get("routes", [])
        for route in routes:
            pipeline = route.get("pipeline")
            if not pipeline or route.get("disabled", False):
                continue
            # Built-in pipelines (main, devnull, passthru) don't need files
            if pipeline in self.BUILTIN_PIPELINES:
                continue
            # Pipeline "foo" -> pipelines/foo.yml
            pipeline_file = pipelines_dir / f"{pipeline}.yml"
            # Also accept pipeline conf files (some packs use .conf.yml)
            alt_file = pipelines_dir / f"{pipeline}.conf.yml"
            assert pipeline_file.exists() or alt_file.exists(), (
                f"Route '{route.get('id')}' references pipeline '{pipeline}' "
                f"but {pipeline_file} not found"
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
            # Try parsing as a single JSON document first (pretty-printed)
            try:
                json.loads(text)
                continue  # Valid JSON document
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
        assert not errors, (
            "Invalid JSON in sample files:\n" + "\n".join(errors)
        )
