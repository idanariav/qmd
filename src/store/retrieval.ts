// Layer 4: Document retrieval — findDocument, getDocumentBody, findDocuments, TOC, DSL filter

import { readFileSync } from "node:fs";
import type { Database } from "../db.js";
import { parseFilter } from "../query/parser.js";
import { compileFilter } from "../query/compile.js";
import { DEFAULT_MULTI_GET_MAX_BYTES } from "./config.js";
import { getStoreCollections } from "./collection-ops.js";
import { homedir } from "./paths.js";
import {
  getDocid, handelize, findSimilarFiles, matchFilesByGlob,
  isDocid, findDocumentByDocid,
  type DocumentResult, type DocumentNotFound, type MultiGetResult,
} from "./documents.js";
import { getContextForFile } from "./context-ops.js";

export type { DocumentNotFound, MultiGetResult };

export interface FindResult {
  collection: string;
  path: string;
  title: string;
  created_at: string;
  modified_at: string;
  word_count: number;
}

export interface TocResult {
  seq: number;
  parent_seq: number | null;
  level: number;
  heading: string;
  slug: string;
  char_offset: number;
}

type DbDocRow = {
  virtual_path: string;
  display_path: string;
  title: string;
  hash: string;
  collection: string;
  path: string;
  modified_at: string;
  body_length: number;
  body?: string;
};

export function resolveRawContent(
  db: Database,
  collectionName: string,
  originalPath: string
): string | null {
  const coll = db.prepare(
    `SELECT path FROM store_collections WHERE name = ?`
  ).get(collectionName) as { path: string } | null;
  if (!coll) return null;
  try {
    return readFileSync(`${coll.path}/${originalPath}`, 'utf-8');
  } catch {
    return null;
  }
}

