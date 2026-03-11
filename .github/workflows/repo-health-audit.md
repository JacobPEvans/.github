---
description: "Daily repository health audit - CI failures, security alerts, stale PRs, policy violations"

on:
  schedule:
    - cron: '0 5 * * *'
  workflow_dispatch:

imports:
  - shared/repo-health-audit-config.md

permissions:
  contents: read
  issues: write
  pull-requests: read
  actions: read
  security-events: read

timeout-minutes: 15
---

# Repo Health Audit

{{#import shared/repo-health-audit-prompt.md}}
