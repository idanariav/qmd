/**
 * Profiles: frontmatter aliases/description made searchable (FTS columns + profile vectors).
 */

import { describe, test, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  reindexCollection,
  searchFTS,
  extractProfileFields,
  getProfilesNeedingEmbedding,
  profileHash,
} from "../src/store.js";
import { parseFrontmatter } from "../src/parse/frontmatter.js";

let dir: string | null = null;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const note = (aliases: string[], description: string, notes: string) =>
  `---\naliases:\n${aliases.map(a => `  - ${a}`).join("\n")}\nDescription: ${description}\n---\n# Heading\n\n## Notes\n\n${notes}\n\n## Other\n\nignored text\n`;

async function setup() {
  dir = await mkdtemp(join(tmpdir(), "qmd-profiles-"));
  await mkdir(join(dir, "notes"));
  await writeFile(join(dir, "notes", "Sleep is essential for performance.md"),
    note(["Rest", "Slumber"], "A keystone habit for recovery", "Seven hours nightly."));
  await writeFile(join(dir, "notes", "Plain note.md"), "## Notes\n\nNo frontmatter here.\n");
  const store = createStore(join(dir, "index.sqlite"));
  await reindexCollection(store, join(dir, "notes"), "**/*.md", "claims", { section: { heading: "Notes", level: 2 } });
  return store;
}

describe("extractProfileFields", () => {
  test("collects aliases/alias and description/summary case-insensitively", () => {
    const fm = parseFrontmatter("---\nAliases: [One, Two]\nSummary: short summary\n---\nbody");
    expect(extractProfileFields(fm)).toEqual({ aliases: "One, Two", description: "short summary" });
  });

  test("returns empty fields without frontmatter", () => {
    expect(extractProfileFields(parseFrontmatter("just body"))).toEqual({ aliases: "", description: "" });
  });
});

describe("profiles with a section-filtered collection", () => {
  test("frontmatter comes from the whole file while the body stays the section", async () => {
    const store = await setup();
    try {
      const doc = store.db.prepare(`SELECT id FROM documents WHERE path LIKE 'sleep%'`).get() as { id: number };
      const keys = (store.db.prepare(`SELECT key FROM frontmatter WHERE doc_id = ?`).all(doc.id) as { key: string }[]).map(r => r.key);
      expect(keys).toContain("aliases");
      const body = (store.db.prepare(`SELECT c.doc FROM content c JOIN documents d ON d.hash = c.hash WHERE d.id = ?`).get(doc.id) as { doc: string }).doc;
      expect(body).toContain("Seven hours nightly.");
      expect(body).not.toContain("ignored text");
    } finally {
      store.close();
    }
  });

  test("an alias word finds the note via BM25 even though the body lacks it", async () => {
    const store = await setup();
    try {
      const hits = searchFTS(store.db, "slumber", 5, "claims");
      expect(hits.map(h => h.displayPath)).toEqual([expect.stringContaining("Sleep-is-essential")]);
      expect(searchFTS(store.db, "keystone", 5, "claims")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("removing an alias and re-indexing drops it from FTS", async () => {
    const store = await setup();
    try {
      await writeFile(join(dir!, "notes", "Sleep is essential for performance.md"),
        note(["Rest"], "A keystone habit for recovery", "Seven hours nightly."));
      await reindexCollection(store, join(dir!, "notes"), "**/*.md", "claims", { section: { heading: "Notes", level: 2 } });
      expect(searchFTS(store.db, "slumber", 5, "claims")).toHaveLength(0);
      expect(searchFTS(store.db, "rest", 5, "claims")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("only documents with profile text need a profile embedding, and re-embedding is skipped once recorded", async () => {
    const store = await setup();
    try {
      const pending = getProfilesNeedingEmbedding(store.db, "m");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.text).toBe("Rest, Slumber. A keystone habit for recovery");

      store.db.prepare(`UPDATE doc_profiles SET embedded_hash = ?, model = 'm' WHERE doc_id = ?`)
        .run(profileHash(pending[0]!.title, pending[0]!.text), pending[0]!.docId);
      expect(getProfilesNeedingEmbedding(store.db, "m")).toHaveLength(0);
      expect(getProfilesNeedingEmbedding(store.db, "other-model")).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
