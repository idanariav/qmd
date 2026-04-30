// Layer 3: Reindex and embed — pure-logic functions for SDK and CLI

import { readFileSync, statSync } from "node:fs";
import fastGlob from "fast-glob";
import type { Database } from "../db.js";
import type { SectionFilter } from "../collections.js";
import {
  LlamaCpp, getDefaultLlamaCpp, formatDocForEmbedding, withLLMSessionForLlm,
} from "../llm.js";
import { parseFrontmatter } from "../parse/frontmatter.js";
import { parseStructure } from "../parse/structure.js";
import { getRealPath, resolve } from "./paths.js";
import { extractSectionByHeading } from "./sections.js";
import {
  DEFAULT_EMBED_MODEL, DEFAULT_EMBED_MAX_DOCS_PER_BATCH, DEFAULT_EMBED_MAX_BATCH_BYTES,
} from "./config.js";
import {
  hashContent, extractTitle, handelize,
  insertContent, insertDocument, findActiveDocument, findOrMigrateLegacyDocument,
  updateDocumentTitle, updateDocument, upsertDocumentMetadata,
  deactivateDocument, getActiveDocumentPaths, chunkDocumentByTokens,
} from "./documents.js";
import { cleanupOrphanedContent } from "./maintenance.js";
import { insertEmbedding, clearAllEmbeddings } from "./search-vec.js";
import type { Store } from "./factory.js";

function getLlm(store: Store): LlamaCpp {
  return store.llm ?? getDefaultLlamaCpp();
}

export type ReindexProgress = {
  file: string;
  current: number;
  total: number;
};

export type ReindexResult = {
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  orphanedCleaned: number;
};

