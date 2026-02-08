# AI Assistant Configuration Templates

Reusable templates for GitHub Copilot and Gemini Code Assist.

## Quick Start

**For any repo**: Copy these files and customize for your project:

1. **`.github/copilot-instructions.md`** - Code review standards (inline, ~200 lines)
2. **`.gemini/config.yaml`** - Gemini configuration (minimal, ~15 lines)
3. **`.gemini/styleguide.md`** - Coding style guide (inline, ~200 lines)

**For repos with agentsmd/ structure** (like ai-assistant-instructions):

See ai-assistant-instructions repo for symlink patterns. Symlink to agentsmd/ files instead of copying inline content.

## Template Files

Copy from ai-assistant-instructions repo:

- `agentsmd/docs/code_review_instructions.md` → Your `.github/copilot-instructions.md`
- `agentsmd/rules/styleguide.md` → Your `.gemini/styleguide.md`
- `agentsmd/rules/code-standards.md` → Reference for logging format and security patterns

Customize for your project's language and conventions.

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
