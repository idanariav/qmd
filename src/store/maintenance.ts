// Layer 2: Database cleanup and maintenance operations

import type { Database } from "../db.js";
import { isSqliteVecAvailable } from "./db-schema.js";
import { PROFILE_KEY_PREFIX } from "./profiles.js";

export function deleteLLMCache(db: Database): number {
  const result = db.prepare(`DELETE FROM llm_cache`).run();
  return result.changes;
}

export function deleteInactiveDocuments(db: Database): number {
  const result = db.prepare(`DELETE FROM documents WHERE active = 0`).run();
  return result.changes;
}

export function cleanupOrphanedContent(db: Database): number {
  const result = db.prepare(`
    DELETE FROM content
    WHERE hash NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
  `).run();
  return result.changes;
}

export function cleanupOrphanedVectors(db: Database): number {
  if (!isSqliteVecAvailable()) {
    return 0;
  }

  try {
    db.prepare(`SELECT 1 FROM vectors_vec LIMIT 0`).get();
  } catch {
    return 0;
  }

  const orphanedProfiles = cleanupOrphanedProfileVectors(db);

  const countResult = db.prepare(`
    SELECT COUNT(*) as c FROM content_vectors cv
    WHERE NOT EXISTS (
      SELECT 1 FROM documents d WHERE d.hash = cv.hash AND d.active = 1
    )
  `).get() as { c: number };

  if (countResult.c === 0) {
    return orphanedProfiles;
  }

  db.exec(`
    DELETE FROM vectors_vec WHERE hash_seq IN (
      SELECT cv.hash || '_' || cv.seq FROM content_vectors cv
      WHERE NOT EXISTS (
        SELECT 1 FROM documents d WHERE d.hash = cv.hash AND d.active = 1
      )
    )
  `);

  db.exec(`
    DELETE FROM content_vectors WHERE hash NOT IN (
      SELECT hash FROM documents WHERE active = 1
    )
  `);

  return countResult.c + orphanedProfiles;
}

/** Remove profile vectors whose document is gone/inactive or no longer has aliases/description. */
function cleanupOrphanedProfileVectors(db: Database): number {
  const live = `
    SELECT p.doc_id FROM doc_profiles p JOIN documents d ON d.id = p.doc_id
    WHERE d.active = 1 AND (p.aliases != '' OR p.description != '')`;
  const stale = db.prepare(`
    SELECT hash_seq FROM vectors_vec WHERE hash_seq LIKE '${PROFILE_KEY_PREFIX}%'
  `).all() as { hash_seq: string }[];
  const liveIds = new Set((db.prepare(live).all() as { doc_id: number }[]).map(r => r.doc_id));
  const del = db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`);
  let removed = 0;
  for (const { hash_seq } of stale) {
    if (!liveIds.has(Number(hash_seq.slice(PROFILE_KEY_PREFIX.length)))) {
      del.run(hash_seq);
      removed++;
    }
  }
  db.exec(`
    UPDATE doc_profiles SET embedded_hash = NULL, model = NULL, embedded_at = NULL
    WHERE doc_id NOT IN (${live}) AND embedded_hash IS NOT NULL
  `);
  return removed;
}

/**
 * Rebuild `vectors_vec` so deleted slots are reclaimed. sqlite-vec allocates
 * fixed 1024-slot blocks and never frees slots of deleted rows, so SQLite's
 * VACUUM can't shrink the table after orphan cleanup. Returns the number of
 * blocks freed (0 when nothing to compact or sqlite-vec is unavailable).
 */
export function compactVectors(db: Database): number {
  if (!isSqliteVecAvailable()) return 0;

  const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { sql: string } | null;
  if (!tableInfo) return 0;

  const allocated = (db.prepare(`SELECT COUNT(*) as c FROM vectors_vec_chunks`).get() as { c: number }).c;
  const live = (db.prepare(`SELECT COUNT(*) as c FROM vectors_vec_rowids`).get() as { c: number }).c;
  const needed = Math.max(1, Math.ceil(live / 1024));
  if (allocated <= needed) return 0;

  const rows = db.prepare(`SELECT hash_seq, embedding FROM vectors_vec`).all() as { hash_seq: string; embedding: Uint8Array }[];
  db.exec("BEGIN");
  try {
    db.exec(`DROP TABLE vectors_vec`);
    db.exec(tableInfo.sql);
    const insert = db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`);
    for (const row of rows) insert.run(row.hash_seq, row.embedding);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return allocated - (db.prepare(`SELECT COUNT(*) as c FROM vectors_vec_chunks`).get() as { c: number }).c;
}

export function vacuumDatabase(db: Database): void {
  db.exec(`VACUUM`);
}
