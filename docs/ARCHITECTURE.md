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

| File | Lines | Responsibility |
|------|-------|----------------|
| `src/store.ts` | 5,608 | Central DB layer: indexing, chunking, embedding, all search types, retrieval |
| `src/collections.ts` | 520 | YAML config CRUD for collections and contexts |
| `src/llm.ts` | 1,665 | node-llama-cpp wrapper: embed, rerank, query expansion; lazy-load + auto-unload |
| `src/ast.ts` | 391 | AST-aware chunking via tree-sitter (TS, JS, Python, Go, Rust) |
| `src/cli/qmd.ts` | ~3,600 | CLI entry point: command routing, output formatting |
| `src/mcp/server.ts` | 969 | MCP server (stdio + HTTP transports) |
| `src/db.ts` | 97 | SQLite abstraction; loads sqlite-vec extension |
| `src/index.ts` | 560 | Public SDK entry point |
| `src/parse/frontmatter.ts` | — | YAML frontmatter extraction |
| `src/parse/structure.ts` | — | Document structure parsing (headings, callouts, wikilinks) |
| `src/query/parser.ts` | — | fsearch DSL parser |
| `src/query/lexer.ts` | — | DSL tokenizer |
| `src/query/compile.ts` | — | Compiles parsed DSL to SQLite predicates |
| `src/maintenance.ts` | 54 | Database maintenance helpers |

## SQLite Schema Summary

**Content & Search:**
- `documents` — file registry (id, collection, path, hash, title, dates, active)
- `content` — content-addressable store (hash → raw text)
- `documents_fts` — FTS5 full-text index (Porter tokenizer)
- `vectors_vec` — sqlite-vec virtual table for nearest-neighbor search
- `content_vectors` — embedding metadata (hash, seq, model, embedded_at)

**Metadata:**
- `frontmatter` — key/value pairs extracted from YAML (arrays exploded to rows)
- `sections` — heading-delimited sections (seq, level, heading, body, word_count)
- `tags` — denormalized tag index
- `callouts` — Obsidian callout blocks (kind, title, body)
- `wikilinks` — `[[target]]` links with anchors

**Config & Cache:**
- `store_collections` — collection config synced from YAML
- `store_config` — key/value metadata (global_context, config_hash)
- `llm_cache` — cached LLM responses keyed by (query + model + intent)

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
