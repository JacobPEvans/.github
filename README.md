# dryvist/.github

Org-wide standards and inheritance hub for the [dryvist](https://github.com/dryvist)
GitHub organization. Contains AI assistant policy, lint/format config,
dependency-management config, security policy, and the org profile page.

This repo holds **only** vendor-agnostic org infrastructure. Cribl-specific
test harnesses and reusable workflows live in
[`dryvist/cc-edge-pack-template`](https://github.com/dryvist/cc-edge-pack-template).

## Requirements

### Prerequisites & OS Requirements

- **dryvist Organization**: This repository provides org-level configurations and templates designed for the `dryvist` GitHub organization.
- **tofu-github Configuration**: The organization configuration, permissions,
  and secrets (such as the release-please App credentials) are managed and
  provisioned by the [dryvist/tofu-github](https://github.com/dryvist/tofu-github)
  repository.
- **OS Compatibility**: Fully compatible with macOS and Linux environments.

### Optional Enhancements

- **Nix & direnv**: Recommended for automatic developer environment activation using the provided Nix flakes.

## Installation

This repo is consumed by reference, not installed. Other dryvist repos
inherit configs and policies via the mechanisms below.

Example Renovate configuration to inherit these presets:

```json
{
  "extends": ["local>dryvist/.github"]
}
```

| Inheritance mechanism | Where it shows up |
| --- | --- |
| GitHub auto-applied org files (`SECURITY.md`, `profile/README.md`) | Visible on every dryvist repo's Security tab + at <https://github.com/dryvist> |
| Renovate `extends` | Each repo: `["local>dryvist/.github"]` (resolves `default.json`); nix repos use `:renovate-nix`. This repo is the **master** |
| Biome config | Each repo carries a copy of `biome.jsonc` scaffolded from this repo; Renovate keeps it in sync |
| markdownlint config | Each repo carries a copy of `.markdownlint-cli2.yaml` from this repo; sync TBD (manual for now) |
| Pre-commit hooks (shared) | `precommit/` — Nix flake import or static YAML copy; see [`precommit/README.md`](precommit/README.md) |
| Default `.gitignore` | Each repo appends `configs/gitignore` into its `.gitignore` at scaffold; secrets + AI-local-state baseline; sync TBD (manual for now) |
| AI assistant policy | `CLAUDE.md` — read by Claude Code on every session |

## Usage

### Add the org standards to a new dryvist repo

For a new TS-based dryvist repo, copy the canonical configs from this repo:

```sh
# From the new repo's root (raw content via Accept header — no base64
# decoding, portable across macOS and Linux):
gh api repos/dryvist/.github/contents/biome.jsonc -H "Accept: application/vnd.github.raw" > biome.jsonc
gh api repos/dryvist/.github/contents/.markdownlint-cli2.yaml -H "Accept: application/vnd.github.raw" > .markdownlint-cli2.yaml
# Renovate: write a thin wrapper that inherits the org default preset. Do NOT
# copy this repo's renovate.json — that is dryvist/.github's own self-config.
# Nix repos: use "local>dryvist/.github:renovate-nix" instead.
printf '%s\n' '{ "$schema": "https://docs.renovatebot.com/renovate-schema.json", "extends": ["local>dryvist/.github"] }' > renovate.json
# Default .gitignore baseline (secrets + AI local state) — append, then de-dupe:
gh api repos/dryvist/.github/contents/configs/gitignore -H "Accept: application/vnd.github.raw" >> .gitignore
```

Then add the CI gate — for a markdown-only repo this is the entire caller:

```yaml
# .github/workflows/ci-gate.yml
name: CI Gate
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  gate:
    permissions: { contents: read, pull-requests: read, actions: write }
    uses: dryvist/.github/.github/workflows/_ci-gate.yml@<40-hex commit SHA> # vX.Y.Z
```

`markdown_lint` and `file_size` are on by default and `filters` defaults to
the markdown block; pass `with:` only for a `nix`/`python`/`ansible`/
`terraform` filter, a toggle (`nix_validate`, `python_ci`, `tofu_ci`,
`osv_scan`, …), or a `runner_label`. The header of `_ci-gate.yml` lists
every input.

If the repo is a Cribl pack, scaffold from
[`dryvist/cc-edge-pack-template`](https://github.com/dryvist/cc-edge-pack-template)
instead — the template already includes the canonical configs.

### Wire up release-please in a dryvist repo

Each repo needs `.release-please-manifest.json` + `release-please-config.json`
plus a thin caller workflow that delegates to the org-native reusable workflow:

```yaml
# .github/workflows/release-please.yml
name: Release Please
on:
  push:
    branches: [main, develop]
permissions: {}
jobs:
  release-please:
    permissions:
      contents: write
      pull-requests: write
    uses: dryvist/.github/.github/workflows/_release-please.yml@<40-hex commit SHA> # vX.Y.Z
    secrets:
      GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY: ${{ secrets.GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY }}
```

The reusable workflow leaves the release PR open for a person to merge. On
trunk repos it targets main and creates the tag and GitHub Release in the same
run. On git-flow repos it targets develop without creating a tag; after
promotion to main, the workflow creates the tag and GitHub Release.

Org-level prereqs (one-time, owner-handled) for the dryvist release App:

- `GH_ACTION_RELEASE_PLEASE_APP_ID` — App ID (org **variable**, numeric)
- `GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY` — App private key PEM (org **secret**)

### One-time GitHub App setup (owner-handled)

1. Locate the App owned by JacobPEvans (`https://github.com/settings/apps` or
   `https://github.com/organizations/JacobPEvans/settings/apps`).
2. Verify "Where can this GitHub App be installed?" is set to "Any account"
   (change + save if currently "Only on this account").
3. Visit the App's public install URL (`https://github.com/apps/<app-slug>/installations/new`)
   and install on the **dryvist** org with access to "All repositories".
4. Back in the App settings: copy the App ID; generate + download a private
   key `.pem` (cannot be re-downloaded).
5. Set the dryvist org variable and secret the workflow reads:

   ```sh
   gh variable set GH_ACTION_RELEASE_PLEASE_APP_ID --org dryvist --visibility all
   gh secret set GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY --org dryvist --visibility all < /path/to/private-key.pem
   ```

   Or via UI at <https://github.com/organizations/dryvist/settings/secrets/actions>.

## Calling the shared workflows

Callers pin each reusable workflow to a commit SHA, with the release tag as a trailing comment:

```yaml
uses: dryvist/.github/.github/workflows/_ci-gate.yml@<40-hex commit SHA> # vX.Y.Z
```

- Renovate updates the SHA and the version comment together, in one PR per consumer.
- Patch updates merge automatically after CI passes. Minor and major updates, and release PRs, are merged by a person.
- Nix, Ansible and OpenTofu git references use the floating major tag (`?ref=vN`). The lock file records the exact revision.
- Third-party actions in these workflows are pinned to full commit SHAs.

## API

This repo exposes the following inheritance surfaces:

| Path | Purpose |
| --- | --- |
| `CLAUDE.md` | AI assistant policy (read by Claude Code) |
| `biome.jsonc` | Canonical Biome lint + format config (code) |
| `.markdownlint-cli2.yaml` | Canonical markdownlint-cli2 config (`.md` files) |
| `default.json` | Shareable Renovate entry point consumers resolve via `extends: ["local>dryvist/.github"]` (config:recommended + master policy) |
| `renovate-nix.json` | Nix-manager opt-in variant of `default.json`; nix repos extend `["local>dryvist/.github:renovate-nix"]` |
| `renovate.json` | This repo's OWN Renovate self-config (consumes `default.json`) — not the shared preset |
| `renovate-presets.json` | Master Renovate policy: auto-merge, trusted orgs, custom managers |
| `renovate-grouping.json` | Master Renovate ecosystem-grouping rules |
| `precommit/` | Shared pre-commit layer (canonical lint configs + static YAML templates); see [`precommit/README.md`](precommit/README.md) |
| `zizmor.yml` | Org-wide zizmor workflow-security policy (referenced by the pre-commit `zizmor` hook) |
| `.github/workflows/_*.yml` | Reusable CI workflows, consumed via `uses: dryvist/.github/.github/workflows/<file>@<40-hex commit SHA> # vX.Y.Z` |
| `.github/workflows/{markdownlint,conventions-check,ai-review}.yml` | Org-wide Required Workflows; `tofu-github` rulesets inject them into every repo's PRs |
| `configs/` | Shared configs the reusable workflows fetch at runtime (e.g. `_markdown-lint`'s org-default fallback) |
| `configs/gitignore` | Org-default `.gitignore` baseline (secrets, credentials, TF state, AI-assistant local state); appended per repo at scaffold |
| `scripts/` | Shell helpers the reusable workflows sparse-checkout (`ci-gate-watchdog.sh`, `run-pip-audit.sh`) |
| repo-local `osv-scanner.toml` | Optional OSV config passed with `_osv-scan.yml`'s `config_file` input for repo-specific exceptions |
| `SECURITY.md` | Org-wide vulnerability reporting policy (auto-applied to every dryvist repo's Security tab) |
| `profile/README.md` | Org profile page at <https://github.com/dryvist> |

## Contributing

Changes here affect every dryvist repo. Tread carefully:

- Bump rules in `biome.jsonc` or `.markdownlint-cli2.yaml` cautiously — they cascade to every repo on next sync.
- Don't introduce vendor-specific (Cribl, etc.) content. That belongs in the relevant template repo.
- Conventional commits required (`feat:`, `fix:`, `chore:`, `docs:`).

To validate locally before pushing:

```sh
# Lint this repo's own code and markdown
npx -y @biomejs/biome check .
npx -y markdownlint-cli2 "**/*.md"
```

## License

[Apache-2.0](LICENSE).

## References

- [`JacobPEvans/.github`](https://github.com/JacobPEvans/.github) — to become a downstream consumer of this repo's presets (inversion pending)
- [`dryvist/cc-edge-pack-template`](https://github.com/dryvist/cc-edge-pack-template) — Cribl pack template
- [Biome configuration reference](https://biomejs.dev/reference/configuration/)
- [markdownlint-cli2 configuration](https://github.com/DavidAnson/markdownlint-cli2#configuration)
- [Renovate `extends` docs](https://docs.renovatebot.com/config-presets/)
- [release-please-action](https://github.com/googleapis/release-please-action)

## Ansible CI policy

The shared Ansible workflow implements changed-role selection and the required
Merge Gate contract.

- PRs into `develop` run lint, syntax and contract checks plus Molecule
  scenarios selected from changed paths.
- PRs into `main` use the same focused scenario selection and contract checks.
- Pushes to non-main branches use focused scenarios for the changed paths;
  pushes to `main` run the full suite after merge.
- Public pull-request CI stays on GitHub-hosted runners. Private repositories
  can select their approved private runner label.
- Every Molecule-relevant changed path must map to a scenario or to a caller
  contract running inside the same required `Merge Gate`. Declared full-matrix
  paths defer Molecule to the post-merge run on `main`; other unmapped paths
  fail selection instead of widening a PR to the full matrix. Caller workflow
  files, `requirements.yml`, and CI harness files can use scenario or
  caller-contract mappings. Unmapped CI harness files under `.github/` select
  no scenario; a caller runs the full set for one by mapping it into every
  scenario filter.
- A caller may use `molecule_contract_filters` (the reserved filter name is
  `contract_only`) only when its role-specific contract test runs inside that
  same `Merge Gate`; the caller's Molecule workflow still runs its contract
  suite.

`molecule_scenario_filters` remains caller-supplied because role-to-scenario
relationships differ by repository. Callers must map every relevant path to a
scenario or a caller contract before focused PR/branch checks can pass. The
private docs decision records the policy and runner measurements.
