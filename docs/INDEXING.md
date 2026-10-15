# Indexing Pipeline

Covers collection management and the `qmd index` / `qmd collection add` workflow.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the overall system map.

## Config Storage

Collections are stored in two places kept in sync:

- **YAML file:** `~/.config/qmd/index.yml` (primary source of truth for humans)
- **SQLite tables:** `store_collections` + `store_config` (runtime source of truth)

`syncConfigToDb()` in `src/store.ts` syncs YAML → SQLite on startup (hash-based, no-op when unchanged).

## Collection CRUD — `src/collections.ts`

| Function | Description |
|----------|-------------|
| `addCollection(name, path, pattern, section?)` | Add or update a collection entry |
| `removeCollection(name)` | Remove by name |
| `renameCollection(oldName, newName)` | Rename without losing files |
| `listCollections()` | Return all collections from config |
| `getDefaultCollections()` | Collections with `includeByDefault: true` |

**Per-collection YAML shape:**
```yaml
collections:
  docs:
    path: /path/to/docs
    pattern: "**/*.md"        # glob mask
    ignore: ["Sessions/**"]   # exclusions
    update: "git pull"        # optional pre-index command
    includeByDefault: true
    section:
      heading: "Notes"        # restrict to this heading
      level: 2
```

## Reindex Pipeline — `src/store.ts`

Entry point: `reindexCollection(db, collectionName, opts?)`

Steps:

1. **Filesystem scan** — glob files matching `pattern`, apply `ignore` rules
2. **Content hash** — SHA-256 of file content; identical content deduplicates via `content` table
3. **Change detection** — skip files whose hash matches the existing DB row
4. **Metadata extraction** — for new/changed files:
   - `src/parse/frontmatter.ts`: YAML frontmatter → title, dates, custom fields
   - `src/parse/structure.ts`: headings, callouts, wikilinks
5. **DB writes** (per document):
   - `documents` — file registry row (upsert)
   - `content` — raw text (content-addressable, shared across identical files)
   - `documents_fts` — FTS5 index upsert (columns: filepath, title, aliases, description, body)
   - `frontmatter` — key/value rows (arrays exploded to multiple rows)
   - `doc_profiles` — the document's `aliases`/`alias` and `description`/`summary` frontmatter text (see below)
   - `sections` — one row per heading-delimited section
   - `tags` — denormalized tag rows
   - `callouts` — Obsidian-style callout blocks
   - `wikilinks` — `[[target]]` links
6. **Orphan cleanup** — `cleanupOrphanedContent()` removes `content` blobs with no active `documents` referencing them; marks deleted files as `active = false`

**Metadata with a `section` filter:** when a collection indexes only one heading's section, `content`/FTS body/chunks come from that section, but `frontmatter`, `tags` and `doc_profiles` are still parsed from the **whole file**. A frontmatter-only edit doesn't change the content hash, so it is picked up on the next `qmd index` (metadata is rewritten for unchanged files) and the profile vector is re-embedded on the next `qmd embed` when its text changed.

**Profiles** (`src/store/profiles.ts`): `aliases`/`alias` and `description`/`summary` frontmatter keys (case-insensitive) are copied into `doc_profiles`, indexed in their own FTS columns (bm25 weights: filepath 1.5, title 4, aliases 3, description 1.5, body 1) and embedded as one extra vector per document (see [EMBEDDING.md](EMBEDDING.md)). Older databases get the new FTS columns via a rebuild at startup; run `qmd index` to fill them.

**Key helpers:**
- `insertDocument()` — write/upsert document registry row
- `upsertDocumentMetadata()` — write frontmatter, sections, tags, callouts, wikilinks
- `cleanupOrphanedContent()` — remove stale content blobs

## Context Management — `src/collections.ts` + `src/store.ts`

Contexts annotate paths so search results carry relevant background for the LLM.

| Function | Location | Description |
|----------|----------|-------------|
| `addContext(collection, pathPrefix, text)` | `collections.ts` | Add/update context for a path prefix |
| `removeContext(collection, pathPrefix)` | `collections.ts` | Remove context |
| `setGlobalContext(text)` | `collections.ts` | Context applied to all collections |
| `listAllContexts()` | `collections.ts` | All contexts across all collections |
| `findContextForPath(collection, filePath)` | `collections.ts` | Longest-prefix match → context string |
| `getContextForFile(db, virtualPath)` | `store.ts` | DB-side context lookup used at query time |

**Resolution order:** longest matching path prefix wins. `/` is the global fallback.

**Sync:** CLI writes to both YAML and SQLite (`updateStoreContext()` in `store.ts`).

## Document IDs

Each document gets a docid = first 6 hex chars of its content SHA-256 hash.
Docids are stable as long as content doesn't change and are shown in search results as `#abc123`.
