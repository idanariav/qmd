// Command: export (qmd export) — writes a portable int8 copy of the vector index into a vault
// folder, so tools without qmd installed (e.g. the pkm-rag plugin on mobile) can run vector search.
// Format "pkm-vectors" v1: see docs/EXPORT.md.

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve, isAbsolute, sep } from "path";
import { getContextForFile, getStoreCollections, buildVirtualPath, PROFILE_KEY_PREFIX } from "../../store.js";
import { getDefaultLlamaCpp, formatQueryForEmbedding } from "../../llm.js";
import { loadConfig } from "../../collections.js";
import { getDb, getStore, models } from "../store-access.js";
import { c } from "../utils.js";

export const EXPORT_FORMAT = "pkm-vectors";
export const EXPORT_VERSION = 1;
export const DEFAULT_EXPORT_DIM = 512;
const SCALE = 127;
const SNIPPET_CHARS = 300;
const WORD_BATCH = 64;
const WORD_RE = /[a-z]{3,20}/g;
const BODY_WORD_MIN_COUNT = 3;

type ExportDoc = {
  path: string;        // vault-relative path of the source file
  file: string;        // qmd:// virtual path, as in `qmd vsearch --json`
  collection: string;
  title: string;
  docid: string;
  context?: string;
  hash: string;        // sha256 (16 hex) of the raw file at export time, for staleness checks
};

// seq = -1 marks a profile vector (aliases + description), otherwise the chunk sequence number.
type ExportItem = { d: number; seq: number; line: number; snippet: string };

// Per exported collection: the section filter, so clients index the same text qmd does.
type ExportCollection = { section?: { heading: string; level: number } };

type Manifest = {
  format: string; version: number; tool: "qmd"; model: string; dim: number; scale: number;
  exportedAt: string; collections: Record<string, ExportCollection>;
  docs: ExportDoc[]; items: ExportItem[]; words: string[];
};

export type ExportOptions = { out?: string; dim?: number; quiet?: boolean };

/** The export directory configured in index.yml (`export.path`), if any. */
export function configuredExportDir(): string | undefined {
  try {
    return loadConfig().export?.path;
  } catch {
    return undefined;
  }
}

