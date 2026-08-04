// backend/server.js
//
// Phase 1: standalone Hono server, replacing Vercel's per-file function
// routing. Each api/*.js file becomes one import + one app.route() call
// here — mechanical, and repeated for every remaining route in Phase 2.

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";

import assemblyParts from "./routes/assembly-parts.js";
// Phase 2 — convert + mount the rest of api/*.js the same way:
// import categories from "./routes/categories.js";
// import cartItems from "./routes/cart-items.js";
// import components from "./routes/components.js";
// import fabricationJobs from "./routes/fabrication-jobs.js";
// import fabricationDetection from "./routes/fabrication-detection.js";
// import inventoryReservation from "./routes/inventory-reservation.js";
// import changeLog from "./routes/change-log.js";
// import assembliesV2 from "./routes/assemblies-v2.js";
// import agendaTasksV2 from "./routes/agenda-tasks-v2.js";
// import onshapeAssembly from "./routes/onshape-assembly.js";
// import onshapeLookup from "./routes/onshape-lookup.js";

const app = new Hono();

// Mirrors api/_lib/onshape.js's applyCors() (Allow-Origin: *, GET/POST/OPTIONS,
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
// app.route("/api/categories", categories);
// app.route("/api/cart-items", cartItems);
// app.route("/api/components", components);
// app.route("/api/fabrication-jobs", fabricationJobs);
// app.route("/api/fabrication-detection", fabricationDetection);
// app.route("/api/inventory-reservation", inventoryReservation);
// app.route("/api/change-log", changeLog);
// app.route("/api/assemblies-v2", assembliesV2);
// app.route("/api/agenda-tasks-v2", agendaTasksV2);
// app.route("/api/onshape-assembly", onshapeAssembly);
// app.route("/api/onshape-lookup", onshapeLookup);

const port = process.env.PORT || 3000;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Backend listening on http://localhost:${info.port}`);
});