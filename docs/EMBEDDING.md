# Embedding Pipeline

Covers the `qmd embed` step: chunking documents and generating vector embeddings.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the overall system map.

## Overview

```
Documents in DB (no embeddings yet)
  → chunk into overlapping segments
  → tokenize + embed each chunk via LLM
  → store Float32Array in sqlite-vec
```

Entry point: `generateEmbeddings(db, opts?)` in `src/store.ts`

## Chunking — Three Layers

Chunking is layered: each layer adds more semantic precision at higher cost.

### Layer 1: Regex Break Points — `src/store.ts`

`scanBreakPoints(text)` scores positions in the text for natural split points:

| Pattern type | Score | Markdown equivalent |
|-------------|-------|---------------------|
| `# H1` heading | 100 | like a chapter boundary |
| `## H2` heading | 90 | |
| `### H3` heading | 80 | |
| `####+` heading | 70 | |
| Blank line | 30 | paragraph boundary |
| List item | 20 | |
| XML/HTML tag | 15 | |

`findCodeFences(text)` identifies triple-backtick regions. `isInsideProtectedRegion()` prevents any chunk boundary from landing inside a code fence.

`findListBreakPoints()` and `findXmlTagBreakPoints()` add further break candidates; all lists are merged by `mergeBreakPoints()` (higher score wins at the same position).

Core algorithm: `chunkDocumentWithBreakPoints(content, breakPoints, codeFences, maxChars, overlapChars, windowChars)` — emits asymmetric boundaries that prefer natural splits within the overlap window.

Sync entry point: `chunkDocument(content, maxChars?, overlapChars?, windowChars?)`

### Layer 2: AST Break Points — `src/ast.ts`

For code files, tree-sitter parses the AST and adds higher-quality break points at declaration boundaries.

**Supported languages:** TypeScript, TSX, JavaScript, JSX, Python, Go, Rust

`detectLanguage(filepath)` maps file extension → language.

`getASTBreakPoints(content, filepath)` — async, lazy-loads tree-sitter WASM grammar (cached per language), runs per-language query, returns `BreakPoint[]` with scores:

| Node type | Score |
|-----------|-------|
| class / interface / struct / trait / impl / mod | 100 |
| export / function / method / decorated | 90 |
| type alias / enum | 80 |
| import statement | 60 |

Graceful degradation: unsupported language or parse failure returns `[]` (falls back to regex only). Failed languages are tracked in `failedLanguages` set to warn only once.

Async entry point: `chunkDocumentAsync(content, maxChars?, overlapChars?, windowChars?, filepath?, chunkStrategy)`

- `chunkStrategy = "auto"` — uses AST for supported code files, regex for everything else
- `chunkStrategy = "regex"` — regex only (default for markdown and unknown types)

### Layer 3: Token-Aware Re-Split — `src/store.ts`

`chunkDocumentByTokens(content, maxTokens?, overlapTokens?, windowTokens?, filepath?, chunkStrategy, signal?)`

1. Run `chunkDocumentAsync()` for initial character-based chunks
2. Tokenize each chunk via the LLM tokenizer (actual token count, not estimated)
3. If a chunk exceeds `maxTokens`, re-split it recursively
4. Dynamically adjust overlap based on observed char-to-token ratio (~4 for prose, ~2 for code, ~3 for mixed)

**Constants:**

| Constant | Value | Description |
|----------|-------|-------------|
| `CHUNK_SIZE_TOKENS` | 900 | Target chunk size |
| `CHUNK_OVERLAP_TOKENS` | 135 | Overlap = 15% of chunk size |
| `CHUNK_WINDOW_TOKENS` | 270 | Window to search for break points |
| `CHUNK_SIZE_CHARS` | 3,600 | Character approximation (~4 chars/token) |

## Embedding — `src/store.ts` + `src/llm.ts`

`generateEmbeddings(db, opts?)` pipeline:

1. Query DB for documents without embeddings (`content_vectors` rows missing)
2. Call `chunkDocumentByTokens()` per document
3. Batch chunks: 32 chunks per batch, max 64 MB per document batch
4. Call `session.embedBatch(chunks)` via node-llama-cpp (in `src/llm.ts`)
5. `insertEmbedding(db, hash, seq, vector, model)` — stores `Float32Array` into `vectors_vec` virtual table via sqlite-vec

**Tables written:**
- `content_vectors` — metadata row per chunk (hash, seq, model, embedded_at)
- `vectors_vec` — the actual embedding vector (sqlite-vec virtual table)

## LLM Model Management — `src/llm.ts`

All model interactions go through `src/llm.ts`, which wraps node-llama-cpp:

- **Lazy loading:** Models are loaded on first use, not at startup
- **Auto-unload:** After 5 minutes of inactivity, models are unloaded to free VRAM
- **Session management:** Max session duration enforced; sessions recreated as needed
- **Batch embedding:** `embedBatch(texts[])` — single LLM call for multiple chunks

**Default models** (overridable via env vars or YAML config):
- Embed: `embeddinggemma` (or `Qwen3-Embedding`)
- Rerank: `hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf`
- Generate / query expansion: `Qwen/Qwen3-1.7B`

Env var overrides: `QMD_EMBED_MODEL`, `QMD_RERANK_MODEL`, `QMD_GENERATE_MODEL`
