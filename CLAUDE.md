# QMD - Query Markup Documents

Use Bun instead of Node.js (`bun` not `node`, `bun install` not `npm install`).

## General instructions

When refactoring commands, for example renaming, adding/removing params - review the claude.md, relevant docs and README.md file to ensure no stale or outdated references remain.

## Commands

```sh
qmd collection add . --name <n>   # Create/index collection
qmd collection list               # List all collections with details
qmd collection remove <name>      # Remove a collection by name
qmd collection rename <old> <new> # Rename a collection
qmd ls [collection[/path]]        # List collections or files in a collection
qmd context add [path] "text"     # Add context for path (defaults to current dir)
qmd context list                  # List all contexts
qmd context check                 # Check for collections/paths missing context
qmd context rm <path>             # Remove context
qmd get <file>                    # Get document by path or docid (#abc123)
qmd multi-get <pattern>           # Get multiple docs by glob or comma-separated list
qmd status                        # Show index status and collections
qmd index [--pull]                # Re-index all collections (--pull: git pull first)
qmd embed                         # Generate vector embeddings (uses node-llama-cpp)
qmd hsearch <query>               # Search with query expansion + reranking (recommended)
qmd tsearch <query>               # Full-text keyword search (BM25, no LLM)
qmd fsearch <filter>              # Filter by frontmatter/tags/dates/sections (DSL, no LLM)
qmd vsearch <query>               # Vector similarity search (no reranking)
qmd mcp                           # Start MCP server (stdio transport)
qmd mcp --http [--port N]         # Start MCP server (HTTP, default port 8181)
qmd mcp --http --daemon           # Start as background daemon
qmd mcp stop                      # Stop background MCP daemon
```

For command usage examples and options, see the [README](README.md).

## Development

```sh
bun src/cli/qmd.ts <command>   # Run from source
bun link               # Install globally as 'qmd'
```

## Tests

All tests live in `test/`. Run everything:

```sh
npx vitest run --reporter=verbose test/
bun test --preload ./src/test-preload.ts test/
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module map, DB schema summary, key file paths, and links to subsystem docs (indexing, embedding, querying, retrieval).

## Important: Do NOT run automatically

- Never run `qmd collection add`, `qmd embed`, or `qmd index` automatically
- Never modify the SQLite database directly
- Write out example commands for the user to run manually
- Index is stored at `~/.cache/qmd/index.sqlite`

## Do NOT compile

- Never run `bun build --compile` - it overwrites the shell wrapper and breaks sqlite-vec
- The `qmd` file is a shell script that runs compiled JS from `dist/` - do not replace it
- `npm run build` compiles TypeScript to `dist/` via `tsc -p tsconfig.build.json`

## Releasing

Use `/npm-release` to cut a release.

Key points:
- Add changelog entries under `## [Unreleased]` **as you make changes**
- The release script renames `[Unreleased]` → `[X.Y.Z] - date` at release time
- Credit external PRs with `#NNN (thanks @username)`
- GitHub releases roll up the full minor series (e.g. 1.2.0 through 1.2.3)