export async function reindexCollection(
  store: Store,
  collectionPath: string,
  globPattern: string,
  collectionName: string,
  options?: {
    ignorePatterns?: string[];
    section?: SectionFilter;
    onProgress?: (info: ReindexProgress) => void;
  }
): Promise<ReindexResult> {
  const db = store.db;
  const now = new Date().toISOString();
  const excludeDirs = ["node_modules", ".git", ".cache", "vendor", "dist", "build"];

  const allIgnore = [
    ...excludeDirs.map(d => `**/${d}/**`),
    ...(options?.ignorePatterns || []),
  ];
  const allFiles: string[] = await fastGlob(globPattern, {
    cwd: collectionPath,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: false,
    ignore: allIgnore,
  });
  const files = allFiles.filter(file => {
    const parts = file.split("/");
    return !parts.some(part => part.startsWith("."));
  });

  const total = files.length;
  let indexed = 0, updated = 0, unchanged = 0, processed = 0;
  const seenPaths = new Set<string>();

  for (const relativeFile of files) {
    const filepath = getRealPath(resolve(collectionPath, relativeFile));
    const path = handelize(relativeFile);
    seenPaths.add(path);

    let content: string;
    try {
      content = readFileSync(filepath, "utf-8");
    } catch {
      processed++;
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    if (!content.trim()) {
      processed++;
      continue;
    }

    if (options?.section) {
      const sectionContent = extractSectionByHeading(content, options.section);
      if (sectionContent === null) {
        processed++;
        options?.onProgress?.({ file: relativeFile, current: processed, total });
        continue;
      }
      content = sectionContent;
    }

    const hash = await hashContent(content);
    const fm = parseFrontmatter(content);
    const structure = parseStructure(fm.body);
    const title = fm.title || extractTitle(content, relativeFile);
    const stat = statSync(filepath);
    const createdAt = fm.createdDate ?? new Date(stat.birthtime).toISOString();
    const modifiedAt = fm.modifiedDate ?? new Date(stat.mtime).toISOString();

    const existing = findOrMigrateLegacyDocument(db, collectionName, path);

    if (existing) {
      if (existing.hash === hash) {
        if (existing.title !== title) {
          updateDocumentTitle(db, existing.id, title, modifiedAt, relativeFile);
          updated++;
        } else {
          db.prepare(`UPDATE documents SET original_path = COALESCE(?, original_path) WHERE id = ?`)
            .run(relativeFile, existing.id);
          unchanged++;
        }
        upsertDocumentMetadata(db, existing.id, fm, structure);
      } else {
        insertContent(db, hash, content, now);
        updateDocument(db, existing.id, title, hash, modifiedAt, relativeFile);
        upsertDocumentMetadata(db, existing.id, fm, structure);
        updated++;
      }
    } else {
      indexed++;
      insertContent(db, hash, content, now);
      insertDocument(db, collectionName, path, title, hash, createdAt, modifiedAt, relativeFile);
      const inserted = findActiveDocument(db, collectionName, path);
      if (inserted) upsertDocumentMetadata(db, inserted.id, fm, structure);
    }

    processed++;
    options?.onProgress?.({ file: relativeFile, current: processed, total });
  }

  const allActive = getActiveDocumentPaths(db, collectionName);
  let removed = 0;
  for (const path of allActive) {
    if (!seenPaths.has(path)) {
      deactivateDocument(db, collectionName, path);
      removed++;
    }
  }

  const orphanedCleaned = cleanupOrphanedContent(db);

  return { indexed, updated, unchanged, removed, orphanedCleaned };
}

export type EmbedProgress = {
  chunksEmbedded: number;
  totalChunks: number;
  bytesProcessed: number;
  totalBytes: number;
  errors: number;
};

export type EmbedResult = {
  docsProcessed: number;
  chunksEmbedded: number;
  errors: number;
  durationMs: number;
};

export type EmbedOptions = {
  force?: boolean;
  model?: string;
  collection?: string;
  maxDocsPerBatch?: number;
  maxBatchBytes?: number;
  chunkStrategy?: import("./chunking.js").ChunkStrategy;
  onProgress?: (info: EmbedProgress) => void;
};

type PendingEmbeddingDoc = {
  hash: string;
  path: string;
  bytes: number;
};

type EmbeddingDoc = PendingEmbeddingDoc & {
  body: string;
};

type ChunkItem = {
  hash: string;
  title: string;
  text: string;
  seq: number;
  pos: number;
  tokens: number;
  bytes: number;
};

function validatePositiveIntegerOption(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function resolveEmbedOptions(options?: EmbedOptions): Required<Pick<EmbedOptions, "maxDocsPerBatch" | "maxBatchBytes">> {
  return {
    maxDocsPerBatch: validatePositiveIntegerOption("maxDocsPerBatch", options?.maxDocsPerBatch, DEFAULT_EMBED_MAX_DOCS_PER_BATCH),
    maxBatchBytes: validatePositiveIntegerOption("maxBatchBytes", options?.maxBatchBytes, DEFAULT_EMBED_MAX_BATCH_BYTES),
  };
}

function getPendingEmbeddingDocs(db: Database, collection?: string): PendingEmbeddingDoc[] {
  const collectionFilter = collection ? `AND d.collection = ?` : ``;
  const stmt = db.prepare(`
    SELECT d.hash, MIN(d.path) as path, length(CAST(c.doc AS BLOB)) as bytes
    FROM documents d
    JOIN content c ON d.hash = c.hash
    LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
    WHERE d.active = 1 AND v.hash IS NULL ${collectionFilter}
    GROUP BY d.hash
    ORDER BY MIN(d.path)
  `);
  return (collection ? stmt.all(collection) : stmt.all()) as PendingEmbeddingDoc[];
}

function buildEmbeddingBatches(
  docs: PendingEmbeddingDoc[],
  maxDocsPerBatch: number,
  maxBatchBytes: number,
): PendingEmbeddingDoc[][] {
  const batches: PendingEmbeddingDoc[][] = [];
  let currentBatch: PendingEmbeddingDoc[] = [];
  let currentBytes = 0;

  for (const doc of docs) {
    const docBytes = Math.max(0, doc.bytes);
    const wouldExceedDocs = currentBatch.length >= maxDocsPerBatch;
    const wouldExceedBytes = currentBatch.length > 0 && (currentBytes + docBytes) > maxBatchBytes;

    if (wouldExceedDocs || wouldExceedBytes) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }

    currentBatch.push(doc);
    currentBytes += docBytes;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function getEmbeddingDocsForBatch(db: Database, batch: PendingEmbeddingDoc[]): EmbeddingDoc[] {
  if (batch.length === 0) return [];

  const placeholders = batch.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT hash, doc as body
    FROM content
    WHERE hash IN (${placeholders})
  `).all(...batch.map(doc => doc.hash)) as { hash: string; body: string }[];
  const bodyByHash = new Map(rows.map(row => [row.hash, row.body]));

  return batch.map((doc) => ({
    ...doc,
    body: bodyByHash.get(doc.hash) ?? "",
  }));
}

export async function generateEmbeddings(
  store: Store,
  options?: EmbedOptions
): Promise<EmbedResult> {
  const db = store.db;
  const model = options?.model ?? DEFAULT_EMBED_MODEL;
  const now = new Date().toISOString();
  const { maxDocsPerBatch, maxBatchBytes } = resolveEmbedOptions(options);
  const encoder = new TextEncoder();

  if (options?.force) {
    clearAllEmbeddings(db, options?.collection);
  }

  const docsToEmbed = getPendingEmbeddingDocs(db, options?.collection);

  if (docsToEmbed.length === 0) {
    return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 };
  }
  const totalBytes = docsToEmbed.reduce((sum, doc) => sum + Math.max(0, doc.bytes), 0);
  const totalDocs = docsToEmbed.length;
  const startTime = Date.now();

  const llm = getLlm(store);
  const embedModelUri = llm.embedModelName;

  const result = await withLLMSessionForLlm(llm, async (session) => {
    let chunksEmbedded = 0;
    let errors = 0;
    let bytesProcessed = 0;
    let totalChunks = 0;
    let vectorTableInitialized = false;
    const BATCH_SIZE = 32;
    const batches = buildEmbeddingBatches(docsToEmbed, maxDocsPerBatch, maxBatchBytes);

    for (const batchMeta of batches) {
      if (!session.isValid) {
        console.warn(`⚠ Session expired — skipping remaining document batches`);
        break;
      }

      const batchDocs = getEmbeddingDocsForBatch(db, batchMeta);
      const batchChunks: ChunkItem[] = [];
      const batchBytes = batchMeta.reduce((sum, doc) => sum + Math.max(0, doc.bytes), 0);

      for (const doc of batchDocs) {
        if (!doc.body.trim()) continue;

        const title = extractTitle(doc.body, doc.path);
        const chunks = await chunkDocumentByTokens(
          doc.body,
          undefined, undefined, undefined,
          doc.path,
          options?.chunkStrategy,
          session.signal,
        );

        for (let seq = 0; seq < chunks.length; seq++) {
          batchChunks.push({
            hash: doc.hash,
            title,
            text: chunks[seq]!.text,
            seq,
            pos: chunks[seq]!.pos,
            tokens: chunks[seq]!.tokens,
            bytes: encoder.encode(chunks[seq]!.text).length,
          });
        }
      }

      totalChunks += batchChunks.length;

      if (batchChunks.length === 0) {
        bytesProcessed += batchBytes;
        options?.onProgress?.({ chunksEmbedded, totalChunks, bytesProcessed, totalBytes, errors });
        continue;
      }

      if (!vectorTableInitialized) {
        const firstChunk = batchChunks[0]!;
        const firstText = formatDocForEmbedding(firstChunk.text, firstChunk.title, embedModelUri);
        const firstResult = await session.embed(firstText, { model });
        if (!firstResult) {
          throw new Error("Failed to get embedding dimensions from first chunk");
        }
        store.ensureVecTable(firstResult.embedding.length);
        vectorTableInitialized = true;
      }

      const totalBatchChunkBytes = batchChunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
      let batchChunkBytesProcessed = 0;

      for (let batchStart = 0; batchStart < batchChunks.length; batchStart += BATCH_SIZE) {
        if (!session.isValid) {
          const remaining = batchChunks.length - batchStart;
          errors += remaining;
          console.warn(`⚠ Session expired — skipping ${remaining} remaining chunks`);
          break;
        }

        const processed = chunksEmbedded + errors;
        if (processed >= BATCH_SIZE && errors > processed * 0.8) {
          const remaining = batchChunks.length - batchStart;
          errors += remaining;
          console.warn(`⚠ Error rate too high (${errors}/${processed}) — aborting embedding`);
          break;
        }

        const batchEnd = Math.min(batchStart + BATCH_SIZE, batchChunks.length);
        const chunkBatch = batchChunks.slice(batchStart, batchEnd);
        const texts = chunkBatch.map(chunk => formatDocForEmbedding(chunk.text, chunk.title, embedModelUri));

        try {
          const embeddings = await session.embedBatch(texts, { model });
          for (let i = 0; i < chunkBatch.length; i++) {
            const chunk = chunkBatch[i]!;
            const embedding = embeddings[i];
            if (embedding) {
              insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(embedding.embedding), model, now);
              chunksEmbedded++;
            } else {
              errors++;
            }
            batchChunkBytesProcessed += chunk.bytes;
          }
        } catch {
          if (!session.isValid) {
            errors += chunkBatch.length;
            batchChunkBytesProcessed += chunkBatch.reduce((sum, c) => sum + c.bytes, 0);
          } else {
            for (const chunk of chunkBatch) {
              try {
                const text = formatDocForEmbedding(chunk.text, chunk.title, embedModelUri);
                const result = await session.embed(text, { model });
                if (result) {
                  insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(result.embedding), model, now);
                  chunksEmbedded++;
                } else {
                  errors++;
                }
              } catch {
                errors++;
              }
              batchChunkBytesProcessed += chunk.bytes;
            }
          }
        }

        const proportionalBytes = totalBatchChunkBytes === 0
          ? batchBytes
          : Math.min(batchBytes, Math.round((batchChunkBytesProcessed / totalBatchChunkBytes) * batchBytes));
        options?.onProgress?.({
          chunksEmbedded,
          totalChunks,
          bytesProcessed: bytesProcessed + proportionalBytes,
          totalBytes,
          errors,
        });
      }

      bytesProcessed += batchBytes;
      options?.onProgress?.({ chunksEmbedded, totalChunks, bytesProcessed, totalBytes, errors });
    }

    return { chunksEmbedded, errors };
  }, { maxDuration: 30 * 60 * 1000, name: 'generateEmbeddings' });

  return {
    docsProcessed: totalDocs,
    chunksEmbedded: result.chunksEmbedded,
    errors: result.errors,
    durationMs: Date.now() - startTime,
  };
}
