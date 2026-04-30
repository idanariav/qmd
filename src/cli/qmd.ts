// NOTE: enableProductionMode() is intentionally NOT called at module scope here.
// Importing this module for its exports (e.g. buildEditorUri, termLink from
// test/cli.test.ts) must not flip the global production flag, as that leaks
// into unrelated tests that rely on the default (development) database path
// resolution. The flag is flipped inside the CLI's main-module guard below so
// it only fires when qmd is actually invoked as a script.

import { fileURLToPath } from "url";
import { realpathSync, existsSync, readFileSync, unlinkSync, writeFileSync, openSync, closeSync, mkdirSync } from "fs";
import { dirname, join as pathJoin } from "path";
import { spawn as nodeSpawn } from "child_process";
import { enableProductionMode, resolve, homedir, DEFAULT_MULTI_GET_MAX_BYTES, deleteLLMCache, cleanupOrphanedVectors, deleteInactiveDocuments, vacuumDatabase, getPwd, getRealPath } from "../store.js";
import { disposeDefaultLlamaCpp, pullModels, DEFAULT_EMBED_MODEL_URI, DEFAULT_MODEL_CACHE_DIR } from "../llm.js";

import { parseCLI } from "./args.js";
import { getStore, getDb, closeDb, models, setIndexName } from "./store-access.js";
import { cursor } from "./utils.js";
import { formatBytes } from "./utils.js";
import { c } from "./utils.js";

import { showStatus, updateCollections } from "./commands/status.js";
import { contextAdd, contextList, contextRemove } from "./commands/context.js";
import { getDocument, multiGet, listFiles } from "./commands/get.js";
import { collectionList, collectionAdd, collectionRemove, collectionRename } from "./commands/collection.js";
import { indexFiles, vectorIndex, parseEmbedBatchOption } from "./commands/index-cmd.js";
import { search, vectorSearch, querySearch, filterSearch, resolveCollectionFilter } from "./commands/search.js";
import { showSkill, installSkill, showHelp, showVersion } from "./commands/misc.js";

// Re-export for test compatibility (test/cli.test.ts imports these from qmd.js)
export { buildEditorUri, termLink } from "./uri.js";
export { setIndexName };

// =============================================================================
// Main CLI - only run if this is the main module
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const argv1 = process.argv[1];
const isMain = argv1 === __filename
  || argv1?.endsWith("/qmd.ts")
  || argv1?.endsWith("/qmd.js")
  || (argv1 != null && realpathSync(argv1) === __filename);

