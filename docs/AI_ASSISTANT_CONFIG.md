# AI Assistant Configuration Templates

Reusable templates for GitHub Copilot and Gemini Code Assist.

## Quick Start

**For any repo**: Create these files and customize for your project:

1. **`.github/copilot-instructions.md`** - Code review standards (~200 lines, sourced from ai-assistant-instructions repo)
2. **`.gemini/config.yaml`** - Gemini configuration (~15 lines, minimal template below)
3. **`.gemini/styleguide.md`** - Coding style guide (~200 lines, sourced from ai-assistant-instructions repo)

**For repos with agentsmd/ structure** (like ai-assistant-instructions):

Symlink to agentsmd/ files instead of copying. See ai-assistant-instructions repo for symlink patterns.

## Template Sources

Copy from the `ai-assistant-instructions` repo and customize for your project:

- `agentsmd/docs/code_review_instructions.md` → Your `.github/copilot-instructions.md`
- `agentsmd/rules/styleguide.md` → Your `.gemini/styleguide.md`
- `agentsmd/rules/code-standards.md` → Reference for logging format and security patterns

For `.gemini/config.yaml`, use the minimal template below (not sourced from ai-assistant-instructions).

## Minimal Template: .gemini/config.yaml

```yaml
code_review:
  comment_severity_threshold: MEDIUM
  pull_request_opened:
    summary: true
    code_review: true

ignore_patterns:
  - "node_modules/**"
  - ".git/**"
  - "*.log"
  - ".tmp/**"
```

Add project-specific ignore patterns (terraform, venv, `__pycache__`, etc.) as needed.

## Official Documentation

- [GitHub Copilot Instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions)
- [Gemini Code Assist](https://developers.google.com/gemini-code-assist/docs/customize-gemini-behavior-github)
