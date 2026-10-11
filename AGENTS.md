---
skill-groups: [core, git]
---

# dryvist org standards (AI assistant policy)

Canonical AI-assistant guidance for the **dryvist** GitHub org. Applies to
every repo under <https://github.com/dryvist>. Repo-level `AGENTS.md` files
may extend or specialize, but **MUST NOT** contradict the rules below.

## Language policy: TypeScript everywhere

All code we write is **TypeScript** unless a runtime forces otherwise.
This includes:

- Test harnesses (Vitest)
- Custom GitHub Actions (`@actions/core` + TypeScript)
- CLIs and tools we author
- Scripts that ship as committed artifacts

Configs stay in their natural format: YAML for GitHub Actions workflows,
JSONC (`biome.jsonc`) where comments help, plain JSON where the consumer
demands it (e.g. `release-please-config.json`). Cribl pack content
(`default/`, `data/samples/`, `tests/fixtures/`) is JSON/YAML, not code.

**Rationale:** ecosystem alignment with our GitHub Actions, Cribl pack
expressions (which are JavaScript), and the broader 2026 dev ecosystem.
Python is not used for new dryvist work.

## Tooling baseline

| Concern | Tool | Notes |
| --- | --- | --- |
| Runtime | Node.js (current LTS) | `actions/setup-node@v4` in CI |
| Package manager | npm | Universal in CI; lockfile committed |
| Test runner | Vitest | Native ESM/TS; no `ts-jest` dance |
| Code lint/format | Biome | `biome.jsonc` in this repo; `lineWidth: 120` for JS/TS/JSON/CSS |
| Markdown lint | markdownlint-cli2 | `.markdownlint-cli2.yaml` in this repo; `MD013 line_length: 160` |
| Type check | `tsc --noEmit` | TypeScript strict mode in `tsconfig.json` |
| Release automation | release-please | Org-native — `.github/workflows/_release-please.yml` |
| Dependency updates | Renovate | Mastered here — presets in `renovate-presets.json` (extends nothing external) |

The canonical `biome.jsonc`, `.markdownlint-cli2.yaml`, and
`configs/file-size-defaults.yml` live in this repo. Repos copy biome/markdownlint
at scaffold time; periodic sync is handled by Renovate's custom manager (or
manual update for now — see the biome `customManagers` entry in
`renovate-presets.json`). File-size defaults are **not** copied — CI and
pre-commit load them from this repo via the shared checker script.

### File-size gate (org defaults + per-repo overrides)

Org-wide byte limits live in `configs/file-size-defaults.yml` and are enforced
by `scripts/check-file-sizes.sh` (called from `_file-size.yml`). **Do not add
a repo-root `.file-size.yml` unless the repo needs `extended`, `exempt`, or
`scan` overrides.** Never commit a `defaults:` block — that is global policy,
not a per-repo knob. Split large files rather than widening org defaults.

## Release-please (org-native)

Release-please is **org-native** to this repo: every dryvist repo calls the
reusable `.github/workflows/_release-please.yml` here, pinned to a commit SHA
(`@<40-hex commit SHA> # vX.Y.Z`), not a cross-account JacobPEvans workflow. It
opens the release PR and leaves it open for a person to merge, for every bump
type (patch, minor, or major). A dryvist
repo's `release-please.yml` caller forwards a single secret:

| dryvist org secret | Reusable workflow secret |
| --- | --- |
| `GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY` | `GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY` |

Auth is the dryvist release App: app-id from the `GH_ACTION_RELEASE_PLEASE_APP_ID`
org variable, private key from the `GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY` org
secret. The App must be installed on the org with Contents + Pull requests write.
(Owner sets these manually after installing the App; the agent should not attempt
to install it. See `README.md` for setup steps.)

### Canonical release config

The canonical `release-please-config.json` lives here at
`configs/release-please-config.json` (single source of truth, same model as
`biome.jsonc` / `.markdownlint-cli2.yaml`). Repos copy it; they only diverge when
they **must**, and such deltas are intentional, e.g.:

- `claude-code-plugins` adds `extra-files` to bump its many `plugin.json`
  versions.
- Pre-1.0 / beta repos (e.g. `nix-ai-server`) add `bump-minor-pre-major: true`
  so breaking changes stay in the `0.x` range instead of auto-jumping to `1.0`.

The reusable workflow also supports **config-free (non-manifest) mode** via its
inputs (`release-type` + blank `config-file`/`manifest-file`) for repos that need
no per-repo config at all; manifest mode (with the file above) is the default.
Do not hand-tweak a repo's `release-please-config.json` away from canonical
without a recorded reason.

## New repo checklist

A repo that skips any of these is *born ungoverned*: org rulesets still bind it
(they select every repo by name or custom property), but nothing else does.
Work through this in order when creating a dryvist repo.

1. **Create it with its custom properties.** A bare `gh repo create` is
   rejected in this org — repo creation must supply the org's custom
   properties, including the `gitflow` boolean. Set `gitflow` to match the
   branching model you actually intend; the `org-gitflow-*` rulesets bind on
   that property, not on the default branch.
2. **Add release automation.** A thin `.github/workflows/release-please.yml`
   calling `dryvist/.github/.github/workflows/_release-please.yml@<40-hex commit SHA> # vX.Y.Z` and
   forwarding `GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY`. Copy an existing caller
   verbatim rather than writing one. Manifest mode is the default and also
   needs `release-please-config.json` (copy `configs/release-please-config.json`
   from this repo), `.release-please-manifest.json`, and the `VERSION` file that
   config declares. Config-free mode (`release-type:` set, blank
   `config-file`/`manifest-file`) is a supported alternative and needs none of
   those files. **A repo with a release config but no caller releases nothing.**
3. **Governance is automatic.** [`tofu-github`](https://github.com/dryvist/tofu-github)
   governs every unarchived org repo by default (merge methods, auto-merge,
   branch deletion, Dependabot, the public-only secret-scanning block), and a
   new repo is adopted on the next apply. Its `config/repos.yml` holds
   per-repo overrides only; add an entry there only to override the defaults.
4. **Add the baseline files:** `LICENSE`, `AGENTS.md`, and a Nix dev-shell entry
   (`flake.nix` or a committed `.envrc`).
5. **Do not scaffold `.file-size.yml`.** Only add one when the repo genuinely
   needs `extended`, `exempt`, or `scan` overrides (see File-size gate above).
6. **Record any legitimate opt-out.** If a convention genuinely does not apply
   (a template that should not release, a state-only repo), add the repo to
   `conventions_exempt:` in `tofu-github`'s `config/repos.yml`, listing the specific
   check names to skip and why. Opt-outs are per check, never per repo — an
   exemption from releasing does not excuse a missing LICENSE.

Two checks watch this. `conventions-check.yml` here is written to run on PRs
org-wide via a required-workflow ruleset and annotate missing conventions
(warn-only unless the repo sets `CONVENTIONS_STRICT=true`) — but the only
dryvist ruleset carrying a `workflows` rule today is `docs-publisher`, which
requires `docs-publisher-provenance.yml` on the `docs` repo alone. So
`conventions-check.yml` (like `markdownlint.yml`) only runs where a repo calls
it; wiring an org-wide required workflow is a `tofu-github` change.
`repo-conventions-sweep.yml` runs
weekly, covers repos with no PR traffic, and upserts one tracking issue in this
repo.

The sweep reports **public repos only** — this repo is public, so its issues,
job summaries, and Actions logs are world-readable, and naming a private repo
there would publish private topology. Private repos appear as a count. To check
a private repo, run the same presence checks locally against a repo you can
already read; do not paste the result into any public artifact.

## Bot PRs merge themselves — never hand-merge one

Renovate PRs are merged by `.github/workflows/bot-pr-automerge-sweep.yml`, an
hourly deterministic backstop that re-derives eligibility from the GitHub API
(bot author, no `update:major` or `bump:minor` label, mergeable, checks green,
head commit past the soak: 48 h, or none for a first-party bump) and
squash-merges into the PR's own base branch. Renovate still tries to merge its
own PRs first; the sweep exists because it usually does not succeed, and the
gap was being filled by hand.

**Do not merge a bot PR yourself, and do not review one to unblock it.** A bot
PR the sweep will not merge is a defect in `renovate-presets.json` or in the
sweep's gates — fix it there so the next hundred PRs are covered too. Merging
one by hand fixes exactly one PR and hides the defect from the next agent. The
sweep fails its own run when a bot PR outlives the policy, which is the signal
that something needs fixing; record the follow-up in Vikunja, never a GitHub
issue.

## Master source of truth (no upstream inheritance)

`dryvist/.github` is the **master**: it extends no other repository's config.
Renovate policy lives here in `renovate-presets.json` + `renovate-grouping.json`;
reusable workflows are first-party. The dependency direction is inverted —
`JacobPEvans/.github` extends THIS repo's presets, not the reverse. (Flipping the
JacobPEvans side to `extends: github>dryvist/.github:renovate-presets` and deleting
its duplicate preset copies is a pending follow-up.)

