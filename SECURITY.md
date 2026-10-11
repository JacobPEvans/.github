# Security Policy

## Reporting Vulnerabilities

To report a security vulnerability in any **dryvist** repository, use
[GitHub's private vulnerability reporting][private-vuln] on the affected
repository. Do not open a public issue for security vulnerabilities.

[private-vuln]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability

For critical vulnerabilities affecting multiple dryvist repositories, report
to this [.github repository](https://github.com/dryvist/.github/security/advisories/new).

## Dependency Trust

Automated dependency updates use Renovate via this repo's master presets
([`renovate-presets.json`](renovate-presets.json) + [`renovate-grouping.json`](renovate-grouping.json)).
Third-party minor/patch updates auto-merge publisher-agnostically; trust tiers gate only
majors and PR-creation cadence. `dryvist/**` patch updates auto-merge; `dryvist/**` minor
and major updates wait for a person. Canonical, fuller documentation:
[docs.jacobpevans.com/infrastructure/cicd/dependency-automation](https://docs.jacobpevans.com/infrastructure/cicd/dependency-automation).

| Tier | Scope | PR-creation cadence | Majors |
| --- | --- | --- | --- |
| **First-party** | `dryvist/**` | at any time | wait for a person (minor too; patch auto-merges) |
| **Own-org personal** | `JacobPEvans/**`, `JacobPEvans-personal/**` | at any time | auto-merge immediately, incl. major |
| **Trusted** | curated ~50-org allowlist | twice-weekly (Mon/Thu) | never auto-merge; 3-day review PR (`dep:review`) |
| **Untrusted** | all other external deps | weekly (Mon) | never auto-merge; held 30 days for review |
| **Security / CVE** | any vulnerability alert | immediate (0-day PR) | third-party minor/patch and `dryvist/**` patch auto-merge fast; majors open for review |

**Third-party minor/patch updates auto-merge publisher-agnostically** — any package, any
ecosystem, any publisher — after a 3-day stabilization window and green CI. Trust tiers
do not gate third-party minor/patch; they gate only majors and PR-creation cadence.

- **First-party** — our own published `dryvist/**` packages. release-please opens a release PR and
  a person merges it. Consumers receive a first-party release as a bump PR: patch
  releases auto-merge after green CI; minor and major releases wait for a person.
- **Own-org personal** — `JacobPEvans/**` and `JacobPEvans-personal/**` packages auto-merge
  immediately at any update type, including major.
- **Trusted** — the curated org allowlist in `renovate-presets.json` (actions, google,
  github, hashicorp, astral-sh, NixOS, …). Trust here shortens the major-default
  30-day hold to a 3-day review PR (`dep:review` label); it has no effect on
  third-party minor/patch, which auto-merges the same way for every third-party tier.
- **Untrusted** — everything else. Minor/patch still auto-merges through the same
  publisher-agnostic rule; the only differences are a weekly (vs twice-weekly)
  PR-creation cadence and the full 30-day hold before a major opens for review.
- **Majors never auto-merge, except own-org personal packages** — a compatible-looking
  version is not a compatible API. `dryvist/**` majors wait for a person; trusted-org majors
  open a 3-day review PR; every other major is held 30 days.
- **Security / CVE** — `vulnerabilityAlerts` surfaces a 0-day PR immediately, bypassing
  the normal schedule. The auto-merge decision then falls to the same packageRules as
  any other update: a third-party security minor/patch inherits the broad rule's fast
  auto-merge, a `dryvist/**` security patch auto-merges after green CI, while a security
  major, or a `dryvist/**` security minor, still opens for review like any other.
- **Supply-chain safety** for the broad auto-merge set is the deterministic
  `dependency-review` job (`actions/dependency-review-action`) inside the required
  Merge Gate on public repos. The `dryvist/ai-workflows` dependency reviewer is
  advisory only — it labels findings for human follow-up but does not gate or block
  auto-merge.

All third-party GitHub Actions — trusted orgs included — and all dryvist
reusable workflows are pinned to SHA digests, not tags (see Version Pinning
below).

## Version Pinning

| Source | Strategy |
| --- | --- |
| dryvist reusable workflows (`uses:`) | Commit SHA pin + released version tag as a trailing comment (`# vX.Y.Z`); Renovate bumps both together |
| dryvist Nix, Ansible and OpenTofu git refs | Floating major tag (`?ref=vN`); the lock file holds the exact revision |
| All third-party GitHub Actions | SHA commit hash pins + released version tag as a trailing comment (`# v4.2.2`); Renovate bumps both together |
| npm packages | Lower-bound (`^x.y.z`) in `package.json`; lockfile committed |

Patch updates to dryvist references merge automatically after CI passes.
Minor and major updates, and release-please PRs, are merged by a person.
Floating major tags (`vN`) move on release, after the Canary check passes.
On a pull request that changes only Markdown outside `.github/` and
`tests/canary/`, the Canary check passes with a notice and runs no stacks.
They serve the Nix, Ansible and OpenTofu git refs only.

Trust tiers govern *review cadence for majors* (above), never the pin style:
there is no semver-tag allowance for trusted actions. Non-`uses:` pins that
Renovate cannot infer from context carry an explicit
`# renovate: datasource=… depName=… versioning=…` tag.

### Scanner posture for dryvist SHA pins

`dryvist/*` reusable workflows are referenced by commit SHA. Each scanner
handles that pin by the most native means available — no reinvented config
files:

| Scanner | How `dryvist/*` SHA pins are handled |
| --- | --- |
| **Renovate** | Updates the SHA and the `# vX.Y.Z` comment together; patch updates auto-merge, minor and major updates do not. |
| **zizmor** | `unpinned-uses` policy `dryvist/*: ref-pin` in `zizmor.yml`. |
| **CodeQL** | Code scanning default setup on public repos (free), managed as IaC in dryvist/tofu-github (per-repo, pending the provider resource). |
| **OSV-Scanner** | N/A — OSV reports dependency vulnerabilities, not ref-pinning. |

Untrusted/external actions are unaffected and remain SHA-pinned. Code scanning is
enabled on **public repos only** — the 11 private repos are excluded to avoid
the paid GitHub Code Security per-committer charge. Flagging same-org branch
references is a known CodeQL false positive ([codeql#18316]); those alerts are
dismissed natively in the code scanning UI rather than suppressed by a committed
file.

[codeql#18316]: https://github.com/github/codeql/issues/18316

## Secret Management

- No production credentials are committed to git.
- Repo-level secrets configured via `gh secret set`.
- Org-level secrets (e.g., the GitHub App token for release-please) configured
  via `gh secret set --org dryvist`.

## Auditable Workflow Boundaries

Dryvist repos reference this repo's reusable workflows by commit SHA. The SHA in
a caller's `uses:` line names the exact workflow version that runs. If you need
to audit a specific workflow run, the resolved SHA is logged in the GitHub
Actions UI for that run.