if (isMain) {
  enableProductionMode();

  // Restore cursor on exit signals
  process.on('SIGINT', () => { cursor.show(); process.exit(130); });
  process.on('SIGTERM', () => { cursor.show(); process.exit(143); });

  const cli = parseCLI();

  if (cli.values.version) {
    await showVersion();
    process.exit(0);
  }

  if (cli.values.skill) {
    showSkill();
    process.exit(0);
  }

  if (cli.values.help && cli.command === "skill") {
    console.log("Usage: qmd skill <show|install> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  show                 Print the packaged QMD skill");
    console.log("  install              Install into ./.agents/skills/qmd");
    console.log("");
    console.log("Options:");
    console.log("  --global             Install into ~/.agents/skills/qmd");
    console.log("  --yes                Also create the .claude/skills/qmd symlink");
    console.log("  -f, --force          Replace existing install or symlink");
    process.exit(0);
  }

  if (!cli.command || cli.values.help) {
    showHelp();
    process.exit(cli.values.help ? 0 : 1);
  }

  switch (cli.command) {
    case "context": {
      const subcommand = cli.args[0];
      if (!subcommand) {
        console.error("Usage: qmd context <add|list|rm>");
        console.error("");
        console.error("Commands:");
        console.error("  qmd context add [path] \"text\"  - Add context (defaults to current dir)");
        console.error("  qmd context add / \"text\"       - Add global context to all collections");
        console.error("  qmd context list                - List all contexts");
        console.error("  qmd context rm <path>           - Remove context");
        process.exit(1);
      }

      switch (subcommand) {
        case "add": {
          if (cli.args.length < 2) {
            console.error("Usage: qmd context add [path] \"text\"");
            console.error("");
            console.error("Examples:");
            console.error("  qmd context add \"Context for current directory\"");
            console.error("  qmd context add . \"Context for current directory\"");
            console.error("  qmd context add /subfolder \"Context for subfolder\"");
            console.error("  qmd context add / \"Global context for all collections\"");
            console.error("");
            console.error("  Using virtual paths:");
            console.error("  qmd context add qmd://journals/ \"Context for entire journals collection\"");
            console.error("  qmd context add qmd://journals/2024 \"Context for 2024 journals\"");
            process.exit(1);
          }

          let pathArg: string | undefined;
          let contextText: string;

          const firstArg = cli.args[1] || '';
          const secondArg = cli.args[2];

          if (secondArg) {
            pathArg = firstArg;
            contextText = cli.args.slice(2).join(" ");
          } else {
            pathArg = undefined;
            contextText = firstArg;
          }

          await contextAdd(pathArg, contextText);
          break;
        }

        case "list": {
          contextList();
          break;
        }

        case "rm":
        case "remove": {
          if (cli.args.length < 2 || !cli.args[1]) {
            console.error("Usage: qmd context rm <path>");
            console.error("Examples:");
            console.error("  qmd context rm /");
            console.error("  qmd context rm qmd://journals/2024");
            process.exit(1);
          }
          contextRemove(cli.args[1]);
          break;
        }

        default:
          console.error(`Unknown subcommand: ${subcommand}`);
          console.error("Available: add, list, rm");
          process.exit(1);
      }
      break;
    }

    case "get": {
      if (!cli.args[0]) {
        console.error("Usage: qmd get <filepath> [--section 'Heading/Sub'] [--from <line>] [-l <lines>] [--line-numbers] [--no-callouts] [--no-codeblocks]");
        process.exit(1);
      }
      const filePath = cli.args[0];
      const section = cli.values.section as string | undefined;
      const fromLine = cli.values.from ? parseInt(cli.values.from as string, 10) : undefined;
      const maxLines = cli.values.l ? parseInt(cli.values.l as string, 10) : undefined;
      const stripCallouts = Boolean(cli.values["no-callouts"]);
      const noCodeblocks = Boolean(cli.values["no-codeblocks"]);
      getDocument(filePath, { fromLine, maxLines, lineNumbers: cli.opts.lineNumbers, section, stripCallouts, noCodeblocks });
      break;
    }

    case "multi-get": {
      if (!cli.args[0]) {
        console.error("Usage: qmd multi-get <pattern> [-l <lines>] [--max-bytes <bytes>] [--json|--csv|--md|--xml|--files]");
        console.error("  pattern: glob (e.g., 'journals/2025-05*.md') or comma-separated list");
        process.exit(1);
      }
      const maxLinesMulti = cli.values.l ? parseInt(cli.values.l as string, 10) : undefined;
      const maxBytes = cli.values["max-bytes"] ? parseInt(cli.values["max-bytes"] as string, 10) : DEFAULT_MULTI_GET_MAX_BYTES;
      multiGet(cli.args[0], maxLinesMulti, maxBytes, cli.opts.format);
      break;
    }

    case "ls": {
      listFiles(cli.args[0]);
      break;
    }

    case "collection": {
      const subcommand = cli.args[0];
      switch (subcommand) {
        case "list": {
          collectionList();
          break;
        }

        case "add": {
          const pwd = cli.args[1] || getPwd();
          const resolvedPwd = pwd === '.' ? getPwd() : getRealPath(resolve(pwd));
          const globPattern = cli.values.mask as string || "**/*.md";
          const name = cli.values.name as string | undefined;
          const headingName = cli.values["heading-name"] as string | undefined;
          const headingLevel = cli.values["heading-level"] as string | undefined;
          let section;
          if (headingName) {
            section = {
              heading: headingName,
              level: headingLevel ? parseInt(headingLevel, 10) : 2,
            };
          }

          await collectionAdd(resolvedPwd, globPattern, name, section);
          break;
        }

        case "remove":
        case "rm": {
          if (!cli.args[1]) {
            console.error("Usage: qmd collection remove <name>");
            console.error("  Use 'qmd collection list' to see available collections");
            process.exit(1);
          }
          collectionRemove(cli.args[1]);
          break;
        }

        case "rename":
        case "mv": {
          if (!cli.args[1] || !cli.args[2]) {
            console.error("Usage: qmd collection rename <old-name> <new-name>");
            console.error("  Use 'qmd collection list' to see available collections");
            process.exit(1);
          }
          collectionRename(cli.args[1], cli.args[2]);
          break;
        }

        case "set-update":
        case "update-cmd": {
          const name = cli.args[1];
          const cmd = cli.args.slice(2).join(' ') || null;
          if (!name) {
            console.error("Usage: qmd collection update-cmd <name> [command]");
            console.error("  Set the command to run before indexing (e.g., 'git pull')");
            console.error("  Omit command to clear it");
            process.exit(1);
          }
          const { updateCollectionSettings, getCollection } = await import("../collections.js");
          const col = getCollection(name);
          if (!col) {
            console.error(`Collection not found: ${name}`);
            process.exit(1);
          }
          updateCollectionSettings(name, { update: cmd });
          if (cmd) {
            console.log(`✓ Set update command for '${name}': ${cmd}`);
          } else {
            console.log(`✓ Cleared update command for '${name}'`);
          }
          break;
        }

        case "include":
        case "exclude": {
          const name = cli.args[1];
          if (!name) {
            console.error(`Usage: qmd collection ${subcommand} <name>`);
            console.error(`  ${subcommand === 'include' ? 'Include' : 'Exclude'} collection in default queries`);
            process.exit(1);
          }
          const { updateCollectionSettings, getCollection } = await import("../collections.js");
          const col = getCollection(name);
          if (!col) {
            console.error(`Collection not found: ${name}`);
            process.exit(1);
          }
          const include = subcommand === 'include';
          updateCollectionSettings(name, { includeByDefault: include });
          console.log(`✓ Collection '${name}' ${include ? 'included in' : 'excluded from'} default queries`);
          break;
        }

        case "show":
        case "info": {
          const name = cli.args[1];
          if (!name) {
            console.error("Usage: qmd collection show <name>");
            process.exit(1);
          }
          const { getCollection } = await import("../collections.js");
          const col = getCollection(name);
          if (!col) {
            console.error(`Collection not found: ${name}`);
            process.exit(1);
          }
          console.log(`Collection: ${name}`);
          console.log(`  Path:     ${col.path}`);
          console.log(`  Pattern:  ${col.pattern}`);
          console.log(`  Include:  ${col.includeByDefault !== false ? 'yes (default)' : 'no'}`);
          if (col.section) {
            console.log(`  Section:  ## ${col.section.heading} (level ${col.section.level})`);
          }
          if (col.update) {
            console.log(`  Update:   ${col.update}`);
          }
          if (col.context) {
            const ctxCount = Object.keys(col.context).length;
            console.log(`  Contexts: ${ctxCount}`);
          }
          break;
        }

        case "help":
        case undefined: {
          console.log("Usage: qmd collection <command> [options]");
          console.log("");
          console.log("Commands:");
          console.log("  list                      List all collections");
          console.log("  add <path> [--name NAME] [--heading-name H --heading-level N]  Add a collection");
          console.log("  remove <name>             Remove a collection");
          console.log("  rename <old> <new>        Rename a collection");
          console.log("  show <name>               Show collection details");
          console.log("  update-cmd <name> [cmd]   Set pre-update command (e.g., 'git pull')");
          console.log("  include <name>            Include in default queries");
          console.log("  exclude <name>            Exclude from default queries");
          console.log("");
          console.log("Examples:");
          console.log("  qmd collection add ~/notes --name notes");
          console.log("  qmd collection add ~/vault/claims --name claims --heading-name Notes --heading-level 2");
          console.log("  qmd collection update-cmd brain 'git pull'");
          console.log("  qmd collection exclude archive");
          process.exit(0);
        }

        default:
          console.error(`Unknown subcommand: ${subcommand}`);
          console.error("Run 'qmd collection help' for usage");
          process.exit(1);
      }
      break;
    }

    case "status":
      await showStatus();
      break;

    case "index":
      await updateCollections();
      break;

    case "embed":
      try {
        getStore(); // ensure models are resolved from config before reading
        const maxDocsPerBatch = parseEmbedBatchOption("maxDocsPerBatch", cli.values["max-docs-per-batch"]);
        const maxBatchMb = parseEmbedBatchOption("maxBatchBytes", cli.values["max-batch-mb"]);
        const embedChunkStrategy = cli.opts.chunkStrategy;
        const embedValidatedCollections = resolveCollectionFilter(cli.opts.collection, false);
        const embedCollection = embedValidatedCollections[0];
        await vectorIndex(models.embed, !!cli.values.force, {
          maxDocsPerBatch,
          maxBatchBytes: maxBatchMb === undefined ? undefined : maxBatchMb * 1024 * 1024,
          chunkStrategy: embedChunkStrategy,
          collection: embedCollection,
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      break;

    case "pull": {
      getStore(); // ensure models are resolved from config
      const refresh = cli.values.refresh === undefined ? false : Boolean(cli.values.refresh);
      console.log(`${c.bold}Pulling models${c.reset}`);
      const results = await pullModels(Object.values(models), {
        refresh,
        cacheDir: DEFAULT_MODEL_CACHE_DIR,
      });
      for (const result of results) {
        const size = formatBytes(result.sizeBytes);
        const note = result.refreshed ? "refreshed" : "cached/checked";
        console.log(`- ${result.model} -> ${result.path} (${size}, ${note})`);
      }
      break;
    }

    case "tsearch":
      if (!cli.query) {
        console.error("Usage: qmd tsearch [options] <query>");
        process.exit(1);
      }
      search(cli.query, cli.opts);
      break;

    case "vsearch":
    case "vector-search":
      if (!cli.query) {
        console.error("Usage: qmd vsearch [options] <query>");
        process.exit(1);
      }
      if (!cli.values["min-score"]) {
        cli.opts.minScore = 0.3;
      }
      await vectorSearch(cli.query, cli.opts);
      break;

    case "hsearch":
      if (!cli.query) {
        console.error("Usage: qmd hsearch [options] <query>");
        process.exit(1);
      }
      await querySearch(cli.query, cli.opts);
      break;

    case "fsearch":
      if (!cli.query) {
        console.error("Usage: qmd fsearch [options] <filter>");
        console.error("Example: qmd fsearch 'tag=productivity AND modified > 30d'");
        process.exit(1);
      }
      filterSearch(cli.query, cli.opts);
      break;

    case "bench": {
      const fixturePath = cli.args[0];
      if (!fixturePath) {
        console.error("Usage: qmd bench <fixture.json> [--json] [-c collection]");
        console.error("");
        console.error("Run search quality benchmarks against a fixture file.");
        console.error("See src/bench/fixtures/example.json for the fixture format.");
        process.exit(1);
      }
      const { runBenchmark } = await import("../bench/bench.js");
      const benchCollection = cli.opts.collection;
      await runBenchmark(fixturePath, {
        json: !!(cli.opts as { json?: boolean }).json,
        collection: Array.isArray(benchCollection) ? benchCollection[0] : benchCollection,
      });
      break;
    }

    case "mcp": {
      const sub = cli.args[0];

      const cacheDir = process.env.XDG_CACHE_HOME
        ? resolve(process.env.XDG_CACHE_HOME, "qmd")
        : resolve(homedir(), ".cache", "qmd");
      const pidPath = resolve(cacheDir, "mcp.pid");

      if (sub === "stop") {
        if (!existsSync(pidPath)) {
          console.log("Not running (no PID file).");
          process.exit(0);
        }
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim());
        try {
          process.kill(pid, 0);
          process.kill(pid, "SIGTERM");
          unlinkSync(pidPath);
          console.log(`Stopped QMD MCP server (PID ${pid}).`);
        } catch {
          unlinkSync(pidPath);
          console.log("Cleaned up stale PID file (server was not running).");
        }
        process.exit(0);
      }

      if (cli.values.http) {
        const port = Number(cli.values.port) || 8181;

        if (cli.values.daemon) {
          if (existsSync(pidPath)) {
            const existingPid = parseInt(readFileSync(pidPath, "utf-8").trim());
            try {
              process.kill(existingPid, 0);
              console.error(`Already running (PID ${existingPid}). Run 'qmd mcp stop' first.`);
              process.exit(1);
            } catch {
              // Stale PID file — continue
            }
          }

          mkdirSync(cacheDir, { recursive: true });
          const logPath = resolve(cacheDir, "mcp.log");
          const logFd = openSync(logPath, "w");
          const selfPath = fileURLToPath(import.meta.url);
          const spawnArgs = selfPath.endsWith(".ts")
            ? ["--import", pathJoin(dirname(selfPath), "..", "..", "node_modules", "tsx", "dist", "esm", "index.mjs"), selfPath, "mcp", "--http", "--port", String(port)]
            : [selfPath, "mcp", "--http", "--port", String(port)];
          const child = nodeSpawn(process.execPath, spawnArgs, {
            stdio: ["ignore", logFd, logFd],
            detached: true,
          });
          child.unref();
          closeSync(logFd);

          writeFileSync(pidPath, String(child.pid));
          console.log(`Started on http://localhost:${port}/mcp (PID ${child.pid})`);
          console.log(`Logs: ${logPath}`);
          process.exit(0);
        }

        process.removeAllListeners("SIGTERM");
        process.removeAllListeners("SIGINT");
        const { startMcpHttpServer } = await import("../mcp/server.js");
        try {
          await startMcpHttpServer(port);
        } catch (e: any) {
          if (e?.code === "EADDRINUSE") {
            console.error(`Port ${port} already in use. Try a different port with --port.`);
            process.exit(1);
          }
          throw e;
        }
      } else {
        const { startMcpServer } = await import("../mcp/server.js");
        await startMcpServer();
      }
      break;
    }

    case "skill": {
      const subcommand = cli.args[0];
      switch (subcommand) {
        case "show": {
          showSkill();
          break;
        }

        case "install": {
          try {
            await installSkill(Boolean(cli.values.global), Boolean(cli.values.force), Boolean(cli.values.yes));
          } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exit(1);
          }
          break;
        }

        case "help":
        case undefined: {
          console.log("Usage: qmd skill <show|install> [options]");
          console.log("");
          console.log("Commands:");
          console.log("  show                 Print the packaged QMD skill");
          console.log("  install              Install into ./.agents/skills/qmd");
          console.log("");
          console.log("Options:");
          console.log("  --global             Install into ~/.agents/skills/qmd");
          console.log("  --yes                Also create the .claude/skills/qmd symlink");
          console.log("  -f, --force          Replace existing install or symlink");
          process.exit(0);
        }

        default:
          console.error(`Unknown subcommand: ${subcommand}`);
          console.error("Run 'qmd skill help' for usage");
          process.exit(1);
      }
      break;
    }

    case "cleanup": {
      const db = getDb();

      const cacheCount = deleteLLMCache(db);
      console.log(`${c.green}✓${c.reset} Cleared ${cacheCount} cached API responses`);

      const orphanedVecs = cleanupOrphanedVectors(db);
      if (orphanedVecs > 0) {
        console.log(`${c.green}✓${c.reset} Removed ${orphanedVecs} orphaned embedding chunks`);
      } else {
        console.log(`${c.dim}No orphaned embeddings to remove${c.reset}`);
      }

      const inactiveDocs = deleteInactiveDocuments(db);
      if (inactiveDocs > 0) {
        console.log(`${c.green}✓${c.reset} Removed ${inactiveDocs} inactive document records`);
      }

      vacuumDatabase(db);
      console.log(`${c.green}✓${c.reset} Database vacuumed`);

      closeDb();
      break;
    }

    default:
      console.error(`Unknown command: ${cli.command}`);
      console.error("Run 'qmd --help' for usage.");
      process.exit(1);
  }

  if (cli.command !== "mcp") {
    await disposeDefaultLlamaCpp();
    process.exit(0);
  }
}
