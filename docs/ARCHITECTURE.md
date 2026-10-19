# QMD Architecture Overview

This document is the entry point for navigating the qmd codebase. For deep dives into each subsystem, see the linked docs below.

## Data Flow

```
Filesystem → [INDEXING] → SQLite metadata + FTS
                ↓
            [EMBEDDING] → sqlite-vec vectors
                ↓
            [QUERYING]  → ranked results
                ↓
            [RETRIEVAL] → rendered document body
```

## Source File Map

| File | Responsibility |
|------|----------------|
| `src/store/` | Central DB layer — re-exported via `src/store.ts` shim. Submodules: `config`, `paths`, `db-schema`, `cache`, `chunking`, `documents`, `search-fts`, `search-vec`, `search-hybrid`, `indexing`, `retrieval`, `factory`, and more |
| `src/collections.ts` | YAML config CRUD for collections and contexts |
| `src/llm.ts` | node-llama-cpp wrapper: embed, rerank, query expansion; lazy-load + auto-unload |
| `src/ast.ts` | AST-aware chunking via tree-sitter (TS, JS, Python, Go, Rust) |
| `src/cli/qmd.ts` | CLI entry point: thin dispatcher — re-exports `buildEditorUri`/`termLink` for test compatibility |
| `src/cli/store-access.ts` | Singleton store, DB lifecycle, model resolution, `resyncConfig` |
| `src/cli/utils.ts` | Colors, cursor, progress bar, format helpers |
| `src/cli/args.ts` | `parseCLI`, `normalizeArgv`, output option types |
| `src/cli/uri.ts` | `buildEditorUri`, `termLink` |
| `src/cli/commands/` | One file per command group: `status`, `context`, `get`, `collection`, `index-cmd`, `search`, `export` ([EXPORT.md](EXPORT.md)), `misc` |
| `src/mcp/server.ts` | MCP server (stdio + HTTP transports) |
| `src/db.ts` | SQLite abstraction; loads sqlite-vec extension |
| `src/index.ts` | Public SDK entry point |
| `src/parse/frontmatter.ts` | YAML frontmatter extraction |
| `src/parse/structure.ts` | Document structure parsing (headings, callouts, wikilinks) |
| `src/query/parser.ts` | fsearch DSL parser |
| `src/query/lexer.ts` | DSL tokenizer |
| `src/query/compile.ts` | Compiles parsed DSL to SQLite predicates |
| `src/maintenance.ts` | Database maintenance helpers |

## SQLite Schema Summary

**Content & Search:**
- `documents` — file registry (id, collection, path, hash, title, dates, active)
- `content` — content-addressable store (hash → raw text)
- `documents_fts` — FTS5 full-text index (Porter tokenizer; filepath, title, aliases, description, body)
- `doc_profiles` — per-document frontmatter aliases/description + embed state of its profile vector
- `vectors_vec` — sqlite-vec virtual table for nearest-neighbor search (chunk vectors keyed `<hash>_<seq>`, profile vectors keyed `profile:<doc id>`)
- `content_vectors` — embedding metadata (hash, seq, model, embedded_at, plus `pos` — the chunk's char offset, used for snippet positioning)

**Metadata:**
- `frontmatter` — key/value pairs extracted from YAML (arrays exploded to rows)
- `sections` — heading-delimited sections (seq, level, heading, body, word_count)
- `tags` — denormalized tag index
- `callouts` — Obsidian callout blocks (kind, title, body)
- `wikilinks` — `[[target]]` links with anchors

**Config & Cache:**
- `store_collections` — collection config synced from YAML
- `store_config` — key/value metadata (global_context, config_hash)
- `llm_cache` — cached LLM responses (expandQuery, rerank), keyed by a SHA-256 hash over an operation-specific `(url, body)` pair — `expandQuery` hashes `{query, model, intent}`, `rerank` hashes `{query, model, chunk}` per chunk

## Key Paths

| Item | Location |
|------|----------|
| Collection config (YAML) | `~/.config/qmd/index.yml` (overridden by `QMD_CONFIG_DIR` or `XDG_CONFIG_HOME`) |
| SQLite database | `~/.cache/qmd/index.sqlite` |
| CLI binary | Shell wrapper script at project root; runs compiled JS from `dist/` |
| GGUF models | Managed by node-llama-cpp, downloaded on first use |

## Subsystem Docs

- **[INDEXING.md](INDEXING.md)** — Collection management + reindex pipeline
- **[EMBEDDING.md](EMBEDDING.md)** — Chunking strategies + vector embedding pipeline
- **[QUERYING.md](QUERYING.md)** — All search modes (tsearch / vsearch / hsearch / fsearch)
- **[RETRIEVAL.md](RETRIEVAL.md)** — Document retrieval (`get`, `multi-get`, `ls`)
- **[SYNTAX.md](SYNTAX.md)** — Query DSL grammar (fsearch filter expressions + tsearch syntax)

## MCP Server Tools

Exposed by `src/mcp/server.ts` (stdio default, HTTP optional):

| Tool | Maps to |
|------|---------|
| `hsearch` | `store.search()` hybrid pipeline |
| `get` | `findDocument()` single doc lookup |
| `multi_get` | `findDocuments()` batch retrieval |
| `fsearch` | `findByFilter()` DSL filter |
| `toc` | heading tree extraction |
| `status` | index health summary |
