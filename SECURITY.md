# Security Policy

## Reporting Vulnerabilities

To report a security vulnerability in any **dryvist** repository, use
[GitHub's private vulnerability reporting][private-vuln] on the affected
repository. Do not open a public issue for security vulnerabilities.

[private-vuln]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability

For critical vulnerabilities affecting multiple dryvist repositories, report
to this [.github repository](https://github.com/JacobPEvans/.github/security/advisories/new).

## Dependency Trust

Renovate consumers use this repository's shared presets. Every dependency
update opens in one grouped PR per repository on Saturday 12:00-15:59 UTC.
Security updates from Renovate vulnerability alerts open on Wednesday or
Saturday 12:00-15:59 UTC after a one-day stabilization hold.

| Update | Stabilization | Review and merge |
| --- | --- | --- |
| Minor, patch, digest and pin updates | 7 days | Auto-merge after required checks pass |
| First-party updates, including majors | None | Auto-merge after required checks pass |
| Trusted-org majors | 7 days | Auto-merge after required checks pass; the dep:review label adds the dependency review |
| Other majors | 30 days | Auto-merge after required checks pass |

First-party packages are `JacobPEvans/**`, `JacobPEvans-*/**`, `dryvist/**` and
`jpe-*/**`. Renovate hash-pins their GitHub Actions refs, with the release tag in
a trailing comment such as `# v1.2.3`, except `JacobPEvans/**` and
`JacobPEvans-personal/**` reusable workflows, which ride their `@vN` major tag. A
new major such as `v1` to `v2` opens on Saturday and auto-merges after passing
checks. Third-party actions remain SHA-pinned with a released-version comment.

Nix repositories extend `github>JacobPEvans/.github:renovate-nix`. Renovate's
Nix manager maintains `flake.lock` in one Saturday PR per repository and
auto-merges after required checks pass.

## Version Pinning

| Source | Strategy |
| --- | --- |
| First-party GitHub Actions and reusable workflows | Full commit SHA with a release tag comment (`# vX.Y.Z`); `@vN` is also accepted |
| Third-party GitHub Actions | Full commit SHA with a released-version comment (`# vX.Y.Z`) |
| Nix flake locks | Maintained by Renovate's Nix manager |
| npm packages | Lower-bound (`^x.y.z`) in `package.json`; lockfile committed |

The existing scanners remain in place. Renovate updates first-party and
third-party action SHAs; zizmor checks action refs, CodeQL provides code
scanning on public repositories, and OSV-Scanner checks dependency
vulnerabilities.

## Secret Management

- No production credentials are committed to git.
- Repo-level secrets configured via `gh secret set`.
- Org-level secrets (e.g., the GitHub App token for release-please) configured
  via `gh secret set --org dryvist`.

## Auditable Workflow Boundaries

Enterprise repos may reference this repo's reusable workflows by full commit
SHA with a release tag comment, or by `@vN`. To audit a specific workflow run, the resolved commit SHA is logged in the GitHub
Actions UI for that run.
