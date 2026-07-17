// Commands: vectorIndex (qmd embed)

import {
  getHashesNeedingEmbedding,
  generateEmbeddings,
  DEFAULT_EMBED_MAX_BATCH_BYTES,
  DEFAULT_EMBED_MAX_DOCS_PER_BATCH,
} from "../../store.js";
import type { ChunkStrategy } from "../../store.js";
import { getStore, closeDb } from "../store-access.js";
import { c, cursor, progress, isTTY, formatETA, formatBytes } from "../utils.js";

export function renderProgressBar(percent: number, width: number = 30): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

export function parseEmbedBatchOption(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export async function vectorIndex(
  model: string,
  force: boolean = false,
  batchOptions?: { maxDocsPerBatch?: number; maxBatchBytes?: number; chunkStrategy?: ChunkStrategy; collection?: string },
): Promise<void> {
  const storeInstance = getStore();
  const db = storeInstance.db;

  if (force) {
    console.log(`${c.yellow}Force re-indexing: clearing all vectors...${c.reset}`);
  }

  const hashesToEmbed = getHashesNeedingEmbedding(db, batchOptions?.collection);
  if (hashesToEmbed === 0 && !force) {
    console.log(`${c.green}✓ All content hashes already have embeddings.${c.reset}`);
    closeDb();
    return;
  }

  console.log(`${c.dim}Model: ${model}${c.reset}\n`);
  if (batchOptions?.maxDocsPerBatch !== undefined || batchOptions?.maxBatchBytes !== undefined) {
    const maxDocsPerBatch = batchOptions.maxDocsPerBatch ?? DEFAULT_EMBED_MAX_DOCS_PER_BATCH;
    const maxBatchBytes = batchOptions.maxBatchBytes ?? DEFAULT_EMBED_MAX_BATCH_BYTES;
    console.log(`${c.dim}Batch: ${maxDocsPerBatch} docs / ${formatBytes(maxBatchBytes)}${c.reset}\n`);
  }
  cursor.hide();
  progress.indeterminate();

  const startTime = Date.now();

  const result = await generateEmbeddings(storeInstance, {
    force,
    model,
    collection: batchOptions?.collection,
    maxDocsPerBatch: batchOptions?.maxDocsPerBatch,
    maxBatchBytes: batchOptions?.maxBatchBytes,
    chunkStrategy: batchOptions?.chunkStrategy,
    onProgress: (info) => {
      if (info.totalBytes === 0) return;
      const percent = (info.bytesProcessed / info.totalBytes) * 100;
      progress.set(percent);

      const elapsed = (Date.now() - startTime) / 1000;
      const bytesPerSec = info.bytesProcessed / elapsed;
      const remainingBytes = info.totalBytes - info.bytesProcessed;
      const etaSec = remainingBytes / bytesPerSec;

      const bar = renderProgressBar(percent);
      const percentStr = percent.toFixed(0).padStart(3);
      const throughput = `${formatBytes(bytesPerSec)}/s`;
      const eta = elapsed > 2 ? formatETA(etaSec) : "...";
      const errStr = info.errors > 0 ? ` ${c.yellow}${info.errors} err${c.reset}` : "";

      if (isTTY) process.stderr.write(`\r${c.cyan}${bar}${c.reset} ${c.bold}${percentStr}%${c.reset} ${c.dim}${info.chunksEmbedded}/${info.totalChunks}${c.reset}${errStr} ${c.dim}${throughput} ETA ${eta}${c.reset}   `);
    },
  });

  progress.clear();
  cursor.show();

  const totalTimeSec = result.durationMs / 1000;

  if (result.chunksEmbedded === 0 && result.docsProcessed === 0) {
    console.log(`${c.green}✓ No non-empty documents to embed.${c.reset}`);
  } else {
    console.log(`\r${c.green}${renderProgressBar(100)}${c.reset} ${c.bold}100%${c.reset}                                    `);
    console.log(`\n${c.green}✓ Done!${c.reset} Embedded ${c.bold}${result.chunksEmbedded}${c.reset} chunks from ${c.bold}${result.docsProcessed}${c.reset} documents in ${c.bold}${formatETA(totalTimeSec)}${c.reset}`);
    if (result.errors > 0) {
      console.log(`${c.yellow}⚠ ${result.errors} chunks failed${c.reset}`);
    }
  }

  closeDb();
}
