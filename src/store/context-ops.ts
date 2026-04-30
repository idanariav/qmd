// Layer 2: Context operations — per-collection and global context management

import type { Database } from "../db.js";
import {
  getStoreCollections, getStoreCollection, getStoreGlobalContext,
  getStoreContexts, updateStoreContext, removeStoreContext, setStoreGlobalContext,
} from "./collection-ops.js";
import { parseVirtualPath } from "./virtual-paths.js";

export function getContextForPath(db: Database, collectionName: string, path: string): string | null {
  const coll = getStoreCollection(db, collectionName);

  if (!coll) return null;

  const contexts: string[] = [];

  const globalCtx = getStoreGlobalContext(db);
  if (globalCtx) {
    contexts.push(globalCtx);
  }

  if (coll.context) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    const matchingContexts: { prefix: string; context: string }[] = [];
    for (const [prefix, context] of Object.entries(coll.context)) {
      const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
      if (normalizedPath.startsWith(normalizedPrefix)) {
        matchingContexts.push({ prefix: normalizedPrefix, context });
      }
    }

    matchingContexts.sort((a, b) => a.prefix.length - b.prefix.length);

    for (const match of matchingContexts) {
      contexts.push(match.context);
    }
  }

  return contexts.length > 0 ? contexts.join('\n\n') : null;
}

export function getContextForFile(db: Database, filepath: string): string | null {
  if (!filepath) return null;

  const collections = getStoreCollections(db);

  let collectionName: string | null = null;
  let relativePath: string | null = null;

  const parsedVirtual = filepath.startsWith('qmd://') ? parseVirtualPath(filepath) : null;
  if (parsedVirtual) {
    collectionName = parsedVirtual.collectionName;
    relativePath = parsedVirtual.path;
  } else {
    for (const coll of collections) {
      if (!coll || !coll.path) continue;

      if (filepath.startsWith(coll.path + '/') || filepath === coll.path) {
        collectionName = coll.name;
        relativePath = filepath.startsWith(coll.path + '/')
          ? filepath.slice(coll.path.length + 1)
          : '';
        break;
      }
    }

    if (!collectionName || relativePath === null) return null;
  }

  const coll = getStoreCollection(db, collectionName);
  if (!coll) return null;

  const doc = db.prepare(`
    SELECT d.path
    FROM documents d
    WHERE d.collection = ? AND d.path = ? AND d.active = 1
    LIMIT 1
  `).get(collectionName, relativePath) as { path: string } | null;

  if (!doc) return null;

  const contexts: string[] = [];

  const globalCtx = getStoreGlobalContext(db);
  if (globalCtx) {
    contexts.push(globalCtx);
  }

  if (coll.context) {
    const normalizedPath = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;

    const matchingContexts: { prefix: string; context: string }[] = [];
    for (const [prefix, context] of Object.entries(coll.context)) {
      const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
      if (normalizedPath.startsWith(normalizedPrefix)) {
        matchingContexts.push({ prefix: normalizedPrefix, context });
      }
    }

    matchingContexts.sort((a, b) => a.prefix.length - b.prefix.length);

    for (const match of matchingContexts) {
      contexts.push(match.context);
    }
  }

  return contexts.length > 0 ? contexts.join('\n\n') : null;
}

export function insertContext(db: Database, collectionId: number, pathPrefix: string, context: string): void {
  const coll = db.prepare(`SELECT name FROM collections WHERE id = ?`).get(collectionId) as { name: string } | null;
  if (!coll) {
    throw new Error(`Collection with id ${collectionId} not found`);
  }

  updateStoreContext(db, coll.name, pathPrefix, context);
}

export function deleteContext(db: Database, collectionName: string, pathPrefix: string): number {
  const success = removeStoreContext(db, collectionName, pathPrefix);
  return success ? 1 : 0;
}

export function deleteGlobalContexts(db: Database): number {
  let deletedCount = 0;

  setStoreGlobalContext(db, undefined);
  deletedCount++;

  const collections = getStoreCollections(db);
  for (const coll of collections) {
    const success = removeStoreContext(db, coll.name, '');
    if (success) {
      deletedCount++;
    }
  }

  return deletedCount;
}

export function listPathContexts(db: Database): { collection_name: string; path_prefix: string; context: string }[] {
  const allContexts = getStoreContexts(db);

  return allContexts.map(ctx => ({
    collection_name: ctx.collection,
    path_prefix: ctx.path,
    context: ctx.context,
  })).sort((a, b) => {
    if (a.collection_name !== b.collection_name) {
      return a.collection_name.localeCompare(b.collection_name);
    }
    if (a.path_prefix.length !== b.path_prefix.length) {
      return b.path_prefix.length - a.path_prefix.length;
    }
    return a.path_prefix.localeCompare(b.path_prefix);
  });
}

export function getAllCollections(db: Database): { name: string }[] {
  const collections = getStoreCollections(db);
  return collections.map(c => ({ name: c.name }));
}

export function getCollectionsWithoutContext(db: Database): { name: string; pwd: string; doc_count: number }[] {
  const allCollections = getStoreCollections(db);

  const collectionsWithoutContext: { name: string; pwd: string; doc_count: number }[] = [];

  for (const coll of allCollections) {
    if (!coll.context || Object.keys(coll.context).length === 0) {
      const stats = db.prepare(`
        SELECT COUNT(d.id) as doc_count
        FROM documents d
        WHERE d.collection = ? AND d.active = 1
      `).get(coll.name) as { doc_count: number } | null;

      collectionsWithoutContext.push({
        name: coll.name,
        pwd: coll.path,
        doc_count: stats?.doc_count || 0,
      });
    }
  }

  return collectionsWithoutContext.sort((a, b) => a.name.localeCompare(b.name));
}

export function getTopLevelPathsWithoutContext(db: Database, collectionName: string): string[] {
  const paths = db.prepare(`
    SELECT DISTINCT path FROM documents
    WHERE collection = ? AND active = 1
  `).all(collectionName) as { path: string }[];

  const dbColl = getStoreCollection(db, collectionName);
  if (!dbColl) return [];

  const contextPrefixes = new Set<string>();
  if (dbColl.context) {
    for (const prefix of Object.keys(dbColl.context)) {
      contextPrefixes.add(prefix);
    }
  }

  const topLevelDirs = new Set<string>();
  for (const { path } of paths) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length > 1) {
      const dir = parts[0];
      if (dir) topLevelDirs.add(dir);
    }
  }

  const missing: string[] = [];
  for (const dir of topLevelDirs) {
    let hasContext = false;

    for (const prefix of contextPrefixes) {
      if (prefix === '' || prefix === dir || dir.startsWith(prefix + '/')) {
        hasContext = true;
        break;
      }
    }

    if (!hasContext) {
      missing.push(dir);
    }
  }

  return missing.sort();
}
