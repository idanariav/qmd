# Document Retrieval

Covers `get`, `multi-get`, and `ls` — fetching and listing documents by path, pattern, or docid.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the overall system map.

## Virtual Path Format

QMD uses virtual paths to address documents across collections:

```
qmd://collection-name/relative/path/to/file.md
```

Also accepted: plain `collection/path`, absolute filesystem paths, and relative paths (resolved against collection roots).

The lookup order in `findDocument()` is: virtual path → docid → absolute path → relative path → fuzzy match.

## Docid Format

Each document has a docid = first 6 hex chars of its content SHA-256 hash. Shown in search results as `#abc123`. The leading `#` is optional in CLI commands.

Docids are stable while file content is unchanged and survive file renames.

---

## `get` — Single Document Retrieval

**CLI:** `qmd get <path|docid>[:line]`

**CLI handler** (line 3215 in `src/cli/qmd.ts`) → `getDocument(filePath, opts)` (line 870)

**Core DB lookup:** `findDocument(db, pathOrDocid, opts)` in `src/store.ts:4274`

Lookup order:
1. Parse as virtual path (`qmd://collection/path`)
2. Try as docid (`#abc123` or bare 6-char hash)
3. Try as absolute filesystem path
4. Try as relative path against each collection root
5. Fuzzy match with handelize support (special characters in filenames) → suggestions on failure

**Post-lookup transforms** (in `getDocument()` in CLI):
- `extractSection(body, headingPath)` — extract a specific heading and its content (`--section 'H1/H2'`)
- Line slicing: `--from <line>`, `-l <maxLines>`, or `:line` suffix on the path
- `stripCallouts(body)` — remove Obsidian callout blocks (`--no-callouts`)
- `findCodeFences()` + stripping — remove code blocks (`--no-codeblocks`)
- `--line-numbers` — prefix each line with its number

**Context injection:** `getContextForFile(db, virtualPath)` in `src/store.ts` — longest-prefix match on `ContextMap` → prepended to output as a context header.

**Options summary:**
```
--section 'Heading/Sub'   Extract specific section
--from <line>             Start at line N
-l <lines>                Max lines to return
--line-numbers            Add line numbers
--no-callouts             Strip callout blocks
--no-codeblocks           Strip code blocks
```

---

## `multi-get` — Batch Retrieval

**CLI:** `qmd multi-get <glob|comma-list>`

**CLI handler** (line 3230 in `src/cli/qmd.ts`) → `multiGet(pattern, maxLines, maxBytes, format)` (line 1204)

**Core DB lookup:** `findDocuments(db, pattern, opts)` in `src/store.ts:4478`

Pattern types:
- Glob: `journals/2025-05*.md` → matched against virtual paths
- Comma-separated list: `file1.md, file2.md, #abc123` (can mix paths and docids)

**Size filtering:** Files larger than `maxBytes` (default `DEFAULT_MULTI_GET_MAX_BYTES` = 10 KB) are skipped with an error suggesting `get` instead.

**Output formats** (via `--json`, `--csv`, `--md`, `--xml`, `--files`):
- Default: concatenated markdown with separators
- `--files`: list of matched paths only (no content)

**Options summary:**
```
-l <lines>            Max lines per document
--max-bytes <bytes>   Skip files larger than this
--json|--csv|--md|--xml|--files   Output format
```

---

## `ls` — List Collections and Files

**CLI:** `qmd ls [collection[/path]]`

**CLI handler** (line 3242 in `src/cli/qmd.ts`) → `listFiles(pathArg?)` (line 1438)

| Invocation | Behavior |
|-----------|---------|
| `qmd ls` | List all collections with file counts |
| `qmd ls <collection>` | List all files in collection (path, title, modified_at, size) |
| `qmd ls <collection>/<prefix>` | List files under a path prefix (SQL `LIKE` match) |
| `qmd ls qmd://collection/path` | Same as above, virtual path format |

Output is a formatted table with modification times and file sizes.

---

## Section Extraction

`extractSection(body, headingPath)` in `src/cli/qmd.ts`:

- `headingPath` is a `/`-separated hierarchy, e.g., `"Introduction/Overview"`
- Finds the matching heading by traversing section levels in order
- Returns the body from that heading up to (but not including) the next heading at the same or higher level
- Used by `get --section`
