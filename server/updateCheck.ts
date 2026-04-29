/**
 * Non-blocking update checker.
 *
 * Fetches the latest version from the npm registry and prints a notice
 * if the running version is behind. Failures are silently ignored —
 * this should never block or crash the CLI.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PACKAGE_NAME = "@andycoupe/orchestrator";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

interface CacheEntry {
  latest: string;
  checkedAt: number;
}

function getCachePath(): string {
  return path.join(os.tmpdir(), "orchestrator-update-check.json");
}

function readCache(): CacheEntry | null {
  try {
    const raw = fs.readFileSync(getCachePath(), "utf8");
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.checkedAt < CACHE_TTL_MS) return entry;
  } catch {
    // ignore
  }
  return null;
}

function writeCache(latest: string): void {
  try {
    fs.writeFileSync(
      getCachePath(),
      JSON.stringify({ latest, checkedAt: Date.now() }),
    );
  } catch {
    // ignore
  }
}

function getInstalledVersion(): string {
  const require = createRequire(import.meta.url);
  try {
    return (require("../../package.json") as { version: string }).version;
  } catch {
    return (require("../package.json") as { version: string }).version;
  }
}

function isNewer(latest: string, current: string): boolean {
  // Strip pre-release suffixes for comparison
  const clean = (v: string) => v.replace(/-.*$/, "");
  const [aMaj, aMin, aPatch] = clean(latest).split(".").map(Number);
  const [bMaj, bMin, bPatch] = clean(current).split(".").map(Number);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch > bPatch;
}

// ANSI helpers
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;

/**
 * Check for updates in the background. Prints a notice to stderr if
 * a newer version is available.
 */
export function checkForUpdates(): void {
  const current = getInstalledVersion();

  // Check cache first
  const cached = readCache();
  if (cached) {
    if (isNewer(cached.latest, current)) {
      printNotice(current, cached.latest);
    }
    return;
  }

  // Fire-and-forget fetch
  const url = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
  fetch(url, { signal: AbortSignal.timeout(3000) })
    .then((res) => res.json())
    .then((data: { version?: string }) => {
      if (!data.version) return;
      writeCache(data.version);
      if (isNewer(data.version, current)) {
        printNotice(current, data.version);
      }
    })
    .catch(() => {
      // Silent — network issues are not the user's problem
    });
}

function printNotice(current: string, latest: string): void {
  console.error(
    `\n  ${yellow("Update available")} ${dim(current)} → ${cyan(latest)}` +
      `\n  Run ${cyan(`npm i -g ${PACKAGE_NAME}`)} to update\n`,
  );
}
