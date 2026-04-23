import { Hono } from "hono";
import { getDb } from "./db.js";
import { runMigrations } from "./eventStore.js";
import { initProjections } from "./projectionRunner.js";
import "./projections/register.js";
import { createProjectionRoutes } from "./routes/projections.js";
import { createEventRoutes } from "./routes/events.js";
import { createCommandRoutes } from "./routes/commands.js";
import { createBlobRoutes } from "./routes/blobs.js";
import { createProviderRoutes } from "./routes/providers.js";
import { createGateCommandRoutes } from "./routes/gateCommands.js";
import {
  createProbeScheduler,
  configureProviders,
  type ProbeScheduler,
} from "./providers/probeScheduler.js";
import { loadGateRegistry } from "./gates/registry.js";
import { seedPrompts } from "./seedPrompts.js";
import { seedBuiltinPresets } from "./presets.js";
import { createPresetCommandRoutes } from "./routes/presetCommands.js";
import { createPromptCommandRoutes } from "./routes/promptCommands.js";
import { createMeasurementRoutes } from "./routes/measurement.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createRepoRoutes } from "./routes/repo.js";
import { createWorktreeRoutes } from "./routes/worktrees.js";
import { addStaticMiddleware } from "./staticFiles.js";
import { recoverWorktrees } from "./crashRecovery.js";

const app = new Hono();

// Health check
app.get("/healthz", (c) => c.json({ status: "ok" }));

// Bootstrap DB and projections, then mount routes
const db = getDb();
runMigrations(db);
initProjections(db);

// Discard uncommitted worktree changes left by interrupted attempts
await recoverWorktrees(db);

// Load gate definitions from config.yaml
loadGateRegistry();

// Seed provider.configured events for all known providers (idempotent)
await configureProviders(db);

// Seed all bundled prompts (idempotent — checks event log first)
seedPrompts(db);

// Seed 4 built-in presets (idempotent — checks event log first)
seedBuiltinPresets(db);

// Create probe scheduler (started by index.ts, exposed for shutdown)
const probeScheduler: ProbeScheduler = createProbeScheduler(db);

app.route("/", createProjectionRoutes(db));
app.route("/", createEventRoutes(db));
app.route("/", createCommandRoutes(db));
app.route("/", createBlobRoutes());
app.route("/", createProviderRoutes(db, probeScheduler));
app.route("/", createGateCommandRoutes(db));
app.route("/", createPresetCommandRoutes(db));
app.route("/", createPromptCommandRoutes(db));
app.route("/", createMeasurementRoutes(db));
app.route("/", createSettingsRoutes(db));
app.route("/", createRepoRoutes(db));
app.route("/", createWorktreeRoutes(db));

// Serve pre-built frontend (after API routes so they take precedence)
addStaticMiddleware(app);

export { app, probeScheduler };