## Scope of this repo

`dryvist/.github` is **org-wide infrastructure only**. It contains:

- AI assistant policy (this file)
- Org-wide tooling configs (`biome.jsonc`, `renovate.json`)
- Community health files GitHub auto-applies (`SECURITY.md`, `profile/README.md`)
- Caller workflow templates that wire up inherited reusable workflows

It does **NOT** contain anything vendor- or product-specific. Cribl pack
infrastructure lives in [`dryvist/cc-edge-pack-template`](https://github.com/dryvist/cc-edge-pack-template).
Future vendor packs (if any) get their own template repo — never `.github`.

## Workflow expectations

For every change in dryvist:

1. Refresh the repo and create a worktree before making changes: the root
   checkout stays on `main`; every change lives in
   `git worktree add "$PWD/.worktrees/<slug>" -b <type>/<slug>`.
2. Edits go through PRs — no direct commits to `main`.
3. CI must be green before merge. Use `gh pr checks --watch` to confirm.
4. Don't tag versions yourself; the user controls release timing.
5. Conventional commits (`fix:`, `feat:`, `chore:`, etc.) — release-please
   uses these to compute bumps.

Ansible CI callers use the shared policy in `README.md` and
`.github/workflows/_ansible-ci.yml`: pull requests and non-main pushes run
focused changed-role coverage; only a push to `main` after merge runs the full
Molecule matrix. Shared execution inputs, uncovered paths, and failed selectors
must keep the single required `Merge Gate` red until validation succeeds. A
caller may use `molecule_contract_filters` with the reserved key
`contract_only` only when every relevant file is covered by its contract and
the test runs in that same gate.

### Adding a new reusable workflow

A brand-new `_*.yml` lands in **its own PR first, with no wiring**. A
`uses: dryvist/.github/.github/workflows/_new-thing.yml@<40-hex commit SHA>`
reference names a commit that must already contain the file. A reference
added in the same PR as the file fails workflow **graph validation** before
any job runs ("workflow file issue", zero jobs, no `gate / Merge Gate` context
at all). This repo's own gate calls `./.github/workflows/_ci-gate.yml` by local
path. Merge the new file first, then pin the released commit in a second PR.

## When in doubt

- `dryvist/.github` is the master for org policy (Renovate presets, reusable
  workflows); it inherits nothing from `JacobPEvans/.github`.
- Read this repo's `biome.jsonc` for current lint/format rules.
- Read [`dryvist/cc-edge-pack-template`](https://github.com/dryvist/cc-edge-pack-template)
  for Cribl-specific test/build scaffolding.
- For release-please specifics, the org-native workflow's docstring at
  `.github/workflows/_release-please.yml` in this repo is authoritative.
