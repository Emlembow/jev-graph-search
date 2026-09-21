# Snapshot and graph schema

The CLI accepts a JSON snapshot or a directory of Markdown files. A normalized snapshot has this shape:

```json
{
  "schema_version": 1,
  "snapshot_id": "example",
  "source_format": "notion-rest",
  "inventory_complete": false,
  "inventory_scope": "supplied-pages",
  "pages": [
    {
      "id": "stable-id",
      "title": "Title",
      "url": "https://www.notion.so/example",
      "source_path": "optional/local.md",
      "source_kind": "notion",
      "content": "plain text or Markdown",
      "properties": {},
      "tags": [],
      "aliases": [],
      "kind": "page",
      "parent": null,
      "database": null,
      "data_source": null,
      "links": [
        {
          "target": "stable-target-id-or-url",
          "relation": "related",
          "evidence": "Relation property Related contains target",
          "source": "relation-property"
        }
      ],
      "unsupported_features": []
    }
  ]
}
```

`buildGraph` produces `pages`, `edges`, `unresolved_links`, `ambiguous_links`, and `unsupported_features`. Edges are created only from explicit links, relation properties, or explicit relationship sections. Parent/database/data-source membership remains metadata. Every edge retains source evidence and the source/target URLs where available.

Notion snapshots must declare `inventory_complete` as a boolean and each page must have a stable ID or URL. A search result by itself is discovery evidence, not a content snapshot. A bounded or partially authorized snapshot should remain incomplete and include scope or warning metadata. Duplicate IDs, unsupported schema versions, malformed pages, and unsafe numeric settings fail before graph analysis.

Local Markdown files receive deterministic IDs derived from relative source paths. Relative Markdown links resolve against their owning file before title or basename fallback. Duplicate titles are retained as ambiguous rather than silently selected.

Graph outputs are JSON by default. `--output FILE` writes the explicit artifact and does not mutate the input snapshot.

