// Layer 2: Document types, helpers, CRUD, and chunking functions

import { createHash } from "crypto";
import { readFileSync } from "node:fs";
import picomatch from "picomatch";
import type { Database } from "../db.js";
import { extractFrontmatter } from "./frontmatter-helpers.js";
import {
  CHUNK_SIZE_CHARS, CHUNK_OVERLAP_CHARS, CHUNK_WINDOW_CHARS,
  CHUNK_SIZE_TOKENS, CHUNK_OVERLAP_TOKENS, CHUNK_WINDOW_TOKENS,
} from "./config.js";
import {
  scanBreakPoints, findListBreakPoints, findCodeFences, findXmlTagBreakPoints,
  mergeBreakPoints, chunkDocumentWithBreakPoints, type ChunkStrategy,
} from "./chunking.js";
import { parseFrontmatter } from "../parse/frontmatter.js";
import { parseStructure } from "../parse/structure.js";
import { getDefaultLlamaCpp, formatQueryForEmbedding, formatDocForEmbedding } from "../llm.js";

export { formatQueryForEmbedding, formatDocForEmbedding };

// =============================================================================
// Core Document Types
// =============================================================================

export type DocumentResult = {
  filepath: string;
  displayPath: string;
  title: string;
  context: string | null;
  hash: string;
  docid: string;
  collectionName: string;
  modifiedAt: string;
  bodyLength: number;
  body?: string;
};

export type SearchResult = DocumentResult & {
  score: number;
  source: "fts" | "vec";
  chunkPos?: number;
};

export type RankedResult = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
};

export type RRFContributionTrace = {
  listIndex: number;
  source: "fts" | "vec";
  queryType: "original" | "lex" | "vec" | "hyde";
  query: string;
  rank: number;
  weight: number;
  backendScore: number;
  rrfContribution: number;
};

export type RRFScoreTrace = {
  contributions: RRFContributionTrace[];
  baseScore: number;
  topRank: number;
  topRankBonus: number;
  totalScore: number;
};

export type HybridQueryExplain = {
  ftsScores: number[];
  vectorScores: number[];
  rrf: {
    rank: number;
    positionScore: number;
    weight: number;
    baseScore: number;
    topRankBonus: number;
    totalScore: number;
    contributions: RRFContributionTrace[];
  };
  rerankScore: number;
  blendedScore: number;
};

export type DocumentNotFound = {
  error: "not_found";
  query: string;
  similarFiles: string[];
};

export type MultiGetResult = {
  doc: DocumentResult;
  skipped: false;
} | {
  doc: Pick<DocumentResult, "filepath" | "displayPath">;
  skipped: true;
  skipReason: string;
};

// =============================================================================
// Document helpers
// =============================================================================

export function getDocid(hash: string): string {
  return hash.slice(0, 6);
}

export async function hashContent(content: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

function emojiToHex(str: string): string {
  return str.replace(/(?:\p{So}\p{Mn}?|\p{Sk})+/gu, (run) => {
    return [...run].filter(c => /\p{So}|\p{Sk}/u.test(c))
      .map(c => c.codePointAt(0)!.toString(16)).join('-');
  });
}

export function handelize(path: string): string {
  if (!path || path.trim() === '') {
    throw new Error('handelize: path cannot be empty');
  }

  const segments = path.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] || '';
  const filenameWithoutExt = lastSegment.replace(/\.[^.]+$/, '');
  const hasValidContent = /[\p{L}\p{N}\p{So}\p{Sk}$]/u.test(filenameWithoutExt);
  if (!hasValidContent) {
    throw new Error(`handelize: path "${path}" has no valid filename content`);
  }

  const result = path
    .replace(/___/g, '/')
    .split('/')
    .map((segment, idx, arr) => {
      const isLastSegment = idx === arr.length - 1;
      segment = emojiToHex(segment);

      if (isLastSegment) {
        const extMatch = segment.match(/(\.[a-z0-9]+)$/i);
        const ext = extMatch ? extMatch[1] : '';
        const nameWithoutExt = ext ? segment.slice(0, -ext.length) : segment;
        const cleanedName = nameWithoutExt
          .replace(/[^\p{L}\p{N}$]+/gu, '-')
          .replace(/^-+|-+$/g, '');
        return cleanedName + ext;
      } else {
        return segment
          .replace(/[^\p{L}\p{N}$]+/gu, '-')
          .replace(/^-+|-+$/g, '');
      }
    })
    .filter(Boolean)
    .join('/');

  if (!result) {
    throw new Error(`handelize: path "${path}" resulted in empty string after processing`);
  }

  return result;
}

