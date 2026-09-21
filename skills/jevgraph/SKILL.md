---
name: jevgraph
description: Use jevgraph for evidence-preserving graph audits, retrieval, path analysis, migration proposals, and Notion snapshot handoffs.
---

# Jevgraph workflows

Use this skill when a task needs jevgraph inspection or retrieval over a local JSON/Markdown snapshot, a read-only Notion handoff, or a proposal for migration. Preserve the supplied snapshot as the source of truth and report evidence from page content, explicit links, and relation properties.

Run the CLI with `npx --yes --package=github:Emlembow/jevgraph jevgraph ...`,
or use `jevgraph ...` after `npm install --global github:Emlembow/jevgraph`.
In a local checkout, `node bin/jevgraph.js ...` also works. The CLI is
distributed from GitHub; do not assume its name is on the npm registry.

Choose the smallest command that answers the request:

- `jevgraph audit --input PATH` for deterministic structure and completeness findings.
- `jevgraph search QUERY --input PATH` for semantic retrieval; add `--offline` when lexical results are explicitly acceptable.
- `jevgraph place TEXT --input PATH` for a placement proposal without editing pages.
- `jevgraph traverse` or `connections` for directed paths and shared neighbors.
- `jevgraph migration-plan` for a proposal. Before a separate write workflow, check the user's current authorization and scope; a plan alone never grants permission.
- `jevgraph notion search` and `jevgraph notion snapshot` use the CLI's read-only REST path and require `NOTION_TOKEN` or `NOTION_API_TOKEN`.
- For an existing authorized MCP session, fetch content and properties, export a canonical JSON snapshot, then run ordinary `jevgraph search`, `audit`, or `place --input SNAPSHOT` commands; those local commands need no Notion token. The CLI does not inherit ChatGPT/Codex OAuth.

Semantic commands require `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`, or credentials saved through `jevgraph setup`. Never place keys in arguments, snapshots, prompts, logs, or generated artifacts. Use `jevgraph config` or `jevgraph doctor` for redacted diagnostics.

Semantic retrieval uses the bounded persistent cache by default; pass `--no-cache` for a fresh run or when filesystem cache access is not wanted.

Treat `inventory_complete: false`, unresolved links, ambiguous links, truncated content, and permission warnings as limitations on the result. Do not promote Jev suggestions into observed graph edges or infer workspace-wide completeness from search results. Offline lexical results require human review before semantic conclusions.

For field-level normalized schema, completeness rules, and the concrete MCP handoff, read [references/schema.md](references/schema.md) when the task needs it. The package README and docs remain useful when the local checkout is available; installed skills should use this bundled reference.