/** Nearest ancestor of `dir` that is an Obsidian vault (has `.obsidian/`). */
function findVaultRoot(dir: string): string | null {
  let cur = resolve(dir);
  while (true) {
    if (existsSync(join(cur, ".obsidian"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

const sha16 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 16);

function quantize(v: ArrayLike<number>, dim: number): Int8Array {
  const n = Math.min(dim, v.length);
  let norm = 0;
  for (let i = 0; i < n; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  const out = new Int8Array(dim);
  for (let i = 0; i < n; i++) out[i] = Math.round((v[i]! / norm) * SCALE);
  return out;
}

function blobToFloats(blob: Uint8Array): Float32Array {
  // Copy first: sqlite blobs aren't guaranteed to be 4-byte aligned.
  return new Float32Array(Uint8Array.from(blob).buffer);
}

/** Common English words + every title word + body words used at least BODY_WORD_MIN_COUNT times. */
function wordList(titles: string[], bodies: string[]): string[] {
  const words = new Set(
    readFileSync(new URL("../../../assets/common-words.txt", import.meta.url), "utf8")
      .split("\n").map(w => w.trim()).filter(Boolean),
  );
  for (const t of titles) for (const w of t.toLowerCase().match(WORD_RE) ?? []) words.add(w);
  const counts = new Map<string, number>();
  for (const b of bodies) for (const w of b.toLowerCase().match(WORD_RE) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);
  for (const [w, n] of counts) if (n >= BODY_WORD_MIN_COUNT) words.add(w);
  return [...words].sort();
}

/** Word vectors from the previous export, reusable when model and dim are unchanged. */
function previousWordVectors(outDir: string, model: string, dim: number): Map<string, Int8Array> {
  const prev = new Map<string, Int8Array>();
  const manifestPath = join(outDir, "manifest.json");
  const binPath = join(outDir, "vectors.bin");
  if (!existsSync(manifestPath) || !existsSync(binPath)) return prev;
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    if (m.format !== EXPORT_FORMAT || m.model !== model || m.dim !== dim) return prev;
    const bin = readFileSync(binPath);
    m.words.forEach((w, i) => {
      const off = (m.items.length + i) * dim;
      prev.set(w, new Int8Array(bin.buffer, bin.byteOffset + off, dim));
    });
  } catch {
    // Unreadable previous export: re-embed everything.
  }
  return prev;
}

export async function exportVectors(opts: ExportOptions = {}): Promise<void> {
  const log = (msg: string) => { if (!opts.quiet) console.log(msg); };
  const outArg = opts.out ?? configuredExportDir();
  if (!outArg) {
    throw new Error("No export directory: pass --out <dir> or set `export.path` in index.yml");
  }
  const outDir = resolve(outArg);
  const dim = opts.dim ?? loadConfig().export?.dim ?? DEFAULT_EXPORT_DIM;
  const vaultRoot = findVaultRoot(outDir);
  if (!vaultRoot) throw new Error(`Export directory is not inside an Obsidian vault (no .obsidian/ above ${outDir})`);

  getStore();
  const db = getDb();
  const model = models.embed;
  const collections = new Map(getStoreCollections(db).map(col => [col.name, col]));

  // ---- docs ----
  const rows = db.prepare(`
    SELECT d.id, d.collection, d.path, COALESCE(d.original_path, d.path) AS real_path, d.title, d.hash, c.doc AS body
    FROM documents d JOIN content c ON c.hash = d.hash
    WHERE d.active = 1
    ORDER BY d.collection, d.path
  `).all() as { id: number; collection: string; path: string; real_path: string; title: string; hash: string; body: string }[];

  const docs: ExportDoc[] = [];
  const docBodies: string[] = [];
  const docIndexById = new Map<number, number>();
  const docIndexesByHash = new Map<string, number[]>();
  let skipped = 0;
  for (const r of rows) {
    const col = collections.get(r.collection);
    if (!col) continue;
    const abs = join(col.path, r.real_path);
    const vaultPath = relative(vaultRoot, abs);
    if (vaultPath.startsWith("..") || isAbsolute(vaultPath) || !existsSync(abs)) { skipped++; continue; }
    const file = buildVirtualPath(r.collection, r.path);
    const context = getContextForFile(db, file) ?? undefined;
    const idx = docs.length;
    docs.push({
      path: vaultPath.split(sep).join("/"),
      file,
      collection: r.collection,
      title: r.title,
      docid: r.hash.slice(0, 6),
      ...(context && { context }),
      hash: sha16(readFileSync(abs)),
    });
    docBodies.push(r.body);
    docIndexById.set(r.id, idx);
    const list = docIndexesByHash.get(r.hash) ?? [];
    list.push(idx);
    docIndexesByHash.set(r.hash, list);
  }

  // ---- items: chunk + profile vectors, straight from the index (no re-embedding) ----
  const chunkPos = new Map<string, number>();
  for (const cv of db.prepare(`SELECT hash, seq, pos FROM content_vectors`).all() as { hash: string; seq: number; pos: number }[]) {
    chunkPos.set(`${cv.hash}_${cv.seq}`, cv.pos);
  }

  const items: ExportItem[] = [];
  const vectors: Int8Array[] = [];
  const addItem = (d: number, seq: number, pos: number, embedding: Float32Array) => {
    const body = docBodies[d]!;
    items.push({
      d, seq,
      line: body.slice(0, pos).split("\n").length,
      snippet: body.slice(pos, pos + SNIPPET_CHARS),
    });
    vectors.push(quantize(embedding, dim));
  };

  for (const v of db.prepare(`SELECT hash_seq, embedding FROM vectors_vec`).all() as { hash_seq: string; embedding: Uint8Array }[]) {
    if (v.hash_seq.startsWith(PROFILE_KEY_PREFIX)) {
      const d = docIndexById.get(Number(v.hash_seq.slice(PROFILE_KEY_PREFIX.length)));
      if (d !== undefined) addItem(d, -1, 0, blobToFloats(v.embedding));
      continue;
    }
    const pos = chunkPos.get(v.hash_seq);
    const sepAt = v.hash_seq.lastIndexOf("_");
    const docsForHash = docIndexesByHash.get(v.hash_seq.slice(0, sepAt));
    if (pos === undefined || !docsForHash) continue;
    const seq = Number(v.hash_seq.slice(sepAt + 1));
    const embedding = blobToFloats(v.embedding);
    for (const d of docsForHash) addItem(d, seq, pos, embedding);
  }

  // ---- words: query-side vectors, so a typed query maps to a vector without a model ----
  const words = wordList(docs.map(d => d.title), docBodies);
  const prevWords = previousWordVectors(outDir, model, dim);
  const missing = words.filter(w => !prevWords.has(w));
  const wordVecs = new Map(prevWords);
  if (missing.length > 0) {
    log(`Embedding ${missing.length} words…`);
    const llm = getDefaultLlamaCpp();
    for (let i = 0; i < missing.length; i += WORD_BATCH) {
      const batch = missing.slice(i, i + WORD_BATCH);
      const results = await llm.embedBatch(batch.map(w => formatQueryForEmbedding(w, model)), { model, isQuery: true });
      results.forEach((r, j) => { if (r) wordVecs.set(batch[j]!, quantize(r.embedding, dim)); });
    }
  }
  const exportedWords = words.filter(w => wordVecs.has(w));

  // ---- write ----
  mkdirSync(outDir, { recursive: true });
  const bin = new Int8Array((vectors.length + exportedWords.length) * dim);
  vectors.forEach((v, i) => bin.set(v, i * dim));
  exportedWords.forEach((w, i) => bin.set(wordVecs.get(w)!, (vectors.length + i) * dim));
  const exportedCollections: Record<string, ExportCollection> = {};
  for (const name of new Set(docs.map(d => d.collection))) {
    const section = collections.get(name)?.section;
    exportedCollections[name] = section ? { section: { heading: section.heading, level: section.level } } : {};
  }
  const manifest: Manifest = {
    format: EXPORT_FORMAT, version: EXPORT_VERSION, tool: "qmd", model, dim, scale: SCALE,
    exportedAt: new Date().toISOString(), collections: exportedCollections, docs, items, words: exportedWords,
  };
  writeFileSync(join(outDir, "vectors.bin"), Buffer.from(bin.buffer));
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest));

  log(`${c.green}✓${c.reset} Exported ${docs.length} docs, ${items.length} vectors, ${exportedWords.length} words ` +
    `(${missing.length} newly embedded) → ${relative(vaultRoot, outDir)} (${(bin.length / 1e6).toFixed(1)} MB)`);
  if (skipped > 0) log(`${c.dim}Skipped ${skipped} docs outside the vault${c.reset}`);
}