const titleExtractors: Record<string, (content: string) => string | null> = {
  '.md': (content) => {
    const match = content.match(/^##?\s+(.+)$/m);
    if (match) {
      const title = (match[1] ?? "").trim();
      if (title === "📝 Notes" || title === "Notes") {
        const nextMatch = content.match(/^##\s+(.+)$/m);
        if (nextMatch?.[1]) return nextMatch[1].trim();
      }
      return title;
    }
    return null;
  },
  '.org': (content) => {
    const titleProp = content.match(/^#\+TITLE:\s*(.+)$/im);
    if (titleProp?.[1]) return titleProp[1].trim();
    const heading = content.match(/^\*+\s+(.+)$/m);
    if (heading?.[1]) return heading[1].trim();
    return null;
  },
};

export function extractTitle(content: string, filename: string): string {
  const frontmatter = extractFrontmatter(content);
  const frontmatterTitle = frontmatter?.data?.title;
  if (typeof frontmatterTitle === "string" && frontmatterTitle.trim().length > 0) {
    return frontmatterTitle.trim();
  }

  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  const extractor = titleExtractors[ext];
  const bodyContent = frontmatter?.body ?? content;
  if (extractor) {
    const title = extractor(bodyContent);
    if (title) return title;
  }
  return filename.replace(/\.[^.]+$/, "").split("/").pop() || filename;
}

// =============================================================================
// Docid helpers
// =============================================================================

export function normalizeDocid(docid: string): string {
  let normalized = docid.trim();

  if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1);
  }

  if (normalized.startsWith('#')) {
    normalized = normalized.slice(1);
  }

  return normalized;
}

export function isDocid(input: string): boolean {
  const normalized = normalizeDocid(input);
  return normalized.length >= 6 && /^[a-f0-9]+$/i.test(normalized);
}

export function findDocumentByDocid(db: Database, docid: string): { filepath: string; hash: string } | null {
  const shortHash = normalizeDocid(docid);

  if (shortHash.length < 1) return null;

  const doc = db.prepare(`
    SELECT 'qmd://' || d.collection || '/' || d.path as filepath, d.hash
    FROM documents d
    WHERE d.hash LIKE ? AND d.active = 1
    LIMIT 1
  `).get(`${shortHash}%`) as { filepath: string; hash: string } | null;

  return doc;
}

// =============================================================================
// Fuzzy matching
// =============================================================================

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }
  return dp[m]![n]!;
}

export function findSimilarFiles(db: Database, query: string, maxDistance: number = 3, limit: number = 5): string[] {
  const allFiles = db.prepare(`
    SELECT d.path
    FROM documents d
    WHERE d.active = 1
  `).all() as { path: string }[];
  const queryLower = query.toLowerCase();
  const scored = allFiles
    .map(f => ({ path: f.path, dist: levenshtein(f.path.toLowerCase(), queryLower) }))
    .filter(f => f.dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
  return scored.map(f => f.path);
}

export function matchFilesByGlob(db: Database, pattern: string): { filepath: string; displayPath: string; bodyLength: number }[] {
  const allFiles = db.prepare(`
    SELECT
      'qmd://' || d.collection || '/' || d.path as virtual_path,
      LENGTH(content.doc) as body_length,
      d.path,
      d.collection
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1
  `).all() as { virtual_path: string; body_length: number; path: string; collection: string }[];

  const isMatch = picomatch(pattern);
  return allFiles
    .filter(f => isMatch(f.virtual_path) || isMatch(f.path) || isMatch(f.collection + '/' + f.path))
    .map(f => ({
      filepath: f.virtual_path,
      displayPath: f.path,
      bodyLength: f.body_length
    }));
}

// =============================================================================
// Document CRUD
// =============================================================================

export function insertContent(db: Database, hash: string, content: string, createdAt: string): void {
  db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`)
    .run(hash, content, createdAt);
}

export function insertDocument(
  db: Database,
  collectionName: string,
  path: string,
  title: string,
  hash: string,
  createdAt: string,
  modifiedAt: string,
  originalPath?: string | null
): void {
  db.prepare(`
    INSERT INTO documents (collection, path, original_path, title, hash, created_at, modified_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(collection, path) DO UPDATE SET
      original_path = excluded.original_path,
      title = excluded.title,
      hash = excluded.hash,
      modified_at = excluded.modified_at,
      active = 1
  `).run(collectionName, path, originalPath ?? null, title, hash, createdAt, modifiedAt);
}

export function findActiveDocument(
  db: Database,
  collectionName: string,
  path: string
): { id: number; hash: string; title: string } | null {
  const row = db.prepare(`
    SELECT id, hash, title FROM documents
    WHERE collection = ? AND path = ? AND active = 1
  `).get(collectionName, path) as { id: number; hash: string; title: string } | undefined;
  return row ?? null;
}

export function findOrMigrateLegacyDocument(
  db: Database,
  collectionName: string,
  path: string
): { id: number; hash: string; title: string } | null {
  const existing = findActiveDocument(db, collectionName, path);
  if (existing) return existing;

  const legacyPath = path.toLowerCase();
  if (legacyPath === path) return null;

  const legacy = findActiveDocument(db, collectionName, legacyPath);
  if (!legacy) return null;

  const migrate = db.transaction(() => {
    const result = db.prepare(
      `UPDATE OR IGNORE documents SET path = ? WHERE id = ? AND active = 1`
    ).run(path, legacy.id);

    if (result.changes === 0) return false;

    db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`).run(legacy.id);
    db.prepare(`
      INSERT INTO documents_fts(rowid, filepath, title, body)
      SELECT id, collection || '/' || path, title,
             (SELECT doc FROM content WHERE hash = documents.hash)
      FROM documents WHERE id = ?
    `).run(legacy.id);

    return true;
  });

  if (!migrate()) return null;

  return findActiveDocument(db, collectionName, path);
}