export function findDocument(
  db: Database,
  filename: string,
  options: { includeBody?: boolean } = {}
): DocumentResult | DocumentNotFound {
  let filepath = filename;
  const colonMatch = filepath.match(/:(\d+)$/);
  if (colonMatch) {
    filepath = filepath.slice(0, -colonMatch[0].length);
  }

  if (isDocid(filepath)) {
    const docidMatch = findDocumentByDocid(db, filepath);
    if (docidMatch) {
      filepath = docidMatch.filepath;
    } else {
      return { error: "not_found", query: filename, similarFiles: [] };
    }
  }

  if (filepath.startsWith('~/')) {
    filepath = homedir() + filepath.slice(1);
  }

  const bodyCol = options.includeBody ? `, content.doc as body` : ``;

  const selectCols = `
    'qmd://' || d.collection || '/' || d.path as virtual_path,
    d.collection || '/' || d.path as display_path,
    d.title,
    d.hash,
    d.collection,
    d.modified_at,
    LENGTH(content.doc) as body_length
    ${bodyCol}
  `;

  let doc = db.prepare(`
    SELECT ${selectCols}
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE 'qmd://' || d.collection || '/' || d.path = ? AND d.active = 1
  `).get(filepath) as DbDocRow | null;

  if (!doc) {
    doc = db.prepare(`
      SELECT ${selectCols}
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'qmd://' || d.collection || '/' || d.path LIKE ? AND d.active = 1
      LIMIT 1
    `).get(`%${filepath}`) as DbDocRow | null;
  }

  if (!doc && !filepath.startsWith('qmd://')) {
    const collections = getStoreCollections(db);
    for (const coll of collections) {
      let relativePath: string | null = null;

      if (filepath.startsWith(coll.path + '/')) {
        relativePath = filepath.slice(coll.path.length + 1);
      } else if (!filepath.startsWith('/')) {
        relativePath = filepath;
      }

      if (relativePath) {
        doc = db.prepare(`
          SELECT ${selectCols}
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(coll.name, relativePath) as DbDocRow | null;

        if (!doc) {
          try {
            const handelizedPath = handelize(relativePath);
            if (handelizedPath !== relativePath) {
              doc = db.prepare(`
                SELECT ${selectCols}
                FROM documents d
                JOIN content ON content.hash = d.hash
                WHERE d.collection = ? AND d.path = ? AND d.active = 1
              `).get(coll.name, handelizedPath) as DbDocRow | null;
            }
          } catch {
            // handelize can throw on invalid paths; ignore and continue
          }
        }

        if (doc) break;
      }
    }
  }

  if (!doc) {
    const similar = findSimilarFiles(db, filepath, 5, 5);
    return { error: "not_found", query: filename, similarFiles: similar };
  }

  const virtualPath = doc.virtual_path || `qmd://${doc.collection}/${doc.display_path}`;
  const context = getContextForFile(db, virtualPath);

  return {
    filepath: virtualPath,
    displayPath: doc.display_path,
    title: doc.title,
    context,
    hash: doc.hash,
    docid: getDocid(doc.hash),
    collectionName: doc.collection,
    modifiedAt: doc.modified_at,
    bodyLength: doc.body_length,
    ...(options.includeBody && doc.body !== undefined && { body: doc.body }),
  };
}

export function getDocumentBody(
  db: Database,
  doc: DocumentResult | { filepath: string },
  fromLine?: number,
  maxLines?: number
): string | null {
  const filepath = doc.filepath;

  let row: { body: string; original_path: string | null; collection: string } | null = null;

  if (filepath.startsWith('qmd://')) {
    row = db.prepare(`
      SELECT content.doc as body, d.original_path, d.collection
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'qmd://' || d.collection || '/' || d.path = ? AND d.active = 1
    `).get(filepath) as { body: string; original_path: string | null; collection: string } | null;
  }

  if (!row) {
    const collections = getStoreCollections(db);
    for (const coll of collections) {
      if (filepath.startsWith(coll.path + '/')) {
        const relativePath = filepath.slice(coll.path.length + 1);
        row = db.prepare(`
          SELECT content.doc as body, d.original_path, d.collection
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(coll.name, relativePath) as { body: string; original_path: string | null; collection: string } | null;
        if (row) break;
      }
    }
  }

  if (!row) return null;

  let body = row.body;
  if (row.original_path) {
    const raw = resolveRawContent(db, row.collection, row.original_path);
    if (raw !== null) body = raw;
  }

  if (fromLine !== undefined || maxLines !== undefined) {
    const lines = body.split('\n');
    const start = (fromLine || 1) - 1;
    const end = maxLines !== undefined ? start + maxLines : lines.length;
    body = lines.slice(start, end).join('\n');
  }

  return body;
}

export function findDocuments(
  db: Database,
  pattern: string,
  options: { includeBody?: boolean; maxBytes?: number } = {}
): { docs: MultiGetResult[]; errors: string[] } {
  const isCommaSeparated = pattern.includes(',') && !pattern.includes('*') && !pattern.includes('?') && !pattern.includes('{');
  const errors: string[] = [];
  const maxBytes = options.maxBytes ?? DEFAULT_MULTI_GET_MAX_BYTES;

  const bodyCol = options.includeBody ? `, content.doc as body` : ``;
  const selectCols = `
    'qmd://' || d.collection || '/' || d.path as virtual_path,
    d.collection || '/' || d.path as display_path,
    d.title,
    d.hash,
    d.collection,
    d.modified_at,
    LENGTH(content.doc) as body_length
    ${bodyCol}
  `;

  let fileRows: DbDocRow[];

  if (isCommaSeparated) {
    const names = pattern.split(',').map(s => s.trim()).filter(Boolean);
    fileRows = [];
    for (const name of names) {
      let doc = db.prepare(`
        SELECT ${selectCols}
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE 'qmd://' || d.collection || '/' || d.path = ? AND d.active = 1
      `).get(name) as DbDocRow | null;
      if (!doc) {
        doc = db.prepare(`
          SELECT ${selectCols}
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE 'qmd://' || d.collection || '/' || d.path LIKE ? AND d.active = 1
          LIMIT 1
        `).get(`%${name}`) as DbDocRow | null;
      }
      if (doc) {
        fileRows.push(doc);
      } else {
        const similar = findSimilarFiles(db, name, 5, 3);
        let msg = `File not found: ${name}`;
        if (similar.length > 0) {
          msg += ` (did you mean: ${similar.join(', ')}?)`;
        }
        errors.push(msg);
      }
    }
  } else {
    const matched = matchFilesByGlob(db, pattern);
    if (matched.length === 0) {
      errors.push(`No files matched pattern: ${pattern}`);
      return { docs: [], errors };
    }
    const virtualPaths = matched.map(m => m.filepath);
    const placeholders = virtualPaths.map(() => '?').join(',');
    fileRows = db.prepare(`
      SELECT ${selectCols}
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'qmd://' || d.collection || '/' || d.path IN (${placeholders}) AND d.active = 1
    `).all(...virtualPaths) as DbDocRow[];
  }

  const results: MultiGetResult[] = [];

  for (const row of fileRows) {
    const virtualPath = row.virtual_path || `qmd://${row.collection}/${row.display_path}`;
    const context = getContextForFile(db, virtualPath);

    if (row.body_length > maxBytes) {
      results.push({
        doc: { filepath: virtualPath, displayPath: row.display_path },
        skipped: true,
        skipReason: `File too large (${Math.round(row.body_length / 1024)}KB > ${Math.round(maxBytes / 1024)}KB)`,
      });
      continue;
    }

    results.push({
      doc: {
        filepath: virtualPath,
        displayPath: row.display_path,
        title: row.title || row.display_path.split('/').pop() || row.display_path,
        context,
        hash: row.hash,
        docid: getDocid(row.hash),
        collectionName: row.collection,
        modifiedAt: row.modified_at,
        bodyLength: row.body_length,
        ...(options.includeBody && row.body !== undefined && { body: row.body }),
      },
      skipped: false,
    });
  }

  return { docs: results, errors };
}

export function findByFilter(
  db: Database,
  filterExpr: string,
  options: { collection?: string; limit?: number } = {}
): FindResult[] {
  const node = parseFilter(filterExpr);
  const { where, params } = compileFilter(node);

  const collectionClause = options.collection
    ? `AND d.collection = '${options.collection.replace(/'/g, "''")}'`
    : "";
  const limitClause = options.limit ? `LIMIT ${options.limit}` : "LIMIT 100";

  const sql = `
    SELECT d.collection, d.path, d.title, d.created_at, d.modified_at, d.word_count
    FROM documents d
    WHERE d.active = 1 ${collectionClause} AND (${where})
    ORDER BY d.modified_at DESC
    ${limitClause}
  `;

  return db.prepare(sql).all(...params) as FindResult[];
}

export function getDocumentToc(db: Database, filepath: string): TocResult[] | null {
  let doc = db.prepare(`
    SELECT id FROM documents
    WHERE (collection || '/' || path = ? OR path = ?) AND active = 1
    LIMIT 1
  `).get(filepath, filepath) as { id: number } | null;

  if (!doc) {
    doc = db.prepare(`
      SELECT id FROM documents
      WHERE (collection || '/' || path LIKE ? OR path LIKE ?) AND active = 1
      LIMIT 1
    `).get(`%${filepath}`, `%${filepath}`) as { id: number } | null;
  }

  if (!doc) return null;

  return db.prepare(`
    SELECT seq, parent_seq, level, heading, slug, char_offset
    FROM sections
    WHERE doc_id = ? AND level > 0 AND heading IS NOT NULL
    ORDER BY seq
  `).all(doc.id) as TocResult[];
}
