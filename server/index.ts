import { serve } from "@hono/node-server";
import pino from "pino";
import { app, probeScheduler } from "./app.js";
import { getDb } from "./db.js";
import { createFsWatcher } from "./fsWatcher.js";

const logger = pino({ name: "orchestrator" });

const PORT = 3001;

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  logger.info(`Orchestrator server listening on :${PORT}`);
});

// Start the filesystem watcher to detect external changes in task worktrees
const db = getDb();
const fsWatcher = createFsWatcher(db);
fsWatcher.start().catch((err) => {
  logger.error({ err }, "Failed to start filesystem watcher");
});

// Start the provider probe scheduler (runs immediately then every 60s)
probeScheduler.start();

// Clean shutdown: stop chokidar and probe scheduler on SIGTERM/SIGINT
function shutdown() {
  logger.info("Shutting down...");
  probeScheduler.stop();
  fsWatcher.stop().finally(() => {
    server.close(() => process.exit(0));
  });
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

export { app };
