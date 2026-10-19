# Portable vector export (`qmd export`)

Writes a compact copy of the vector index into a folder inside an Obsidian vault, so clients that
can't run qmd (the pkm-rag plugin on mobile, or a desktop without qmd installed) can still do
vector search. Nothing is re-embedded except the word table (below); chunk and profile vectors
are read straight from `vectors_vec`.

```sh
qmd export --out <vault>/Scaffolding/Embeddings/qmd   # explicit
qmd export                                            # uses export.path from index.yml
qmd export --dim 768                                  # keep full dimensions
```

Config (`~/.config/qmd/index.yml`) — when `export.path` is set, `qmd embed` re-exports at the end:

```yaml
export:
  path: /Users/me/Vault/Scaffolding/Embeddings/qmd
  dim: 512          # optional, default 512
```

The output directory must sit inside a vault (a `.obsidian/` folder above it): doc paths are
written vault-relative, and docs from collections outside that vault are skipped.

## Format: `pkm-vectors` v1

Two files:

- `vectors.bin` — int8, row-major, `dim` bytes per row: all `items` first, then all `words`.
- `manifest.json`:

```jsonc
{
  "format": "pkm-vectors", "version": 1, "tool": "qmd",
  "model": "<embed model URI>", "dim": 512, "scale": 127,
  "exportedAt": "<ISO date>",
  "collections": { "claims": { "section": { "heading": "Notes", "level": 2 } }, "posts": {} },
  "docs":  [{ "path": "Content/Claims/X.md",       // vault-relative
             "file": "qmd://claims/X.md",          // as in --json search output
             "collection": "claims", "title": "X", "docid": "abc123",
             "context": "…",                       // optional
             "hash": "<sha256 of the raw file, 16 hex>" }],
  "items": [{ "d": 0,          // index into docs
             "seq": 0,         // chunk sequence; -1 = profile vector (aliases + description)
             "line": 7,        // 1-based line of the chunk start in the indexed text
             "snippet": "…" }],// first 300 chars of the chunk
  "words": ["ability", "…"]
}
```

Vectors are truncated to `dim`, L2-normalized, then `round(x * 127)`. Score a row as
`dot(query, row) / 127` with a normalized float query, which gives cosine similarity.

**Indexed text vs. file.** For collections with a `section` filter, `line` and `snippet` refer to
the indexed section, not the whole file. Compare `hash` against a sha256 of the current raw file to
tell whether a hit is stale.

**Word table.** Clients have no embedding model, so a typed query is embedded as the mean of its
words' vectors. The table contains `assets/common-words.txt` (~5k English words), every word in a
doc title, and every body word used at least 3 times. Each word is embedded as a *query*
(`formatQueryForEmbedding`). Word vectors are reused from the previous export while the model and
`dim` are unchanged, so only new words cost embedding time.

**Fidelity.** On the 15 single-noun queries in pkm-smart-link's `eval/queries.json`, the lite
top-10 (512 dims, int8) shares 7.3/10 docs on average with qmd's own pure vector search (`searchVec`).
Most mismatches are near-ties in the tail. Using 768 dims didn't improve this, which is why 512 is
the default.
