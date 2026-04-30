// Layer 1: database initialization, sqlite-vec loading, schema creation

import { loadSqliteVec } from "../db.js";
import type { Database } from "../db.js";

function createSqliteVecUnavailableError(reason: string): Error {
  return new Error(
    "sqlite-vec extension is unavailable. " +
    `${reason}. ` +
    "Install Homebrew SQLite so the sqlite-vec extension can be loaded, " +
    "and set BREW_PREFIX if Homebrew is installed in a non-standard location."
  );
}

let _sqliteVecUnavailableReason: string | null = null;

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function verifySqliteVecLoaded(db: Database): void {
  try {
    const row = db.prepare(`SELECT vec_version() AS version`).get() as { version?: string } | null;
    if (!row?.version || typeof row.version !== "string") {
      throw new Error("vec_version() returned no version");
    }
  } catch (err) {
    const message = getErrorMessage(err);
    throw createSqliteVecUnavailableError(`sqlite-vec probe failed (${message})`);
  }
}

let _sqliteVecAvailable: boolean | null = null;

export function initializeDatabase(db: Database): void {
  try {
    loadSqliteVec(db);
    verifySqliteVecLoaded(db);
    _sqliteVecAvailable = true;
    _sqliteVecUnavailableReason = null;
  } catch (err) {
    // sqlite-vec is optional — vector search won't work but FTS is fine
    _sqliteVecAvailable = false;
    _sqliteVecUnavailableReason = getErrorMessage(err);
    console.warn(_sqliteVecUnavailableReason);
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Drop legacy tables that are now managed in YAML
  db.exec(`DROP TABLE IF EXISTS path_contexts`);
  db.exec(`DROP TABLE IF EXISTS collections`);

  // Content-addressable storage - the source of truth for document content
  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Documents table - file system layer mapping virtual paths to content hashes
  // Collections are now managed in ~/.config/qmd/index.yml
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      original_path TEXT,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
      UNIQUE(collection, path)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection, active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path, active)`);

  // Migration: add original_path for existing databases
  {
    const cols = (db.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[]).map(c => c.name);
    if (!cols.includes('original_path')) {
      db.exec(`ALTER TABLE documents ADD COLUMN original_path TEXT`);
    }
  }

  // Cache table for LLM API calls
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (
      hash TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Content vectors
  const cvInfo = db.prepare(`PRAGMA table_info(content_vectors)`).all() as { name: string }[];
  const hasSeqColumn = cvInfo.some(col => col.name === 'seq');
  if (cvInfo.length > 0 && !hasSeqColumn) {
    db.exec(`DROP TABLE IF EXISTS content_vectors`);
    db.exec(`DROP TABLE IF EXISTS vectors_vec`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    )
  `);

  // Store collections — makes the DB self-contained (no external config needed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_collections (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      pattern TEXT NOT NULL DEFAULT '**/*.md',
      ignore_patterns TEXT,
      include_by_default INTEGER DEFAULT 1,
      update_command TEXT,
      context TEXT,
      section TEXT
    )
  `);

  // Migration: add section column if missing (for existing databases)
  const cols = db.prepare(`PRAGMA table_info(store_collections)`).all() as { name: string }[];
  if (!cols.some(c => c.name === 'section')) {
    db.exec(`ALTER TABLE store_collections ADD COLUMN section TEXT`);
  }

  // Store config — key-value metadata (e.g. config_hash for sync optimization)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // FTS - index filepath (collection/path), title, and content
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      filepath, title, body,
      tokenize='porter unicode61'
    )
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents
    WHEN new.active = 1
    BEGIN
      INSERT INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      DELETE FROM documents_fts WHERE rowid = old.id;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents
    BEGIN
      -- Delete from FTS if no longer active
      DELETE FROM documents_fts WHERE rowid = old.id AND new.active = 0;

      -- Update FTS if still/newly active
      INSERT OR REPLACE INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  // Frontmatter key/value pairs (arrays exploded into multiple rows)
  db.exec(`
    CREATE TABLE IF NOT EXISTS frontmatter (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      key        TEXT NOT NULL,
      value_text TEXT,
      value_num  REAL,
      value_date TEXT,
      is_array   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_frontmatter_doc_key ON frontmatter(doc_id, key);
    CREATE INDEX IF NOT EXISTS idx_frontmatter_key     ON frontmatter(key);
  `);

  // Denormalized tags for fast tag queries
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      tag    TEXT NOT NULL,
      PRIMARY KEY (doc_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
  `);

  // Heading-delimited sections with body text
  db.exec(`
    CREATE TABLE IF NOT EXISTS sections (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id           INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      seq              INTEGER NOT NULL,
      parent_seq       INTEGER,
      level            INTEGER NOT NULL,
      heading          TEXT,
      slug             TEXT,
      body             TEXT NOT NULL DEFAULT '',
      body_no_callouts TEXT NOT NULL DEFAULT '',
      word_count       INTEGER NOT NULL DEFAULT 0,
      char_offset      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sections_doc_id  ON sections(doc_id);
    CREATE INDEX IF NOT EXISTS idx_sections_heading ON sections(heading);
    CREATE INDEX IF NOT EXISTS idx_sections_level   ON sections(level);
  `);

  // Obsidian-style callout blocks (> [!kind] Title)
  db.exec(`
    CREATE TABLE IF NOT EXISTS callouts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      title      TEXT,
      body       TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_callouts_doc_id ON callouts(doc_id);
    CREATE INDEX IF NOT EXISTS idx_callouts_kind   ON callouts(kind);
  `);

  // Wikilinks [[target]] and [[target#anchor]]
  db.exec(`
    CREATE TABLE IF NOT EXISTS wikilinks (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      target TEXT NOT NULL,
      anchor TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wikilinks_doc_id ON wikilinks(doc_id);
    CREATE INDEX IF NOT EXISTS idx_wikilinks_target ON wikilinks(target);
  `);

  // Migration: add word_count to documents if missing
  const docCols = db.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[];
  if (!docCols.some(c => c.name === 'word_count')) {
    db.exec(`ALTER TABLE documents ADD COLUMN word_count INTEGER NOT NULL DEFAULT 0`);
  }
}

export function isSqliteVecAvailable(): boolean {
  return _sqliteVecAvailable === true;
}

export function ensureVecTableInternal(db: Database, dimensions: number): void {
  if (!_sqliteVecAvailable) {
    throw createSqliteVecUnavailableError(
      _sqliteVecUnavailableReason ?? "vector operations require a SQLite build with extension loading support"
    );
  }
  const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { sql: string } | null;
  if (tableInfo) {
    const match = tableInfo.sql.match(/float\[(\d+)\]/);
    const hasHashSeq = tableInfo.sql.includes('hash_seq');
    const hasCosine = tableInfo.sql.includes('distance_metric=cosine');
    const existingDims = match?.[1] ? parseInt(match[1], 10) : null;
    if (existingDims === dimensions && hasHashSeq && hasCosine) return;
    if (existingDims !== null && existingDims !== dimensions) {
      throw new Error(
        `Embedding dimension mismatch: existing vectors are ${existingDims}d but the current model produces ${dimensions}d. ` +
        `Run 'qmd embed -f' to re-embed with the new model.`
      );
    }
    db.exec("DROP TABLE IF EXISTS vectors_vec");
  }
  db.exec(`CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
}
