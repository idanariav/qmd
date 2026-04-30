// CLI store/DB lifecycle — singleton store, model resolution, index switching

import type { Database } from "../db.js";
import { resolve as pathResolve } from "path";
import {
  createStore,
  getDefaultDbPath,
  syncConfigToDb,
} from "../store.js";
import {
  LlamaCpp,
  setDefaultLlamaCpp,
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_GENERATE_MODEL_URI,
  DEFAULT_RERANK_MODEL_URI,
} from "../llm.js";
import { loadConfig, setConfigIndexName } from "../collections.js";

let store: ReturnType<typeof createStore> | null = null;
let storeDbPathOverride: string | undefined;
let currentIndexName = "index";

export const models = {
  embed: DEFAULT_EMBED_MODEL_URI,
  generate: DEFAULT_GENERATE_MODEL_URI,
  rerank: DEFAULT_RERANK_MODEL_URI,
};

export function getStore(): ReturnType<typeof createStore> {
  if (!store) {
    store = createStore(storeDbPathOverride);
    try {
      const config = loadConfig();
      models.embed = config.models?.embed || process.env.QMD_EMBED_MODEL || DEFAULT_EMBED_MODEL_URI;
      models.generate = config.models?.generate || process.env.QMD_GENERATE_MODEL || DEFAULT_GENERATE_MODEL_URI;
      models.rerank = config.models?.rerank || process.env.QMD_RERANK_MODEL || DEFAULT_RERANK_MODEL_URI;
      syncConfigToDb(store.db, config);
      if (config.models) {
        setDefaultLlamaCpp(new LlamaCpp({
          embedModel: models.embed,
          generateModel: models.generate,
          rerankModel: models.rerank,
        }));
      }
    } catch {
      models.embed = process.env.QMD_EMBED_MODEL || DEFAULT_EMBED_MODEL_URI;
      models.generate = process.env.QMD_GENERATE_MODEL || DEFAULT_GENERATE_MODEL_URI;
      models.rerank = process.env.QMD_RERANK_MODEL || DEFAULT_RERANK_MODEL_URI;
    }
  }
  return store;
}

export function getDb(): Database {
  return getStore().db;
}

export function resyncConfig(): void {
  const s = getStore();
  try {
    const config = loadConfig();
    // Clear config hash to force re-sync after CLI mutations
    s.db.prepare(`DELETE FROM store_config WHERE key = 'config_hash'`).run();
    syncConfigToDb(s.db, config);
  } catch {
    // Config may not exist yet
  }
}

export function closeDb(): void {
  if (store) {
    store.close();
    store = null;
  }
}

export function getDbPath(): string {
  return store?.dbPath ?? storeDbPathOverride ?? getDefaultDbPath();
}

export function getActiveIndexName(): string {
  return currentIndexName;
}

export function setIndexName(name: string | null): void {
  let normalizedName = name;
  if (name && name.includes('/')) {
    const absolutePath = pathResolve(process.cwd(), name);
    normalizedName = absolutePath.replace(/\//g, '_').replace(/^_/, '');
  }
  currentIndexName = normalizedName || "index";
  storeDbPathOverride = normalizedName ? getDefaultDbPath(normalizedName) : undefined;
  closeDb();
}

export function ensureVecTable(_db: Database, dimensions: number): void {
  getStore().ensureVecTable(dimensions);
}
