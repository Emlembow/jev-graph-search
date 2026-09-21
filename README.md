# Jev Graph Search

**Find the right evidence in your agent's memory graph.**

A CLI and agent skill for searching local Markdown knowledge graphs and optional JSON snapshots with [Jev](https://docs.typesafe.ai/introduction). Results keep the original source passages and citations.

[Get started](#get-started) · [Obsidian and Logseq](#obsidian-and-logseq) · [Agent skill](#agent-skill) · [Documentation](#documentation)

![Tax-code benchmark: source recall without versus with Jev is 33.2% versus 73.2% at top 1, 53.5% versus 80.1% at top 3, and 63.9% versus 81.8% at top 5.](assets/readme/retrieval-quality.png)

**Better ranking, with a tradeoff.** On one 8,851-node tax-code graph, top-five source recall rose from **63.9% to 81.8%**. Median cold lookup increased from **190 to 323 ms**, and estimated output tokens increased **2.2%**. This is a retrieval-quality result, not a speed or token-saving claim.

<details>
<summary>What the chart measures</summary>

The September 21, 2026 benchmark used 120 reviewed questions: 104 answerable and 16 unanswerable. Both modes used the same 20-candidate shortlist, five-result limit, and 6,000-character result budget. Recall is the average fraction of required source passages retrieved across answerable questions. The top-1 and top-3 bars are prefixes of the same run.

The graph covers 205 sections of 26 U.S.C., Subchapter B, from [OLRC release 119-99](https://uscode.house.gov/download/releasepoints/us/pl/119/99/usc-rp@119-99.htm). The semantic run used TypeSafe `jev-1.13.0`. All queries completed without errors. Both modes returned results for all 16 unanswerable questions. This single test does not establish generated-answer accuracy or recursive traversal quality. The corpus and experiment tooling are kept outside this distribution.

</details>

## Get started

Requires **Node.js 20+** and npm. Git is needed for the example checkout and skill installation. No runtime dependencies.

Run the exact npm release:

```sh
npx --yes --package=jev-graph-search@0.2.1 jev-graph-search setup
```

Use **↑/↓ and Enter** to choose TypeSafe or OpenRouter, then paste your API key into the hidden prompt. Your key is saved in a private per-user configuration file, outside the graph.

Search a directory of Markdown files or an optional [JSON graph snapshot](docs/schema.md):

```sh
npx --yes --package=jev-graph-search@0.2.1 jev-graph-search search "Why did we choose this database?" --input ./ObsidianVault
```

For a persistent `jev-graph-search` command:

```sh
npm install --global jev-graph-search@0.2.1
jev-graph-search --help
```

The release workflow publishes exact package versions with npm trusted publishing and provenance. Pin the package version in automation so upgrades are deliberate.

<details>
<summary>Try the included example without a key</summary>

```sh
git clone --branch v0.2.1 --depth 1 https://github.com/Emlembow/jev-graph-search.git
cd jev-graph-search
node bin/jev-graph-search.js search "Why PostgreSQL?" --input examples/memory.json --offline
node bin/jev-graph-search.js audit --input examples/memory.json
```

`--offline` uses local lexical ranking. Remove it after setup to use Jev.

</details>

## Agent skill

```sh
npx skills add Emlembow/jev-graph-search --skill jev-graph-search
```

The [skill](skills/jev-graph-search/SKILL.md) teaches an agent how to retrieve evidence from local Markdown graphs or JSON snapshots, inspect links, and propose memory destinations. It invokes the CLI above. Skill installation does not configure API keys or read your files.

## Commands

After installing the CLI:

```sh
# Retrieve source passages from an Obsidian vault
jev-graph-search search "What did we decide?" --input ./ObsidianVault

# Propose where a new memory belongs
jev-graph-search place "We chose PostgreSQL for transactions" --input ./ObsidianVault

# Audit explicit structure; add --semantic for Jev suggestions
jev-graph-search audit --input ./ObsidianVault

# Follow existing links in an optional JSON snapshot without a provider key
jev-graph-search traverse --input snapshot.json --from PAGE_A --to PAGE_B
```

Search finds lexical candidates and bounded graph neighbors, then Jev reranks them. Exact source evidence is retained. `place` and migration commands propose changes; they do not write to your graph. Use `jev-graph-search --help` for all commands.

## Obsidian and Logseq

Point `--input` at a local Markdown directory. Obsidian vaults are read recursively, including nested folders. Logseq graphs are supported through their Markdown `pages/` and `journals/` files; database and Org-mode formats are outside this interface. Hidden paths and symbolic links are skipped. Jev Graph Search reads the graph and does not create a backup or export.

Common page metadata works in either graph style:

```markdown
---
aliases: [Database decision, PostgreSQL decision]
tags: [architecture, storage]
---
# Database decision

## Related
- [[Transactions]]
See also [Migration notes](../projects/migration-notes.md)
```

Top-level YAML `aliases` and `tags` lists, plus unindented Logseq `alias::` and `tags::` page-property lines, are indexed as page-level metadata. Indented block-property lines remain page content. Wikilinks and relative Markdown links become explicit graph evidence.

```sh
# Obsidian
jev-graph-search search "database decision" --input ./ObsidianVault --offline

# Logseq Markdown graph
jev-graph-search audit --input ./logseq-graph --offline
```

## Configuration

- Interactive setup: `jev-graph-search setup`.
- Environment setup: export `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`, then run `jev-graph-search setup --from-env` to persist it.
- Diagnostics: `jev-graph-search config` and `jev-graph-search doctor` show redacted configuration.
- Cache: semantic scores are cached; `--no-cache` requests fresh scores.
- Local search: `--offline` explicitly selects lexical ranking.

Keys are never accepted as command-line arguments. Saved credentials use a `0600` file inside a `0700` directory. [Storage and provider options →](docs/setup.md)

## Documentation

- [Local graph schema and Markdown inputs](docs/schema.md)
- [Provider setup and credential storage](docs/setup.md)

Jev ranks a bounded candidate set; it cannot recover missing candidates or prove that evidence is sufficient. Model suggestions are not observed graph links. Partial snapshots remain partial. The current default does not guarantee no-answer rejection.

## License

Currently **UNLICENSED**. No open-source license is granted.
