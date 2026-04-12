# Shared cspell Dictionaries

Org-wide spell-check configuration for all JacobPEvans repos. One source of truth,
imported at runtime via raw GitHub URL — no npm publishing required.

## Repository Structure

```text
cspell/
├── README.md                   # This file
├── base.json                   # Layer 3: org base config (imports + dict selection)
└── dicts/                      # Layer 2: custom org dictionaries
    ├── ai-llm.txt              # AI/LLM/agentic tooling
    ├── infrastructure.txt      # Proxmox, Splunk, Cribl, Ansible, Doppler, etc.
    ├── devtools.txt            # Linters, test runners, release automation
    ├── nix-ecosystem.txt       # Nix/NixOS/nix-darwin/flakes
    └── org.txt                 # Org identifiers & project names
```

## Architecture

Four layers, each covering a distinct concern:

| Layer | Covers | Location |
| --- | --- | --- |
| 1. Official `@cspell/dict-*` | Universal tech dicts (git, bash, k8s, terraform, python, etc.) | Consumer pre-commit `additional_dependencies` |
| 2. Org custom dictionaries | Gaps the official dicts miss (AI, infra, nix, org) | `cspell/dicts/*.txt` here |
| 3. Org base config | Wires layers 1+2 via `import` + `dictionaryDefinitions` | `cspell/base.json` here |
| 4. Repo local config | Layer 3 import + words unique to that repo | `.cspell.json` in each consumer |

## How to consume in a new repo

### 1. Minimal `.cspell.json`

> cspell auto-discovers both `cspell.json` and `.cspell.json`; this repo and the
> examples below use the dotfile form. Use whichever matches the consuming repo,
> but prefer `.cspell.json` for new repos.

```json
{
  "$schema": "https://raw.githubusercontent.com/streetsidesoftware/cspell/main/cspell.schema.json",
  "version": "0.2",
  "language": "en",
  "import": [
    "https://raw.githubusercontent.com/JacobPEvans/.github/main/cspell/base.json"
  ],
  "words": [
    "repo-specific-term-1",
    "repo-specific-term-2"
  ],
  "ignorePaths": [
    ".git",
    "node_modules",
    "*.lock",
    "LICENSE"
  ]
}
```

Only add to `words` if the term is truly unique to this repo. If the same term
shows up in 2+ repos, open a PR here instead.

### 2. `.pre-commit-config.yaml` with `additional_dependencies`

The pre-commit cspell hook runs `cspell-cli` in an isolated environment and
needs the official `@cspell/dict-*` npm packages installed there:

```yaml
- repo: https://github.com/streetsidesoftware/cspell-cli
  rev: v9.6.0
  hooks:
    - id: cspell
      name: Check spelling
      additional_dependencies:
        - '@cspell/dict-software-terms'
        - '@cspell/dict-aws'
        - '@cspell/dict-k8s'
        - '@cspell/dict-docker'
        - '@cspell/dict-terraform'
        - '@cspell/dict-shell'
        - '@cspell/dict-bash'
        - '@cspell/dict-python'
        - '@cspell/dict-typescript'
        - '@cspell/dict-node'
        - '@cspell/dict-npm'
        - '@cspell/dict-git'
        - '@cspell/dict-html'
        - '@cspell/dict-markdown'
        - '@cspell/dict-filetypes'
        - '@cspell/dict-companies'
        - '@cspell/dict-data-science'
        - '@cspell/dict-powershell'
```

This list MUST match the `import` array in `cspell/base.json`. When a package
is added or removed there, update this block in every consumer repo in the same
PR wave.

### 3. Verify

```sh
pre-commit run cspell --all-files
```

Zero tolerance for suppressing errors via ignore rules. Either fix the typo,
add the word to the appropriate shared dict in this directory, or add it to
the repo-local `words` array if it is genuinely unique.

## How to add a new org-wide term

1. Pick the right file in `cspell/dicts/` (AI, infra, devtools, nix, or org)
2. Add the term alphabetically within its section
3. Open a PR against this repo
4. Once merged, all consumer repos pick up the change on their next cspell run
   (raw URL imports are fetched fresh per invocation)

## How to add a new official `@cspell/dict-*` package

1. Add the `@cspell/dict-foo/cspell-ext.json` entry to `cspell/base.json`'s
   `import` array
2. Add `foo` to the `dictionaries` array in the same file
3. Update the `additional_dependencies` snippet in this README
4. Open a followup PR wave against all consumer repos to add
   `- '@cspell/dict-foo'` to their `.pre-commit-config.yaml`

## Why raw URL imports, not npm

cspell's `import` field accepts HTTPS URLs. When `base.json` is fetched via
URL, relative `path` entries in `dictionaryDefinitions` resolve relative to the
imported config's URL — so one URL reference pulls in the base config AND all
its `./dicts/*.txt` children automatically.

Benefits:

- **Zero publishing infrastructure** — no npm account, no release CI, no version bumps
- **Instant org-wide propagation** — merge to `.github/main` and every repo
  sees the new terms on the next run
- **One source of truth** — no drift between a published package and its source

Trade-offs:

- **Network-dependent** at check time — fine for pre-commit and CI, both of
  which already hit github.com constantly
- **No version pinning** — if this becomes a problem later, pin by replacing
  `main` with a git tag in the URL path. For example:
  `https://raw.githubusercontent.com/JacobPEvans/.github/v1.0.0/cspell/base.json`
  (raw.githubusercontent.com accepts any branch, tag, or commit SHA as the ref
  segment — no `@` prefix)
