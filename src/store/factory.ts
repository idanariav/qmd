// Layer 5: Store factory — Store type and createStore()

import { openDatabase } from "../db.js";
import type { Database } from "../db.js";
import { registerRegexpUDF } from "../query/compile.js";
import { LlamaCpp } from "../llm.js";
import type { ILLMSession } from "../llm.js";
import { initializeDatabase, ensureVecTableInternal } from "./db-schema.js";
import { getDefaultDbPath } from "./paths.js";
import { getCacheKey, getCachedResult, setCachedResult, clearCache } from "./cache.js";
import { getHashesNeedingEmbedding, getIndexHealth, getStatus } from "./health.js";
import {
  deleteLLMCache, deleteInactiveDocuments, cleanupOrphanedContent,
  cleanupOrphanedVectors, vacuumDatabase,
} from "./maintenance.js";
import { getContextForFile, getContextForPath, getCollectionsWithoutContext, getTopLevelPathsWithoutContext } from "./context-ops.js";
import { getCollectionByName } from "./collection-ops.js";
import {
  parseVirtualPath, buildVirtualPath, isVirtualPath,
  resolveVirtualPath, toVirtualPath,
} from "./virtual-paths.js";
import { searchFTS } from "./search-fts.js";
import { searchVec, getHashesForEmbedding, clearAllEmbeddings, insertEmbedding } from "./search-vec.js";
import { expandQuery, rerank } from "./search-ops.js";
import {
  findDocument, getDocumentBody, findDocuments, findByFilter, getDocumentToc,
} from "./retrieval.js";
import {
  findSimilarFiles, matchFilesByGlob, findDocumentByDocid,
  insertContent, insertDocument, findActiveDocument, findOrMigrateLegacyDocument,
  updateDocumentTitle, updateDocument, deactivateDocument, getActiveDocumentPaths,
  type DocumentResult, type DocumentNotFound, type MultiGetResult,
} from "./documents.js";
import type { SearchResult } from "./documents.js";
import type { IndexHealthInfo, CollectionInfo, IndexStatus } from "./health.js";
import type { FindResult, TocResult } from "./retrieval.js";

export type { IndexHealthInfo, CollectionInfo, IndexStatus };

export type Store = {
  db: Database;
  dbPath: string;
  llm?: LlamaCpp;
  close: () => void;
  ensureVecTable: (dimensions: number) => void;

  getHashesNeedingEmbedding: () => number;
  getIndexHealth: () => IndexHealthInfo;
  getStatus: () => IndexStatus;

  getCacheKey: typeof getCacheKey;
  getCachedResult: (cacheKey: string) => string | null;
  setCachedResult: (cacheKey: string, result: string) => void;
  clearCache: () => void;

  deleteLLMCache: () => number;
  deleteInactiveDocuments: () => number;
  cleanupOrphanedContent: () => number;
  cleanupOrphanedVectors: () => number;
  vacuumDatabase: () => void;

  getContextForFile: (filepath: string) => string | null;
  getContextForPath: (collectionName: string, path: string) => string | null;
  getCollectionByName: (name: string) => { name: string; pwd: string; glob_pattern: string } | null;
  getCollectionsWithoutContext: () => { name: string; pwd: string; doc_count: number }[];
  getTopLevelPathsWithoutContext: (collectionName: string) => string[];

  parseVirtualPath: typeof parseVirtualPath;
  buildVirtualPath: typeof buildVirtualPath;
  isVirtualPath: typeof isVirtualPath;
  resolveVirtualPath: (virtualPath: string) => string | null;
  toVirtualPath: (absolutePath: string) => string | null;

  searchFTS: (query: string, limit?: number, collectionName?: string) => SearchResult[];
  searchVec: (query: string, model: string, limit?: number, collectionName?: string, session?: ILLMSession, precomputedEmbedding?: number[]) => Promise<SearchResult[]>;

  expandQuery: (query: string, model?: string, intent?: string) => Promise<import("./config.js").ExpandedQuery[]>;
  rerank: (query: string, documents: { file: string; text: string }[], model?: string, intent?: string) => Promise<{ file: string; score: number }[]>;

  findDocument: (filename: string, options?: { includeBody?: boolean }) => DocumentResult | DocumentNotFound;
  getDocumentBody: (doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number) => string | null;
  findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => { docs: MultiGetResult[]; errors: string[] };

  findByFilter: (filterExpr: string, options?: { collection?: string; limit?: number }) => FindResult[];
  getDocumentToc: (filepath: string) => TocResult[] | null;

  findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => string[];
  matchFilesByGlob: (pattern: string) => { filepath: string; displayPath: string; bodyLength: number }[];
  findDocumentByDocid: (docid: string) => { filepath: string; hash: string } | null;

  insertContent: (hash: string, content: string, createdAt: string) => void;
  insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string, originalPath?: string | null) => void;
  findActiveDocument: (collectionName: string, path: string) => { id: number; hash: string; title: string } | null;
  findOrMigrateLegacyDocument: (collectionName: string, path: string) => { id: number; hash: string; title: string } | null;
  updateDocumentTitle: (documentId: number, title: string, modifiedAt: string, originalPath?: string | null) => void;
  updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string, originalPath?: string | null) => void;
  deactivateDocument: (collectionName: string, path: string) => void;
  getActiveDocumentPaths: (collectionName: string) => string[];

  getHashesForEmbedding: () => { hash: string; body: string; path: string }[];
  clearAllEmbeddings: () => void;
  insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string) => void;
};

