// backend/server.js
//
// Standalone Hono server, replacing Vercel's per-file function routing.
// Every api/*.js file is now converted — one import + one app.route()
// call each, mirroring the original /api/<filename> path exactly.

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Vite builds to <repo root>/dist — backend/ sits alongside it, so ../dist.
const DIST_DIR = path.join(__dirname, "..", "dist");
// Read once at boot rather than per-request. Missing dist/ (e.g. you're
// running `backend` alone against a separately-hosted frontend, or
// haven't run `npm run build` yet) degrades to API-only instead of
// crashing the whole server on startup.
let INDEX_HTML = null;
try {
  INDEX_HTML = readFileSync(path.join(DIST_DIR, "index.html"), "utf-8");
} catch {
  console.warn(`No build found at ${DIST_DIR} — serving API only. Run "npm run build" in the repo root to enable static frontend serving.`);
}

import assemblyParts from "./routes/assembly-parts.js";
import categories from "./routes/categories.js";
import cartItems from "./routes/cart-items.js";
import components from "./routes/components.js";
import fabricationJobs from "./routes/fabrication-jobs.js";
import fabricationDetection from "./routes/fabrication-detection.js";
import inventoryReservation from "./routes/inventory-reservation.js";
import changeLog from "./routes/change-log.js";
import assembliesV2 from "./routes/assemblies-v2.js";
import agendaTasksV2 from "./routes/agenda-tasks-v2.js";
import onshapeAssembly from "./routes/onshape-assembly.js";
import onshapeLookup from "./routes/onshape-lookup.js";
import harnessInvoke from "./routes/harness-invoke.js";
import pendingActions from "./routes/pending-actions.js";
import agentChat from "./routes/agent-chat.js";

const app = new Hono();

// Mirrors backend/_lib/onshape.js's applyCors() (Allow-Origin: *, GET/POST/OPTIONS,
// Content-Type). Tighten this to your actual domain once you're behind
// Caddy/WireGuard — wide open is fine for local dev only.
app.use(
  "/api/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

// Health check — used now to sanity-check the server is up, and later
// as the endpoint your uptime monitor polls.
app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/assembly-parts", assemblyParts);
app.route("/api/categories", categories);
app.route("/api/cart-items", cartItems);
app.route("/api/components", components);
app.route("/api/fabrication-jobs", fabricationJobs);
app.route("/api/fabrication-detection", fabricationDetection);
app.route("/api/inventory-reservation", inventoryReservation);
app.route("/api/change-log", changeLog);
app.route("/api/assemblies-v2", assembliesV2);
app.route("/api/agenda-tasks-v2", agendaTasksV2);
app.route("/api/onshape-assembly", onshapeAssembly);
app.route("/api/onshape-lookup", onshapeLookup);
app.route("/api/harness-invoke", harnessInvoke);
app.route("/api/pending-actions", pendingActions);
app.route("/api/agent-chat", agentChat);

// Static frontend (Vite's built dist/) + SPA fallback. Only mounted if a
// build was found at boot — see the try/catch above.
if (INDEX_HTML) {
  // serveStatic resolves `root` relative to process.cwd() — the systemd
  // unit sets WorkingDirectory to backend/, so "../dist" is correct as
  // long as you always launch this from inside backend/ (npm start, or
  // the systemd unit below). Don't launch from the repo root instead.
  app.use("*", serveStatic({ root: "../dist" }));
  // Any GET that isn't a real static file and isn't /api/* or /health —
  // hand back index.html so client-side routing (if any) still works,
  // same as Vercel's default SPA behavior for this project.
  app.get("*", (c) => c.html(INDEX_HTML));
}

const port = process.env.PORT || 3000;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Backend listening on http://localhost:${info.port}`);
});