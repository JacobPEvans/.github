# Security Policy

## Reporting Vulnerabilities

To report a security vulnerability in any **dryvist** repository, use
[GitHub's private vulnerability reporting][private-vuln] on the affected
repository. Do not open a public issue for security vulnerabilities.

[private-vuln]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability

For critical vulnerabilities affecting multiple dryvist repositories, report
to this [.github repository](https://github.com/dryvist/.github/security/advisories/new).

## Dependency Trust

Renovate consumers use this repository's shared presets. Non-security dependency
PRs and updates to existing PRs are limited to Saturday and Sunday in
America/New_York. Security updates are handled by Dependabot per repository;
Renovate vulnerability alerts are disabled.

| Update | Stabilization | Review and merge |
| --- | --- | --- |
| Minor, patch, digest and pin updates | 7 days | Auto-merge after required checks pass |
| First-party updates, including majors | 7 days | Auto-merge after required checks pass |
| Trusted-org majors | 7 days | Human review with the dep:review label |
| Other majors | 30 days | Human review |

First-party packages are `JacobPEvans/**`, `JacobPEvans-*/**`, `dryvist/**`,
`jpe-*/**` and `vct-*/**`. Their GitHub Actions and reusable-workflow refs use
floating major tags such as `@v1`; a new major such as `v1` to `v2` opens on a
weekend and auto-merges after seven days and passing checks. Third-party actions
remain SHA-pinned with a released-version comment.

Nix repositories extend `github>JacobPEvans/.github:renovate-nix`. Renovate's
Nix manager maintains `flake.lock` in one weekend PR per repository and
auto-merges after required checks pass.

## Version Pinning

| Source | Strategy |
| --- | --- |
| First-party GitHub Actions and reusable workflows | Floating major tag (`@vN`) |
| Third-party GitHub Actions | Full commit SHA with a released-version comment (`# vX.Y.Z`) |
| Nix flake locks | Maintained by Renovate's Nix manager |
| npm packages | Lower-bound (`^x.y.z`) in `package.json`; lockfile committed |

The existing scanners remain in place. Renovate updates first-party major tags
and third-party action SHAs; zizmor checks action refs, CodeQL provides code
scanning on public repositories, and OSV-Scanner checks dependency
vulnerabilities.

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