export function createStore(dbPath?: string): Store {
  const resolvedPath = dbPath || getDefaultDbPath();
  const db = openDatabase(resolvedPath);
  initializeDatabase(db);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerRegexpUDF(db as any);

  const store: Store = {
    db,
    dbPath: resolvedPath,
    close: () => db.close(),
    ensureVecTable: (dimensions: number) => ensureVecTableInternal(db, dimensions),

    getHashesNeedingEmbedding: () => getHashesNeedingEmbedding(db),
    getIndexHealth: () => getIndexHealth(db),
    getStatus: () => getStatus(db),

    getCacheKey,
    getCachedResult: (cacheKey: string) => getCachedResult(db, cacheKey),
    setCachedResult: (cacheKey: string, result: string) => setCachedResult(db, cacheKey, result),
    clearCache: () => clearCache(db),

    deleteLLMCache: () => deleteLLMCache(db),
    deleteInactiveDocuments: () => deleteInactiveDocuments(db),
    cleanupOrphanedContent: () => cleanupOrphanedContent(db),
    cleanupOrphanedVectors: () => cleanupOrphanedVectors(db),
    vacuumDatabase: () => vacuumDatabase(db),

    getContextForFile: (filepath: string) => getContextForFile(db, filepath),
    getContextForPath: (collectionName: string, path: string) => getContextForPath(db, collectionName, path),
    getCollectionByName: (name: string) => getCollectionByName(db, name),
    getCollectionsWithoutContext: () => getCollectionsWithoutContext(db),
    getTopLevelPathsWithoutContext: (collectionName: string) => getTopLevelPathsWithoutContext(db, collectionName),

    parseVirtualPath,
    buildVirtualPath,
    isVirtualPath,
    resolveVirtualPath: (virtualPath: string) => resolveVirtualPath(db, virtualPath),
    toVirtualPath: (absolutePath: string) => toVirtualPath(db, absolutePath),

    searchFTS: (query: string, limit?: number, collectionName?: string) => searchFTS(db, query, limit, collectionName),
    searchVec: (query: string, model: string, limit?: number, collectionName?: string, session?: ILLMSession, precomputedEmbedding?: number[]) => searchVec(db, query, model, limit, collectionName, session, precomputedEmbedding),

    expandQuery: (query: string, model?: string, intent?: string) => expandQuery(query, model, db, intent, store.llm),
    rerank: (query: string, documents: { file: string; text: string }[], model?: string, intent?: string) => rerank(query, documents, model, db, intent, store.llm),

    findDocument: (filename: string, options?: { includeBody?: boolean }) => findDocument(db, filename, options),
    getDocumentBody: (doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number) => getDocumentBody(db, doc, fromLine, maxLines),
    findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => findDocuments(db, pattern, options),

    findByFilter: (filterExpr: string, options?: { collection?: string; limit?: number }) => findByFilter(db, filterExpr, options),
    getDocumentToc: (filepath: string) => getDocumentToc(db, filepath),

    findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => findSimilarFiles(db, query, maxDistance, limit),
    matchFilesByGlob: (pattern: string) => matchFilesByGlob(db, pattern),
    findDocumentByDocid: (docid: string) => findDocumentByDocid(db, docid),

    insertContent: (hash: string, content: string, createdAt: string) => insertContent(db, hash, content, createdAt),
    insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string) => insertDocument(db, collectionName, path, title, hash, createdAt, modifiedAt),
    findActiveDocument: (collectionName: string, path: string) => findActiveDocument(db, collectionName, path),
    findOrMigrateLegacyDocument: (collectionName: string, path: string) => findOrMigrateLegacyDocument(db, collectionName, path),
    updateDocumentTitle: (documentId: number, title: string, modifiedAt: string) => updateDocumentTitle(db, documentId, title, modifiedAt),
    updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => updateDocument(db, documentId, title, hash, modifiedAt),
    deactivateDocument: (collectionName: string, path: string) => deactivateDocument(db, collectionName, path),
    getActiveDocumentPaths: (collectionName: string) => getActiveDocumentPaths(db, collectionName),

    getHashesForEmbedding: () => getHashesForEmbedding(db),
    clearAllEmbeddings: () => clearAllEmbeddings(db),
    insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string) => insertEmbedding(db, hash, seq, pos, embedding, model, embeddedAt),
  };

  return store;
}
