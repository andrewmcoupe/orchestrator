#!/usr/bin/env node

/**
 * CLI entry point for the orchestrator.
 *
 * Usage:
 *   npx @andycoupe/orchestrator [--port 4321] [--help] [--version]
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type ParsedArgs =
  | { help: true }
  | { version: true }
  | { port: number };

export function parseArgs(argv: string[]): ParsedArgs {
  // Check for --help first (highest precedence)
  if (argv.includes("--help")) {
    return { help: true };
  }

  // Check for --version next
  if (argv.includes("--version")) {
    return { version: true };
  }

  let port = 4321;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith("--port=")) {
      const val = arg.slice("--port=".length);
      port = parsePort(val);
    } else if (arg === "--port") {
      const val = argv[++i];
      if (val === undefined) throw new Error("--port requires a value");
      port = parsePort(val);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return { port };
}

function parsePort(val: string): number {
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port: ${val}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Usage / version helpers
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
Usage: orchestrator [options]

Options:
  --port <number>  Port to listen on (default: 4321)
  --help           Show this help message
  --version        Show version number
`.trim());
}

function printVersion(): void {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  console.log(pkg.version);
}

// ---------------------------------------------------------------------------
// Git validation
// ---------------------------------------------------------------------------

/**
 * Walk up from `startDir` looking for a `.git` directory.
 * Returns true if one is found, false if we reach the filesystem root without
 * finding one.
 */
export function isInsideGitRepo(startDir: string = process.cwd()): boolean {
  let dir = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false; // reached root
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  if ("help" in args) {
    printUsage();
    return;
  }

  if ("version" in args) {
    printVersion();
    return;
  }

  // Validate we're inside a git repository
  if (!isInsideGitRepo()) {
    console.error(
      "Error: Not a git repository. Run this command from the root of a git project, or run git init first.",
    );
    process.exit(1);
  }

  // Scaffold .orchestrator/ on first run
  const { scaffold, printScaffoldSummary } = await import("./scaffold.js");
  const scaffoldResult = scaffold();
  printScaffoldSummary(scaffoldResult);

  // Set port in env so the server can pick it up
  process.env.PORT = String(args.port);

  // Dynamic import so we don't pull in the full server for --help/--version
  const { serve } = await import("@hono/node-server");
  const pino = (await import("pino")).default;
  const { app, probeScheduler } = await import("./app.js");
  const { getDb } = await import("./db.js");
  const { createFsWatcher } = await import("./fsWatcher.js");

  const logger = pino({ name: "orchestrator" });

  const server = serve({ fetch: app.fetch, port: args.port }, () => {
    logger.info(`Orchestrator server listening on :${args.port}`);
  });

  const db = getDb();
  const fsWatcher = createFsWatcher(db);
  fsWatcher.start().catch((err) => {
    logger.error({ err }, "Failed to start filesystem watcher");
  });

  probeScheduler.start();

  function shutdown() {
    logger.info("Shutting down...");
    probeScheduler.stop();
    fsWatcher.stop().finally(() => {
      server.close(() => process.exit(0));
    });
  }

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

// Run when executed directly (not imported)
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/cli.js");

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
