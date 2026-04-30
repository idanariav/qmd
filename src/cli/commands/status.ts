// Commands: status (qmd status) and updateCollections (qmd index)

import { statSync, existsSync, readFileSync, unlinkSync } from "fs";
import { spawn as nodeSpawn } from "child_process";
import {
  listCollections,
  getHashesNeedingEmbedding,
  clearCache,
  homedir,
  resolve,
  reindexCollection,
} from "../../store.js";
import { getDefaultLlamaCpp } from "../../llm.js";
import {
  getCollection as getCollectionFromYaml,
  listAllContexts,
} from "../../collections.js";
import { getStore, getDb, getDbPath, closeDb, models } from "../store-access.js";
import { c, cursor, progress, isTTY, formatETA, formatTimeAgo, formatMs, formatBytes } from "../utils.js";

export async function showStatus(): Promise<void> {
  const dbPath = getDbPath();
  const db = getDb();

  let indexSize = 0;
  try {
    indexSize = statSync(dbPath).size;
  } catch { }

  const collections = listCollections(db);

  const totalDocs = db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number };
  const vectorCount = db.prepare(`SELECT COUNT(*) as count FROM content_vectors`).get() as { count: number };
  const needsEmbedding = getHashesNeedingEmbedding(db);

  const mostRecent = db.prepare(`SELECT MAX(modified_at) as latest FROM documents WHERE active = 1`).get() as { latest: string | null };

  console.log(`${c.bold}QMD Status${c.reset}\n`);
  console.log(`Index: ${dbPath}`);
  console.log(`Size:  ${formatBytes(indexSize)}`);

  const mcpCacheDir = process.env.XDG_CACHE_HOME
    ? resolve(process.env.XDG_CACHE_HOME, "qmd")
    : resolve(homedir(), ".cache", "qmd");
  const mcpPidPath = resolve(mcpCacheDir, "mcp.pid");
  if (existsSync(mcpPidPath)) {
    const mcpPid = parseInt(readFileSync(mcpPidPath, "utf-8").trim());
    try {
      process.kill(mcpPid, 0);
      console.log(`MCP:   ${c.green}running${c.reset} (PID ${mcpPid})`);
    } catch {
      unlinkSync(mcpPidPath);
    }
  }
  console.log("");

  console.log(`${c.bold}Documents${c.reset}`);
  console.log(`  Total:    ${totalDocs.count} files indexed`);
  console.log(`  Vectors:  ${vectorCount.count} embedded`);
  if (needsEmbedding > 0) {
    console.log(`  ${c.yellow}Pending:  ${needsEmbedding} need embedding${c.reset} (run 'qmd embed')`);
  }
  if (mostRecent.latest) {
    const lastUpdate = new Date(mostRecent.latest);
    console.log(`  Updated:  ${formatTimeAgo(lastUpdate)}`);
  }

  const allContexts = listAllContexts();
  const contextsByCollection = new Map<string, { path_prefix: string; context: string }[]>();
  for (const ctx of allContexts) {
    if (!contextsByCollection.has(ctx.collection)) {
      contextsByCollection.set(ctx.collection, []);
    }
    contextsByCollection.get(ctx.collection)!.push({
      path_prefix: ctx.path,
      context: ctx.context
    });
  }

  try {
    const { getASTStatus } = await import("../../ast.js");
    const ast = await getASTStatus();
    console.log(`\n${c.bold}AST Chunking${c.reset}`);
    if (ast.available) {
      const ok = ast.languages.filter(l => l.available).map(l => l.language);
      const fail = ast.languages.filter(l => !l.available);
      console.log(`  Status:   ${c.green}active${c.reset}`);
      console.log(`  Languages: ${ok.join(", ")}`);
      if (fail.length > 0) {
        for (const f of fail) {
          console.log(`  ${c.yellow}Unavailable: ${f.language} (${f.error})${c.reset}`);
        }
      }
    } else {
      console.log(`  Status:   ${c.yellow}unavailable${c.reset} (falling back to regex chunking)`);
      for (const l of ast.languages) {
        if (l.error) console.log(`  ${c.dim}${l.language}: ${l.error}${c.reset}`);
      }
    }
  } catch {
    console.log(`\n${c.bold}AST Chunking${c.reset}`);
    console.log(`  Status:   ${c.dim}not available${c.reset}`);
  }

  if (collections.length > 0) {
    console.log(`\n${c.bold}Collections${c.reset}`);
    for (const col of collections) {
      const lastMod = col.last_modified ? formatTimeAgo(new Date(col.last_modified)) : "never";
      const contexts = contextsByCollection.get(col.name) || [];

      console.log(`  ${c.cyan}${col.name}${c.reset} ${c.dim}(qmd://${col.name}/)${c.reset}`);
      console.log(`    ${c.dim}Pattern:${c.reset}  ${col.glob_pattern}`);
      console.log(`    ${c.dim}Files:${c.reset}    ${col.active_count} (updated ${lastMod})`);

      if (contexts.length > 0) {
        console.log(`    ${c.dim}Contexts:${c.reset} ${contexts.length}`);
        for (const ctx of contexts) {
          const pathDisplay = (ctx.path_prefix === '' || ctx.path_prefix === '/') ? '/' : `/${ctx.path_prefix}`;
          const contextPreview = ctx.context.length > 60
            ? ctx.context.substring(0, 57) + '...'
            : ctx.context;
          console.log(`      ${c.dim}${pathDisplay}:${c.reset} ${contextPreview}`);
        }
      }
    }

    console.log(`\n${c.bold}Examples${c.reset}`);
    console.log(`  ${c.dim}# List files in a collection${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  qmd ls ${collections[0].name}`);
    }
    console.log(`  ${c.dim}# Get a document${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  qmd get qmd://${collections[0].name}/path/to/file.md`);
    }
    console.log(`  ${c.dim}# Search within a collection${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  qmd tsearch "query" -c ${collections[0].name}`);
    }
  } else {
    console.log(`\n${c.dim}No collections. Run 'qmd collection add .' to index markdown files.${c.reset}`);
  }

  {
    const hfLink = (uri: string) => {
      const match = uri.match(/^hf:([^/]+\/[^/]+)\//);
      return match ? `https://huggingface.co/${match[1]}` : uri;
    };
    console.log(`\n${c.bold}Models${c.reset}`);
    console.log(`  Embedding:   ${hfLink(models.embed)}`);
    console.log(`  Reranking:   ${hfLink(models.rerank)}`);
    console.log(`  Generation:  ${hfLink(models.generate)}`);
  }

  if (process.env.QMD_STATUS_DEVICE_PROBE === "1") {
    console.log(`\n${c.bold}Device${c.reset}`);
    try {
      const llm = getDefaultLlamaCpp();
      const device = await llm.getDeviceInfo({ allowBuild: false });
      if (device.gpu) {
        console.log(`  GPU:      ${c.green}${device.gpu}${c.reset} (offloading: ${device.gpuOffloading ? 'yes' : 'no'})`);
        if (device.gpuDevices.length > 0) {
          const counts = new Map<string, number>();
          for (const name of device.gpuDevices) {
            counts.set(name, (counts.get(name) || 0) + 1);
          }
          const deviceStr = Array.from(counts.entries())
            .map(([name, count]) => count > 1 ? `${count}× ${name}` : name)
            .join(', ');
          console.log(`  Devices:  ${deviceStr}`);
        }
        if (device.vram) {
          console.log(`  VRAM:     ${formatBytes(device.vram.free)} free / ${formatBytes(device.vram.total)} total`);
        }
      } else {
        console.log(`  GPU:      ${c.yellow}none${c.reset} (running on CPU — models will be slow)`);
        console.log(`  ${c.dim}Tip: Install CUDA, Vulkan, or Metal support for GPU acceleration.${c.reset}`);
      }
      console.log(`  CPU:      ${device.cpuCores} math cores`);
    } catch (error) {
      console.log(`  Status:   ${c.dim}probe failed${c.reset}`);
      if (error instanceof Error && error.message) {
        console.log(`  ${c.dim}${error.message}${c.reset}`);
      }
    }
  }

  const tips: string[] = [];

  const collectionsWithoutContext = collections.filter(col => {
    const contexts = contextsByCollection.get(col.name) || [];
    return contexts.length === 0;
  });
  if (collectionsWithoutContext.length > 0) {
    const names = collectionsWithoutContext.map(c => c.name).slice(0, 3).join(', ');
    const more = collectionsWithoutContext.length > 3 ? ` +${collectionsWithoutContext.length - 3} more` : '';
    tips.push(`Add context to collections for better search results: ${names}${more}`);
    tips.push(`  ${c.dim}qmd context add qmd://<name>/ "What this collection contains"${c.reset}`);
    tips.push(`  ${c.dim}qmd context add qmd://<name>/meeting-notes "Weekly team meeting notes"${c.reset}`);
  }

  const collectionsWithoutUpdate = collections.filter(col => {
    const yamlCol = getCollectionFromYaml(col.name);
    return !yamlCol?.update;
  });
  if (collectionsWithoutUpdate.length > 0 && collections.length > 1) {
    const names = collectionsWithoutUpdate.map(c => c.name).slice(0, 3).join(', ');
    const more = collectionsWithoutUpdate.length > 3 ? ` +${collectionsWithoutUpdate.length - 3} more` : '';
    tips.push(`Add update commands to keep collections fresh: ${names}${more}`);
    tips.push(`  ${c.dim}qmd collection update-cmd <name> 'git stash && git pull --rebase --ff-only && git stash pop'${c.reset}`);
  }

  if (tips.length > 0) {
    console.log(`\n${c.bold}Tips${c.reset}`);
    for (const tip of tips) {
      console.log(`  ${tip}`);
    }
  }

  closeDb();
}

