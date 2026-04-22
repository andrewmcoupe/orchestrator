/**
 * Auto-scaffolds the .orchestrator/ directory on first run.
 *
 * Creates the data directory, copies template files, and ensures
 * .orchestrator/ is gitignored.
 */

import fs from "node:fs";
import path from "node:path";
import {
  getOrchestratorDir,
  getBlobsDir,
  getWorktreesDir,
  getConfigPath,
  getCredentialsPath,
  getDefaultRepoRoot,
} from "./paths.js";

/**
 * Resolve the bundled templates/ directory shipped with the package.
 * Uses import.meta.dirname so it works regardless of where the package
 * is installed.
 */
function getTemplatesDir(): string {
  // From dist/server/ we need to go up two levels to reach the package root
  return path.join(import.meta.dirname, "..", "..", "templates");
}

/**
 * Returns true if the .orchestrator/ directory already exists.
 */
export function isAlreadyScaffolded(): boolean {
  return fs.existsSync(getOrchestratorDir());
}

/**
 * Adds `.orchestrator/` to the repo's .gitignore if not already present.
 * Creates .gitignore if it doesn't exist.
 */
export function ensureGitignoreEntry(repoRoot: string): void {
  const entry = ".orchestrator/";
  const gitignorePath = path.join(repoRoot, ".gitignore");
  let contents = "";

  if (fs.existsSync(gitignorePath)) {
    contents = fs.readFileSync(gitignorePath, "utf8");
  }

  if (contents.includes(entry)) {
    return;
  }

  const separator = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(gitignorePath, contents + separator + entry + "\n");
}

export interface ScaffoldResult {
  created: string[];
}

/**
 * Scaffold the .orchestrator/ directory with default config and empty
 * data directories. Returns a list of paths that were created.
 *
 * This is idempotent — if the directory already exists, it returns early.
 */
export function scaffold(): ScaffoldResult {
  if (isAlreadyScaffolded()) {
    return { created: [] };
  }

  const created: string[] = [];
  const orchDir = getOrchestratorDir();

  // Create .orchestrator/
  fs.mkdirSync(orchDir, { recursive: true });
  created.push(orchDir);

  // Create blobs/
  const blobsDir = getBlobsDir();
  fs.mkdirSync(blobsDir, { recursive: true });
  created.push(blobsDir);

  // Create worktrees/
  const worktreesDir = getWorktreesDir();
  fs.mkdirSync(worktreesDir, { recursive: true });
  created.push(worktreesDir);

  // Copy config.yaml from templates
  const configDest = getConfigPath();
  const configSrc = path.join(getTemplatesDir(), "config.yaml");
  if (fs.existsSync(configSrc)) {
    fs.copyFileSync(configSrc, configDest);
  }
  created.push(configDest);

  // Copy .env.local from templates
  const credsDest = getCredentialsPath();
  const credsSrc = path.join(getTemplatesDir(), ".env.local");
  if (fs.existsSync(credsSrc)) {
    fs.copyFileSync(credsSrc, credsDest);
  }
  created.push(credsDest);

  // Ensure .orchestrator/ is in .gitignore
  ensureGitignoreEntry(getDefaultRepoRoot());

  return { created };
}

/**
 * Prints what was scaffolded to stdout.
 */
export function printScaffoldSummary(result: ScaffoldResult): void {
  if (result.created.length === 0) return;

  const repoRoot = getDefaultRepoRoot();
  console.log("Scaffolded .orchestrator/ directory:");
  for (const p of result.created) {
    console.log(`  ${path.relative(repoRoot, p)}`);
  }
  console.log("Added .orchestrator/ to .gitignore");
}
