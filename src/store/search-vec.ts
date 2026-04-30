// Layer 3: Vector similarity search and embedding storage

import type { Database } from "../db.js";
import { getDocid } from "./documents.js";
import { getContextForFile } from "./context-ops.js";
import type { SearchResult } from "./documents.js";
import {
  getDefaultLlamaCpp, formatQueryForEmbedding, formatDocForEmbedding,
  type ILLMSession, type LlamaCpp,
} from "../llm.js";

async function getEmbedding(
  text: string,
  model: string,
  isQuery: boolean,
  session?: ILLMSession,
  llmOverride?: LlamaCpp
): Promise<number[] | null> {
  const formattedText = isQuery
    ? formatQueryForEmbedding(text, model)
    : formatDocForEmbedding(text, undefined, model);
  const result = session
    ? await session.embed(formattedText, { model, isQuery })
    : await (llmOverride ?? getDefaultLlamaCpp()).embed(formattedText, { model, isQuery });
  return result?.embedding || null;
}

export async function searchVec(
  db: Database,
  query: string,
  model: string,
  limit: number = 20,
  collectionName?: string,
  session?: ILLMSession,
  precomputedEmbedding?: number[]
): Promise<SearchResult[]> {
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  if (!tableExists) return [];

  const embedding = precomputedEmbedding ?? await getEmbedding(query, model, true, session);
  if (!embedding) return [];

  // IMPORTANT: Two-step query — sqlite-vec hangs indefinitely with JOINs.
  // Do NOT combine into a single query. See: https://github.com/tobi/qmd/pull/23
  const vecResults = db.prepare(`
    SELECT hash_seq, distance
    FROM vectors_vec
    WHERE embedding MATCH ? AND k = ?
  `).all(new Float32Array(embedding), limit * 3) as { hash_seq: string; distance: number }[];

  if (vecResults.length === 0) return [];

  const hashSeqs = vecResults.map(r => r.hash_seq);
  const distanceMap = new Map(vecResults.map(r => [r.hash_seq, r.distance]));

  const placeholders = hashSeqs.map(() => '?').join(',');
  let docSql = `
    SELECT
      cv.hash || '_' || cv.seq as hash_seq,
      cv.hash,
      cv.pos,
      'qmd://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title,
      content.doc as body
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash AND d.active = 1
    JOIN content ON content.hash = d.hash
    WHERE cv.hash || '_' || cv.seq IN (${placeholders})
  `;
  const params: string[] = [...hashSeqs];

  if (collectionName) {
    docSql += ` AND d.collection = ?`;
    params.push(collectionName);
  }

  const docRows = db.prepare(docSql).all(...params) as {
    hash_seq: string; hash: string; pos: number; filepath: string;
    display_path: string; title: string; body: string;
  }[];

  const seen = new Map<string, { row: typeof docRows[0]; bestDist: number }>();
  for (const row of docRows) {
    const distance = distanceMap.get(row.hash_seq) ?? 1;
    const existing = seen.get(row.filepath);
    if (!existing || distance < existing.bestDist) {
      seen.set(row.filepath, { row, bestDist: distance });
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => a.bestDist - b.bestDist)
    .slice(0, limit)
    .map(({ row, bestDist }) => {
      const coll = row.filepath.split('//')[1]?.split('/')[0] || "";
      return {
        filepath: row.filepath,
        displayPath: row.display_path,
        title: row.title,
        hash: row.hash,
        docid: getDocid(row.hash),
        collectionName: coll,
        modifiedAt: "",
        bodyLength: row.body.length,
        body: row.body,
        context: getContextForFile(db, row.filepath),
        score: 1 - bestDist,
        source: "vec" as const,
        chunkPos: row.pos,
      };
    });
}

export function getHashesForEmbedding(db: Database): { hash: string; body: string; path: string }[] {
  return db.prepare(`
    SELECT d.hash, c.doc as body, MIN(d.path) as path
    FROM documents d
    JOIN content c ON d.hash = c.hash
    LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
    WHERE d.active = 1 AND v.hash IS NULL
    GROUP BY d.hash
  `).all() as { hash: string; body: string; path: string }[];
}

export function clearAllEmbeddings(db: Database, collection?: string): void {
  if (!collection) {
    db.exec(`DELETE FROM content_vectors`);
    db.exec(`DROP TABLE IF EXISTS vectors_vec`);
    return;
  }

  const exclusiveHashesQuery = `
    SELECT DISTINCT d.hash
    FROM documents d
    WHERE d.collection = ? AND d.active = 1
      AND NOT EXISTS (
        SELECT 1 FROM documents d2
        WHERE d2.hash = d.hash
          AND d2.active = 1
          AND d2.collection != d.collection
      )
  `;

  const vecTableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='vectors_vec'`)
    .get();

  if (vecTableExists) {
    const hashSeqRows = db.prepare(`
      SELECT cv.hash, cv.seq
      FROM content_vectors cv
      WHERE cv.hash IN (${exclusiveHashesQuery})
    `).all(collection) as { hash: string; seq: number }[];

    const delVec = db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`);
    for (const row of hashSeqRows) {
      delVec.run(`${row.hash}_${row.seq}`);
    }
  }

  db.prepare(`
    DELETE FROM content_vectors
    WHERE hash IN (${exclusiveHashesQuery})
  `).run(collection);

  const remaining = db
    .prepare(`SELECT COUNT(*) AS n FROM content_vectors`)
    .get() as { n: number };
  if (remaining.n === 0) {
    db.exec(`DROP TABLE IF EXISTS vectors_vec`);
  }
}

export function insertEmbedding(
  db: Database,
  hash: string,
  seq: number,
  pos: number,
  embedding: Float32Array,
  model: string,
  embeddedAt: string
): void {
  const hashSeq = `${hash}_${seq}`;

  db.prepare(`INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, ?)`)
    .run(hash, seq, pos, model, embeddedAt);

  db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(hashSeq);
  db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(hashSeq, embedding);
}