export async function updateCollections(): Promise<void> {
  const db = getDb();
  const storeInstance = getStore();

  clearCache(db);

  const collections = listCollections(db);

  if (collections.length === 0) {
    console.log(`${c.dim}No collections found. Run 'qmd collection add .' to index markdown files.${c.reset}`);
    closeDb();
    return;
  }

  console.log(`${c.bold}Updating ${collections.length} collection(s)...${c.reset}\n`);

  for (let i = 0; i < collections.length; i++) {
    const col = collections[i];
    if (!col) continue;
    console.log(`${c.cyan}[${i + 1}/${collections.length}]${c.reset} ${c.bold}${col.name}${c.reset} ${c.dim}(${col.glob_pattern})${c.reset}`);

    const yamlCol = getCollectionFromYaml(col.name);
    if (yamlCol?.update) {
      console.log(`${c.dim}    Running update command: ${yamlCol.update}${c.reset}`);
      try {
        const proc = nodeSpawn("bash", ["-c", yamlCol.update], {
          cwd: col.pwd,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const [output, errorOutput, exitCode] = await new Promise<[string, string, number]>((resolve, reject) => {
          let out = "";
          let err = "";
          proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
          proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
          proc.on("error", reject);
          proc.on("close", (code) => resolve([out, err, code ?? 1]));
        });

        if (output.trim()) {
          console.log(output.trim().split('\n').map(l => `    ${l}`).join('\n'));
        }
        if (errorOutput.trim()) {
          console.log(errorOutput.trim().split('\n').map(l => `    ${l}`).join('\n'));
        }

        if (exitCode !== 0) {
          console.log(`${c.yellow}✗ Update command failed with exit code ${exitCode}${c.reset}`);
          process.exit(exitCode);
        }
      } catch (err) {
        console.log(`${c.yellow}✗ Update command failed: ${err}${c.reset}`);
        process.exit(1);
      }
    }

    const startTime = Date.now();
    console.log(`Collection: ${col.pwd} (${col.glob_pattern})`);
    progress.indeterminate();

    const result = await reindexCollection(storeInstance, col.pwd, col.glob_pattern, col.name, {
      ignorePatterns: yamlCol?.ignore,
      section: yamlCol?.section,
      onProgress: (info) => {
        progress.set((info.current / info.total) * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = info.current / elapsed;
        const remaining = (info.total - info.current) / rate;
        const eta = info.current > 2 ? ` ETA: ${formatETA(remaining)}` : "";
        if (isTTY) process.stderr.write(`\rIndexing: ${info.current}/${info.total}${eta}        `);
      },
    });

    progress.clear();
    console.log(`\nIndexed: ${result.indexed} new, ${result.updated} updated, ${result.unchanged} unchanged, ${result.removed} removed`);
    if (result.orphanedCleaned > 0) {
      console.log(`Cleaned up ${result.orphanedCleaned} orphaned content hash(es)`);
    }
    console.log("");
  }

  const needsEmbedding = getHashesNeedingEmbedding(db);
  closeDb();

  console.log(`${c.green}✓ All collections updated.${c.reset}`);
  if (needsEmbedding > 0) {
    console.log(`\nRun 'qmd embed' to update embeddings (${needsEmbedding} unique hashes need vectors)`);
  }
}
