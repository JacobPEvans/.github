# precommit — org-wide pre-commit shared layer

Single source of truth for pre-commit hook configuration across every
dryvist repo. Two consumption paths share these artifacts.

- **Nix flake module** — Repos with `flake.nix` + `.envrc` (terraform-*,
  ansible-*, nix-*, orbstack-kubernetes) consume
  `inputs.nix-devenv.flakeModules.{base,terraform,ansible,python,nix,markdown}`.
  Versions pinned via `flake.lock`.
- **Static YAML copy** — Repos without Nix (cribl packs, raw CI
  checkouts, external contributor clones) copy `templates/<profile>.yaml`
  at scaffold time. Renovate keeps `rev:` pins fresh.

Both paths reference the same canonical config files in `configs/` for
tools that demand a config file on disk (ansible-lint, yamllint, tflint).
Markdown lint config lives at the dryvist/.github root
(`../.markdownlint-cli2.yaml`) for backwards compatibility with existing
markdownlint workflow consumers.

## Layout

```text
precommit/
├── configs/
│   ├── ansible-lint.yml         # canonical .ansible-lint
│   ├── tflint.hcl               # canonical .tflint.hcl
│   └── yamllint.yml             # canonical .yamllint.yml
├── templates/
│   ├── base.yaml                # common 80% (no language-specific hooks)
│   ├── terraform.yaml           # base + terraform_fmt/validate/tflint/docs
│   ├── ansible.yaml             # base + ansible-lint + yamllint
│   └── python.yaml              # base + ruff + ruff-format + pyright + pytest
└── README.md
```

The markdownlint canonical (`.markdownlint-cli2.yaml`) stays at the
repo root — it predates this directory and is referenced by existing
consumer workflows. New canonical configs land here in `configs/`.

## Requirements

### Prerequisites & OS Requirements

- **Git**: Required for git-hook execution.
- **Node.js, Python, or Terraform**: Required depending on the specific profile
  configuration in use (e.g. Node for Biome/markdownlint, Python for Ruff/Mypy,
  Terraform for tflint).
- **OS Support**: Fully compatible with macOS and Linux.

### Optional Enhancements

- **Nix & direnv**: Highly recommended if consuming these pre-commit
  configurations via the Nix flake path.

## Installation

This directory is consumed by reference, not installed. Pick the path
that matches the consumer repo once.

### Add to a Nix-flake repo

No copy step needed. Add the `nix-devenv` flake input and one
`imports = [ ... ]` line in the consumer's `flake.nix` (see Usage).

### Add to a non-Nix repo

Fetch the matching template at scaffold time, plus the configs the
hooks need:

```bash
# Pick base / terraform / ansible / python
gh api repos/dryvist/.github/contents/precommit/templates/terraform.yaml \
  -H "Accept: application/vnd.github.raw" > .pre-commit-config.yaml

# Materialize tflint canonical (terraform profile only)
gh api repos/dryvist/.github/contents/precommit/configs/tflint.hcl \
  -H "Accept: application/vnd.github.raw" > .tflint.hcl

# Markdown lint config lives at the .github root
gh api repos/dryvist/.github/contents/.markdownlint-cli2.yaml \
  -H "Accept: application/vnd.github.raw" > .markdownlint-cli2.yaml

# Zizmor policy for workflow security
gh api repos/dryvist/.github/contents/zizmor.yml \
  -H "Accept: application/vnd.github.raw" > zizmor.yml

pre-commit install
```

For `ansible.yaml`, also fetch `precommit/configs/ansible-lint.yml`
to `.ansible-lint` and `precommit/configs/yamllint.yml` to
`.yamllint.yml`. `python.yaml` needs no extra configs, but its pyright +
pytest hooks run from the project venv (`.venv/bin`), so consumers must
`uv pip install -e ".[dev]"` (pyright, pytest, ruff in dev-deps) before
the hooks resolve. Tool versions come from `pyproject.toml`, not `rev:` pins.

## Usage

### Run hooks in a Nix-flake repo

In the consumer's `flake.nix`:

```nix
{
  inputs.nix-devenv.url = "github:dryvist/nix-devenv?ref=vN";
  inputs.flake-parts.url = "github:hercules-ci/flake-parts";

  outputs = inputs@{ flake-parts, nix-devenv, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "aarch64-darwin" "x86_64-linux" ];
      imports = [ inputs.nix-devenv.flakeModules.terraform ];
    };
}
```

Profile picks one of `{base, terraform, ansible, python, nix, markdown}`.
The module imports `dev-hygiene` (base hooks) and layers the matching
language hooks on top. No `.pre-commit-config.yaml` needed in the repo.

`base`, `nix`, and `markdown` are aliases for `dev-hygiene` — the base
already covers Nix lints (deadnix, statix) and markdownlint via
file-glob filtering. Repos pick one of those aliases for readability;
the runtime behavior is identical.

### Run hooks in a non-Nix repo

After running the Installation step above, hooks run automatically on
`git commit`. To run them ad-hoc:

```bash
pre-commit run --all-files
```

Renovate's custom manager in dryvist/.github keeps `rev:` pins in the
copied `.pre-commit-config.yaml` fresh going forward. Sync of the
config files themselves (`.tflint.hcl`, etc.) is still manual today —
extending the Renovate custom manager to cover them is tracked
separately.

## API

This directory exposes the following surfaces:

| Path | Purpose |
| --- | --- |
| `configs/ansible-lint.yml` | Canonical ansible-lint (production profile, fqcn + no-changed-when) |
| `configs/tflint.hcl` | Canonical tflint (terraform plugin, recommended preset, docs rules) |
| `configs/yamllint.yml` | Canonical yamllint (line-length 160 warn, octal forbidden, ansible-lint-compatible) |
| `templates/base.yaml` | Common-80% static `.pre-commit-config.yaml` for non-Nix consumers |
| `templates/terraform.yaml` | `base` plus terraform_fmt / validate / tflint / docs |
| `templates/ansible.yaml` | `base` plus ansible-lint + yamllint |
| `templates/python.yaml` | `base` plus ruff / ruff-format / pyright (commit) + pytest (pre-push) |

## Contributing

Adding a new profile means both paths stay in sync:

1. **Nix side** — add `flake-modules/profiles/<name>.nix` in
   [`dryvist/nix-devenv`](https://github.com/dryvist/nix-devenv) and
   expose `flakeModules.<name>` in its `flake.nix`. Validate with a
   smoke-test consumer under `tests/profile-modules/<name>/`.
2. **YAML side** — add `templates/<name>.yaml` here that mirrors the
   Nix profile's hook set.
3. Document both paths in this README's `Layout` section.

Profile hooks must stay in sync between the two paths. The Nix smoke
tests in `dryvist/nix-devenv` catch hook-name drift in git-hooks.nix;
no equivalent test exists for the YAML templates yet (a `pre-commit
dry-run` against a representative repo is the manual check).

### Canonical-config choices

- `configs/` holds files that tools demand on disk. Tools that accept
  all config via CLI args ship their canonical at the repo root (see
  `.markdownlint-cli2.yaml`).
- Each merged config picks the **most-common variant** from the
  inventory rather than the strictest superset, to minimize migration
  churn. Consumers add stricter rules locally until a critical mass
  agrees to lift them into the canonical.
- AWS / GCP / Azure tflint plugins stay opt-in per repo. Their
  rulesets are large and noisy on repos that don't target that cloud.
  The canonical `tflint.hcl` enables only the core terraform plugin.
- `bandit` and `detect-secrets` appear in one inventory repo each and
  are NOT in the python template. Repos that want them add a `repo:`
  block locally.
- `checkov` for terraform appears in three repos and is NOT in the
  terraform template. Run time dominates the hook cycle; consumers
  opt in locally via `pre-commit.settings.hooks.checkov.enable = true;`
  (Nix path) or a `repo:` block (YAML path).

## License

[Apache-2.0](../LICENSE) — inherited from the dryvist/.github root.
