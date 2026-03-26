# Security Policy

## Reporting Vulnerabilities

To report a security vulnerability, use
[GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on the affected repository. Do not open a public issue for security vulnerabilities.

For critical vulnerabilities affecting multiple repositories, report to the
[.github repository](https://github.com/JacobPEvans/.github/security/advisories/new).

## Dependency Trust Tiers

All automated dependency updates follow a tiered trust model enforced by
[Renovate](https://docs.renovatebot.com/) via `renovate-presets.json`:

| Tier | Scope | Stabilization | Auto-merge | Rationale |
| ------ | ------- | --------------- | ------------ | ----------- |
| **Always Trusted** | `JacobPEvans/**` (self-owned repos) | 0 days | Yes, CI-gated | Full code review and commit signing control |
| **Trusted, Wait** | GitHub Actions, Terraform, PyPI, pre-commit hooks | 3 days | Minor/patch auto; major manual | Established orgs; strong security posture |
| **Trusted Nix** | `NixOS/*`, `nix-community/*`, `cachix/*`, `DeterminateSystems/*` | 3 days | Yes, CI-gated | Community-monitored, commit-pinned (immutable) |
| **Default** | All other external dependencies | 3 days | No | Requires manual review before merge |

### Version Pinning Strategy

| Source | Strategy |
| -------- | ---------- |
| JacobPEvans self-references | `@main` or major version tag — never SHA or minor/patch pins |
| Trusted GitHub Actions | Semantic version tags (e.g., `@v6`) |
| External/untrusted GitHub Actions | SHA commit hash pins |
| Nix flake inputs | Branch-pinned to stable releases (e.g., `nixpkgs-25.11-darwin`) |
| Python packages (pyproject.toml) | Lower-bound with `>=`, managed by Renovate with 3-day soak |
| Python tool installs (uv) | Exact pin with `==`, managed by Renovate custom regex |

## Dependency Update Vectors

Dependencies enter the ecosystem through multiple channels. Each has different
protections:

### Renovate PRs (Managed)

Primary update mechanism. Enforces stabilization delays, CI gates, and repository
rulesets before merge. All repos extend the centralized `renovate-presets.json`.

### `/flake-rebuild` Command (Managed)

The approved method for manually updating Nix flake inputs. Enforces:

- Feature branch isolation (never commits to main)
- Quality validation (fmt, statix, deadnix, flake check, darwin-rebuild)
- CI gating via auto-merge (all required status checks must pass)

**Warning**: Running raw `nix flake update && darwin-rebuild switch` bypasses all
protections. Workflow rules forbid committing directly to main, which mitigates
but does not eliminate local execution risk.

### Homebrew (`brew autoupdate`) — Accepted Risk

Homebrew packages have NO version pinning in nix-darwin configuration and NO
Renovate tracking (Renovate cannot manage Homebrew in Nix files). The `brew
autoupdate` LaunchAgent runs every 30 hours.

**Why this is accepted**: Homebrew-core has significantly more review rigor than
PyPI or npm. All formulae are open-source and community-reviewed. Bottles are
built by Homebrew's CI infrastructure, not package authors. Supply-chain
compromises in homebrew-core are extremely rare.

### `uv tool install` in Activation Scripts (Managed)

Python tools installed during `darwin-rebuild switch` are pinned to exact
versions (`==`) and tracked by Renovate via custom regex managers. Updates go
through the standard 3-day stabilization pipeline.

## Security Scanning

| Tool | Scope | Integration |
| ------ | ------- | ------------- |
| **CodeQL** | GitHub Actions YAML | `codeql.yml` (org-wide) |
| **pip-audit** | Python dependency CVEs | `_python-security.yml` (reusable workflow) |
| **OSV Scanner** | Multi-ecosystem lockfile CVEs | `_osv-scan.yml` (reusable workflow) |
| **Daily Malicious Code Scan** | Pattern-based threat detection | Copilot agent (per-repo) |
| **Zizmor** | GitHub Actions security linting | Pre-commit hook |

## Incident Response — Supply-Chain Attacks

### Detection

- GitHub Advisory Database alerts (via Renovate `vulnerabilityAlerts`)
- CodeQL and OSV Scanner findings in CI
- Daily malicious code scan alerts
- Community notification (mailing lists, social media, CVE databases)

### Immediate Response (within 1 hour)

1. Identify all repos consuming the compromised package
2. Check Renovate PR history — was a compromised version offered or merged?
3. Check `flake.lock` timestamps — did a manual update pull it?
4. Check `uv tool list` — is the compromised version installed locally?

### Containment

- Add version constraint to block compromised versions (e.g., `!=bad.version`)
- If Nix flake input: pin to known-good commit hash temporarily
- If `uv tool install`: downgrade to last known-good version with `==`
- Clear local caches: `uv cache clean <package>`

### Verification

- Run `nix flake metadata` to confirm pinned revisions
- Check `uv tool list` for installed versions
- Audit CI logs for the affected time window
- Check for IOCs specific to the attack

### Recovery

- Update to patched version when available
- Remove temporary pins and constraints
- Document incident in a GitHub Discussion for future reference

## Accepted Risks

### nix-devenv uses `nixpkgs-unstable`

Intentional. Dev shells need latest tool versions (terraform, ansible, kubectl).
nix-devenv is never consumed by nix-darwin at build time — it provides independent
`nix develop` entry points outside the system build graph.

### Nix Flake Alignment (`follows` Pattern)

nix-darwin uses `inputs.nixpkgs.follows` to force companion repos (nix-ai,
nix-home) to use the same nixpkgs at build time, regardless of their own
`flake.lock`. This means flake.lock drift between repos is cosmetic for the
system build but matters for standalone development and CI.
