#!/usr/bin/env node

/**
 * CLI entry point for the orchestrator.
 *
 * Usage:
 *   npx @andycoupe/orchestrator [options]
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import net from "node:net";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_NODE_MAJOR = 20;

// ANSI helpers
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type ParsedArgs =
  | { help: true }
  | { version: true }
  | { init: true }
  | { port: number; open: boolean; verbose: boolean };

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.includes("--help")) return { help: true };
  if (argv.includes("--version")) return { version: true };
  if (argv.includes("--init")) return { init: true };

  let port = 4321;
  let open = true;
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
    } else if (arg === "--port") {
      const val = argv[++i];
      if (val === undefined) throw new Error("--port requires a value");
      port = parsePort(val);
    } else if (arg === "--no-open") {
      open = false;
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--quiet") {
      verbose = false;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return { port, open, verbose };
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

function getVersion(): string {
  const require = createRequire(import.meta.url);
  // Works from both server/ (dev) and dist/server/ (published)
  try {
    return (require("../../package.json") as { version: string }).version;
  } catch {
    return (require("../package.json") as { version: string }).version;
  }
}

function printUsage(): void {
  console.log(`
Usage: orchestrator [options]

Options:
  --port <number>  Port to listen on (default: 4321)
  --no-open        Don't open browser on start
  --verbose        Verbose logging output
  --quiet          Minimal logging output (default)
  --init           Scaffold .orchestrator/ without starting server
  --help           Show this help message
  --version        Show version number
`.trim());
}

function printVersion(): void {
  console.log(getVersion());
}

// ---------------------------------------------------------------------------
// Startup banner
// ---------------------------------------------------------------------------

function printBanner(port: number, startMs: number): void {
  const version = getVersion();
  const elapsed = (performance.now() - startMs).toFixed(0);

  console.log();
  console.log(`  ${bold(green("orchestrator"))} ${dim(`v${version}`)}`);
  console.log();
  console.log(`  ${dim("Local:")}   ${cyan(`http://localhost:${port}`)}`);
  console.log(`  ${dim("Ready in")} ${bold(elapsed + "ms")}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Node version check
// ---------------------------------------------------------------------------

function checkNodeVersion(): void {
  const major = parseInt(process.version.slice(1), 10);
  if (major < MIN_NODE_MAJOR) {
    console.error(
      `\n  ${red("Error:")} Node.js ${MIN_NODE_MAJOR}+ is required (you have ${process.version})` +
        `\n  ${dim("Visit https://nodejs.org to upgrade")}\n`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Git validation
// ---------------------------------------------------------------------------

export function isInsideGitRepo(startDir: string = process.cwd()): boolean {
  let dir = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Port detection
// ---------------------------------------------------------------------------

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(
    `No free port found in range ${startPort}-${startPort + 19}. Use --port to specify a different port.`,
  );
}

// ---------------------------------------------------------------------------
// Friendly errors
// ---------------------------------------------------------------------------

function printFriendlyError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);

  // Known error patterns
  if (message.includes("EADDRINUSE")) {
    const portMatch = message.match(/:(\d+)/);
    const port = portMatch ? portMatch[1] : "unknown";
    console.error(`\n  ${red("Port " + port + " is already in use.")}`);
    console.error(`  ${dim("Try:")} orchestrator --port ${Number(port) + 1}\n`);
    return;
  }

  if (message.startsWith("Unknown flag:") || message.startsWith("Invalid port:")) {
    console.error(`\n  ${red(message)}`);
    console.error(`  ${dim("Run")} orchestrator --help ${dim("for usage info")}\n`);
    return;
  }

  // Generic error
  console.error(`\n  ${red("Error:")} ${message}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const startMs = performance.now();

  checkNodeVersion();

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
      `\n  ${red("Not a git repository.")}` +
        `\n  ${dim("Run")} git init ${dim("to initialize one, then re-run this command.")}\n`,
    );
    process.exit(1);
  }

  // Scaffold .orchestrator/ on first run
  const { scaffold, printScaffoldSummary } = await import("./scaffold.js");
  const scaffoldResult = scaffold();
  printScaffoldSummary(scaffoldResult);

  // --init: scaffold only, don't start server
  if ("init" in args) {
    if (scaffoldResult.created.length === 0) {
      console.log(dim("  .orchestrator/ already exists — nothing to do.\n"));
    }
    return;
  }

  // Find a free port
  let port = args.port;
  if (!(await isPortFree(port))) {
    const freePort = await findFreePort(port + 1);
    console.log(
      `  ${yellow("Port " + port + " in use")} ${dim("→")} using ${bold(String(freePort))}`,
    );
    port = freePort;
  }

  // Set port in env so the server can pick it up
  process.env.PORT = String(port);

  // Dynamic imports — kept lazy for fast --help/--version
  const { serve } = await import("@hono/node-server");
  const pino = (await import("pino")).default;
  const { app, probeScheduler } = await import("./app.js");
  const { getDb } = await import("./db.js");
  const { createFsWatcher } = await import("./fsWatcher.js");
  const { checkForUpdates } = await import("./updateCheck.js");
  const { openBrowser } = await import("./cliBrowser.js");
  const { startKeyboardShortcuts, printShortcutHint } = await import(
    "./cliKeyboard.js"
  );

  const logLevel = args.verbose ? "debug" : "warn";
  const logger = pino({ name: "orchestrator", level: logLevel });

  const server = serve({ fetch: app.fetch, port }, () => {
    printBanner(port, startMs);
    printShortcutHint();

    if (args.open) openBrowser(port);

    // Non-blocking update check
    checkForUpdates();
  });

  const db = getDb();
  const fsWatcher = createFsWatcher(db);
  fsWatcher.start().catch((err) => {
    logger.error({ err }, "Failed to start filesystem watcher");
  });

  probeScheduler.start();

  function shutdown() {
    console.log(`\n  ${dim("Shutting down...")}`);
    probeScheduler.stop();

    // Restore terminal from raw mode before exiting
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }

    fsWatcher.stop().finally(() => {
      server.close(() => {
        console.log(`  ${green("Done.")} ${dim("Goodbye.")}\n`);
        process.exit(0);
      });
    });
  }

  startKeyboardShortcuts(port, shutdown);

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

// Run when executed directly (not imported)
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
const invoked = (() => {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
})();

const isDirectRun =
  thisFile === invoked ||
  invoked?.endsWith("/cli.js") ||
  invoked?.endsWith("/orchestrator");

if (isDirectRun) {
  main().catch((err) => {
    printFriendlyError(err);
    process.exit(1);
  });
}