export function updateDocumentTitle(
  db: Database,
  documentId: number,
  title: string,
  modifiedAt: string,
  originalPath?: string | null
): void {
  db.prepare(`UPDATE documents SET title = ?, modified_at = ?, original_path = COALESCE(?, original_path) WHERE id = ?`)
    .run(title, modifiedAt, originalPath ?? null, documentId);
}

export function updateDocument(
  db: Database,
  documentId: number,
  title: string,
  hash: string,
  modifiedAt: string,
  originalPath?: string | null
): void {
  db.prepare(`UPDATE documents SET title = ?, hash = ?, modified_at = ?, original_path = COALESCE(?, original_path) WHERE id = ?`)
    .run(title, hash, modifiedAt, originalPath ?? null, documentId);
}

export function upsertDocumentMetadata(
  db: Database,
  docId: number,
  fm: ReturnType<typeof parseFrontmatter>,
  structure: ReturnType<typeof parseStructure>
): void {
  db.prepare(`DELETE FROM frontmatter WHERE doc_id = ?`).run(docId);
  db.prepare(`DELETE FROM tags WHERE doc_id = ?`).run(docId);
  db.prepare(`DELETE FROM sections WHERE doc_id = ?`).run(docId);
  db.prepare(`DELETE FROM wikilinks WHERE doc_id = ?`).run(docId);

  const totalWords = structure.sections.reduce((s, sec) => s + sec.word_count, 0);
  db.prepare(`UPDATE documents SET word_count = ? WHERE id = ?`).run(totalWords, docId);

  const fmStmt = db.prepare(`
    INSERT INTO frontmatter (doc_id, key, value_text, value_num, value_date, is_array)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of fm.rows) {
    fmStmt.run(docId, row.key, row.value_text, row.value_num ?? null, row.value_date ?? null, row.is_array ? 1 : 0);
  }

  const tagStmt = db.prepare(`INSERT OR IGNORE INTO tags (doc_id, tag) VALUES (?, ?)`);
  for (const tag of fm.tags) {
    tagStmt.run(docId, tag);
  }

  const secStmt = db.prepare(`
    INSERT INTO sections (doc_id, seq, parent_seq, level, heading, slug, body, body_no_callouts, word_count, char_offset)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const calStmt = db.prepare(`
    INSERT INTO callouts (doc_id, section_id, kind, title, body) VALUES (?, ?, ?, ?, ?)
  `);
  for (const sec of structure.sections) {
    const result = secStmt.run(
      docId, sec.seq, sec.parent_seq ?? null, sec.level,
      sec.heading ?? null, sec.slug ?? null,
      sec.body, sec.body_no_callouts, sec.word_count, sec.char_offset
    );
    const sectionId = Number(result.lastInsertRowid);
    for (const cal of sec.callouts) {
      calStmt.run(docId, sectionId, cal.kind, cal.title ?? null, cal.body);
    }
  }

  const wlStmt = db.prepare(`INSERT INTO wikilinks (doc_id, target, anchor) VALUES (?, ?, ?)`);
  for (const wl of structure.wikilinks) {
    wlStmt.run(docId, wl.target, wl.anchor ?? null);
  }
}

export function deactivateDocument(db: Database, collectionName: string, path: string): void {
  db.prepare(`UPDATE documents SET active = 0 WHERE collection = ? AND path = ? AND active = 1`)
    .run(collectionName, path);
}

export function getActiveDocumentPaths(db: Database, collectionName: string): string[] {
  const rows = db.prepare(`
    SELECT path FROM documents WHERE collection = ? AND active = 1
  `).all(collectionName) as { path: string }[];
  return rows.map(r => r.path);
}

// =============================================================================
// Chunking (high-level — depends on primitives in chunking.ts)
// =============================================================================

export function chunkDocument(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS
): { text: string; pos: number }[] {
  const regexPoints = scanBreakPoints(content);
  const listPoints = findListBreakPoints(content);
  const protectedRegions = findCodeFences(content);
  const tagPoints = findXmlTagBreakPoints(content, protectedRegions);
  const breakPoints = mergeBreakPoints(mergeBreakPoints(regexPoints, listPoints), tagPoints);
  return chunkDocumentWithBreakPoints(content, breakPoints, protectedRegions, maxChars, overlapChars, windowChars);
}

export async function chunkDocumentAsync(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS,
  filepath?: string,
  chunkStrategy: ChunkStrategy = "regex",
): Promise<{ text: string; pos: number }[]> {
  const regexPoints = scanBreakPoints(content);
  const listPoints = findListBreakPoints(content);
  const protectedRegions = findCodeFences(content);
  const tagPoints = findXmlTagBreakPoints(content, protectedRegions);

  let breakPoints = mergeBreakPoints(mergeBreakPoints(regexPoints, listPoints), tagPoints);
  if (chunkStrategy === "auto" && filepath) {
    const { getASTBreakPoints } = await import("../ast.js");
    const astPoints = await getASTBreakPoints(content, filepath);
    if (astPoints.length > 0) {
      breakPoints = mergeBreakPoints(breakPoints, astPoints);
    }
  }

  return chunkDocumentWithBreakPoints(content, breakPoints, protectedRegions, maxChars, overlapChars, windowChars);
}

export async function chunkDocumentByTokens(
  content: string,
  maxTokens: number = CHUNK_SIZE_TOKENS,
  overlapTokens: number = CHUNK_OVERLAP_TOKENS,
  windowTokens: number = CHUNK_WINDOW_TOKENS,
  filepath?: string,
  chunkStrategy: ChunkStrategy = "regex",
  signal?: AbortSignal
): Promise<{ text: string; pos: number; tokens: number }[]> {
  const llm = getDefaultLlamaCpp();

  const avgCharsPerToken = 3;
  const maxChars = maxTokens * avgCharsPerToken;
  const overlapChars = overlapTokens * avgCharsPerToken;
  const windowChars = windowTokens * avgCharsPerToken;

  let charChunks = await chunkDocumentAsync(content, maxChars, overlapChars, windowChars, filepath, chunkStrategy);

  const results: { text: string; pos: number; tokens: number }[] = [];
  const clampOverlapChars = (value: number, maxChars: number): number => {
    if (maxChars <= 1) return 0;
    return Math.max(0, Math.min(maxChars - 1, Math.floor(value)));
  };

  const pushChunkWithinTokenLimit = async (text: string, pos: number): Promise<void> => {
    if (signal?.aborted) return;

    const tokens = await llm.tokenize(text);
    if (tokens.length <= maxTokens || text.length <= 1) {
      results.push({ text, pos, tokens: tokens.length });
      return;
    }

    const actualCharsPerToken = text.length / tokens.length;
    let safeMaxChars = Math.floor(maxTokens * actualCharsPerToken * 0.95);
    if (!Number.isFinite(safeMaxChars) || safeMaxChars < 1) {
      safeMaxChars = Math.floor(text.length / 2);
    }
    safeMaxChars = Math.max(1, Math.min(text.length - 1, safeMaxChars));

    let nextOverlapChars = clampOverlapChars(
      overlapChars * actualCharsPerToken / 2,
      safeMaxChars,
    );
    let nextWindowChars = Math.max(0, Math.floor(windowChars * actualCharsPerToken / 2));
    let subChunks = chunkDocument(text, safeMaxChars, nextOverlapChars, nextWindowChars);

    if (
      subChunks.length <= 1
      || subChunks[0]?.text.length === text.length
    ) {
      safeMaxChars = Math.max(1, Math.floor(text.length / 2));
      nextOverlapChars = 0;
      nextWindowChars = 0;
      subChunks = chunkDocument(text, safeMaxChars, nextOverlapChars, nextWindowChars);
    }

    if (
      subChunks.length <= 1
      || subChunks[0]?.text.length === text.length
    ) {
      const fallbackTokens = tokens.slice(0, Math.max(1, maxTokens));
      const truncatedText = await llm.detokenize(fallbackTokens);
      results.push({
        text: truncatedText,
        pos,
        tokens: fallbackTokens.length,
      });
      return;
    }

    for (const subChunk of subChunks) {
      await pushChunkWithinTokenLimit(text.slice(subChunk.pos, subChunk.pos + subChunk.text.length), pos + subChunk.pos);
    }
  };

  for (const chunk of charChunks) {
    await pushChunkWithinTokenLimit(chunk.text, chunk.pos);
  }

  return results;
}
