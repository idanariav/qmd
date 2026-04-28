# Querying Pipeline

Covers all four search modes and the internals of the hybrid pipeline.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the overall system map.
See [SYNTAX.md](SYNTAX.md) for query DSL grammar (fsearch filter expressions + tsearch term syntax).

## Search Mode Comparison

| Mode | Method | LLM Required | Speed | Best For |
|------|--------|-------------|-------|----------|
| `tsearch` | BM25 (FTS5) | No | Instant | Exact keywords, fast lookup |
| `vsearch` | Vector similarity | Embed only | Fast | Concept/semantic search |
| `fsearch` | Metadata DSL filter | No | Instant | Date ranges, tags, frontmatter |
| `hsearch` | BM25 + Vec + RRF + Rerank | Full pipeline | Slower | Nuanced, best-quality results |

All modes share the same SQLite backend and respect `-c <collection>` filtering.

---

## tsearch — `searchFTS()` — `src/store.ts:3749`

BM25 full-text search via SQLite FTS5. No LLM involved.

**Query parsing:** `buildFTS5Query()` in `src/store.ts:3642`
- Prefix terms → wildcard match (e.g., `perf` → `perf*`)
- Quoted phrases → exact phrase match (`"query expansion"`)
- Negations → NOT clause (`-term`)
- Hyphenated terms → phrase queries (`multi-agent` → `"multi agent"`)
- All positive terms joined with AND

**Scoring:** Raw BM25 scores are negative; normalized to [0, 1) via `|score| / (1 + |score|)`.

**Collection filtering:** Applied as a SQLite WHERE clause (not inside the FTS5 MATCH, which would cause optimizer issues).

CLI: `qmd tsearch <query>`

---

## vsearch — `searchVec()` — `src/store.ts:3824`

Vector similarity search using sqlite-vec.

**Pipeline:**
1. Format query text with `formatQueryForEmbedding()` (model-specific template)
2. Embed via `src/llm.ts` → Float32Array
3. Two-step SQLite query (sqlite-vec + JOINs are separate to avoid hangs):
   - Step 1: `vectors_vec` MATCH embedding → top k=limit×3 candidates
   - Step 2: JOIN `content_vectors` + `documents` → resolve chunks, deduplicate by filepath
4. Score = `1 - cosine_distance` (cosine similarity in [0, 1])

`vsearchQuery()` (line 5244) also runs `expandQuery()` to generate additional vec/hyde query variants before calling `searchVec()`.

CLI: `qmd vsearch [--intent <intent>] <query>`

---

## fsearch — `findByFilter()` + `src/query/`

Metadata-only filter search. No embeddings, no LLM.

**DSL compiled by:**
- `src/query/lexer.ts` — tokenizer
- `src/query/parser.ts` — parser → AST
- `src/query/compile.ts` — AST → SQLite predicates (UDFs registered in `src/store.ts`)

**Filterable fields:** `tag`, `section`, `level`, `content`, `title`, `collection`, `modified`, `created`, `word_count`, any frontmatter key.

**Operators:** `=`, `~=` (contains), `>`, `<`, `~/regex/`, `missing:`, `empty:`, `no:headings`, `no:level=N`

**Boolean logic:** AND, OR, NOT, parentheses

For full grammar see [SYNTAX.md](SYNTAX.md).

CLI: `qmd fsearch 'tag=productivity AND modified > 30d'`

---

## hsearch — `hybridQuery()` / `querySearch()` — `src/store.ts:4935`

Full hybrid pipeline. Recommended for most queries.

Entry: `hybridQuery(store, query, opts)` → `querySearch()` in CLI / `store.search()` in MCP.

**7-Step Pipeline:**

### 1. Strong Signal Detection (line 4961)
Initial BM25 probe on the raw query. If `topScore ≥ 0.8` AND `gap to 2nd result ≥ 0.1`, skip LLM expansion entirely — the keyword match is decisive. Disabled when `intent` is provided.

### 2. Query Expansion (line 4971)
`expandQuery(db, query, opts)` calls `llm.expandQuery()` (Qwen3 1.7B) to generate typed variants:
- `lex:` — alternative keyword phrasings
- `vec:` — semantic paraphrases
- `hyde:` — hypothetical document snippets (HyDE)

Results cached in `llm_cache` (key = query + model + intent). Duplicates of the original query are filtered out.

### 3. Type-Routed Search (line 4989)
- **FTS (lex queries):** All lex variants run as synchronous BM25 batch
- **Vector (vec + hyde + original):** All embeddings generated in a single `embedBatch()` call, then individual sqlite-vec lookups

### 4. RRF Fusion — `reciprocalRankFusion()` — line 4137
Reciprocal Rank Fusion combines all FTS and vector result lists without normalizing scores.

Formula: `rrfScore += weight / (k + rank + 1)` per list (k=60)

Weights:
- First two lists (original FTS + first vec query): `2.0×`
- Remaining expansion lists: `1.0×`

Top-rank bonuses: `+0.05` at rank 1, `+0.02` at rank ≤ 3.

Output: fused candidate pool sorted by RRF score (up to `candidateLimit`).

### 5. Best-Chunk Extraction (line 5062)
For each document in the candidate pool, extract chunks and score by keyword overlap with query terms (intent terms weighted higher). Selects the single best-matching chunk per document as the representative excerpt.

### 6. LLM Reranking — `rerank()` — line 4088
Reranks the best chunks (not full document bodies) using Qwen3-Reranker-0.6B.

- Query sent to reranker: `"${intent}\n\n${query}"` when intent is provided
- Cache key: chunk text (identical chunks across queries are scored once)
- `uncachedDocs` only go to the LLM; cached scores are merged back
- Skippable via `skipRerank: true` → returns RRF-only scores

### 7. Score Blending (line 5153)
Blends RRF position score with reranker score using rank-aware weights:

| Rank | RRF weight | Reranker weight |
|------|-----------|-----------------|
| ≤ 3 | 75% | 25% |
| ≤ 10 | 60% | 40% |
| > 10 | 40% | 60% |

Formula: `blended = rrfWeight × (1/rrfRank) + (1 - rrfWeight) × rerankScore`

---

## Structured Query Input

Queries prefixed with `lex:`, `vec:`, or `hyde:` skip query expansion and route directly to the appropriate search function. Useful for precise control or debugging.

Example: `qmd hsearch 'lex:keyword search vec:semantic concept'`

Parsed by `parseStructuredQuery()` in `src/cli/qmd.ts` → `structuredSearch()` in `src/store.ts`.
