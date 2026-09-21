# jevgraph reference: snapshot and result boundaries

Use this reference when a graph or Notion handoff needs field-level decisions.

Snapshots contain `schema_version: 1`, optional `snapshot_id`, `source_format`,
boolean `inventory_complete`, optional `inventory_scope`, and `pages`. A page
has a stable `id` or URL, `title`, `content`, `properties`, `tags`, `aliases`,
`kind`, membership metadata (`parent`, `database`, `data_source`), explicit
`links`, and `unsupported_features`. Each explicit link keeps `target`,
`relation`, `evidence`, and `source`.

The normalized graph keeps `pages`, explicit `edges`, `unresolved_links`,
`ambiguous_links`, and `unsupported_features`. Membership and search discovery
do not create semantic edges. Jev suggestions remain reviewable suggestions;
they never become observed edges automatically.

`inventory_complete: false`, truncation, permission warnings, unresolved links,
and ambiguous identities limit any conclusion. Search results alone do not
prove workspace completeness. Migration plans are proposals; a write workflow
must check the user's current authorization and verify the target before
writing.

For an existing MCP session, the concrete handoff is:

1. The caller uses its authorized MCP tools to fetch page content and
   properties, and optionally query data sources.
2. The caller writes the returned pages, relation evidence, IDs, warnings, and
   completeness metadata to a JSON snapshot in a private local directory,
   using a fresh non-symlink filename and mode `0600` (and `0700` for a newly
   created private directory). Refuse overwriting an existing path, including
   symlinks. These precautions apply to the caller or other tool creating the
   snapshot; the CLI cannot enforce them on an agent-created file. The CLI's
   own `--output` path has separate private-file and no-overwrite checks.
3. The caller runs `jevgraph audit --input snapshot.json`,
   `jevgraph search QUERY --input snapshot.json`, or
   `jevgraph place TEXT --input snapshot.json --offline`, using
   `node bin/jevgraph.js ...` from a local checkout or an already installed
   `jevgraph ...` command.

The CLI's `jevgraph notion snapshot` command is a separate REST path and
requires `NOTION_TOKEN` or `NOTION_API_TOKEN`; it cannot inherit MCP OAuth.
