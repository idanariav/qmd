import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MAX_CHUNK_BYTES, readVectorBytes, writeVectorChunks } from "../src/cli/commands/export.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "qmd-chunks-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("export vector chunks", () => {
  test("splits on row boundaries under the size limit and reads back identically", () => {
    const dim = 512;
    const rows = Math.ceil((MAX_CHUNK_BYTES * 2.5) / dim);
    const bin = Int8Array.from({ length: rows * dim }, (_, i) => (i % 255) - 127);
    const files = writeVectorChunks(dir, bin, dim);

    expect(files).toEqual(["vectors-0.bin", "vectors-1.bin", "vectors-2.bin"]);
    for (const f of files) {
      const size = statSync(join(dir, f)).size;
      expect(size).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      expect(size % dim).toBe(0);
    }
    expect(Buffer.compare(readVectorBytes(dir, { files })!, Buffer.from(bin.buffer))).toBe(0);
  });

  test("removes the v1 vectors.bin and chunks left over from a larger export", () => {
    writeFileSync(join(dir, "vectors.bin"), "old");
    writeFileSync(join(dir, "vectors-5.bin"), "old");
    writeFileSync(join(dir, "manifest.json"), "{}");
    const files = writeVectorChunks(dir, new Int8Array(8), 4);
    expect(files).toEqual(["vectors-0.bin"]);
    expect(readdirSync(dir).sort()).toEqual(["manifest.json", "vectors-0.bin"]);
  });

  test("reads a v1 export's single vectors.bin, and reports missing chunks", () => {
    writeFileSync(join(dir, "vectors.bin"), Buffer.from([1, 2, 3]));
    expect([...readVectorBytes(dir, {})!]).toEqual([1, 2, 3]);
    expect(readVectorBytes(dir, { files: ["vectors-0.bin"] })).toBeNull();
  });
});
