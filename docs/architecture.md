This document explains Partshelf's internal organization. It focuses on
concepts and workflows rather than implementation details.

## Core design philosophy

Partshelf models physical inventory: what a part *is* (Component), separate
from where and how many physically exist (Inventory Instance), organized
under Categories that define required attributes per part family.

Partshelf is intentionally narrow in scope today. Earlier iterations of this
codebase also handled Onshape-driven assembly design, fabrication job
tracking, part ordering (cart/vendor), and an agenda/tasks system. That scope
was cut back to just inventory + Clinker — do not build against or reference
those older domains; their services/routes/UI have been removed.

## Domain model

### Categories
Categories describe families of components (Bearings, Bolts, Shafts,
Plates, Belts, ...) and define required typed characteristics every
component in that category must populate. A characteristic has a type:
`string` (free text), `quantity` (numeric, optional default unit), `enum`
(fixed preset list), or `segments` (structured shaft-profile data).

### Components
A Component describes *what* a part is: a category + a set of attribute
values. Components are identified by category + attributes, never by name —
two components with the same name but different attributes are different
components, and two components with identical category + attributes are the
same component regardless of what they're called.

### Inventory Instances
An Inventory Instance describes *where* a component physically exists: one
row per pile, carrying its own location, quantity, optional name/description/
image overrides, and tags. Multiple instances can reference the same
component.

## System responsibilities

### Inventory
Owns Categories, Components, Inventory Instances, locations, search, and
component/instance images. This is the entirety of the application's
domain surface today.

### Clinker
The agent layer. Clinker is not a separate domain — it's an alternate,
conversational entry point into the exact same service layer
(`CategoryService`, `ComponentService`, `InventoryInstanceService`) that the
browser UI calls directly. Clinker's own machinery (conversation loop, tool
registry, trust levels, confirmation flow, context-window management) lives
under `backend/harness/` and `backend/_lib/harness*.js`. See
`docs/development/clinker.md` for the full design.

## Layering

```
Browser UI (src/main.js, src/agentPanel.js)
        │
        ▼
Routes (backend/routes/*.js) — thin, action-dispatched
        │
        ▼
Services (src/services/*.js) — business rules, no SQL, no HTTP
        │
        ▼
Repositories (src/repositories/*.js) — only files that touch Supabase
        │
        ▼
Supabase (Postgres + Storage + Auth)
```

Clinker calls into this same stack through one additional layer:
`backend/_lib/harnessToolRegistry.js` (tool dispatch) →
`src/services/HarnessGateway.js` (trust-level gate) → the same Service
classes above. No service is aware that Clinker exists — trust-level gating
happens entirely in the gateway, not in the services themselves.

## Architectural principles

**Agent-first priority.** This codebase is maintained mainly by AI coding
agents. The frontend/UI caters to human users; the code and docs should be
written to be easily understood and extended by an agent.

**Single source of truth.** Inventory never duplicates Component
definitions. A Component's identity (category + attributes) is computed the
same way everywhere via `src/componentMatch.js`'s signature function —
client-side and server-side never fork their own copy of that logic.

**Domain separation.** Inventory and Clinker communicate through the service
layer's public methods, not shared internal state.

**Workflow first.** Every additional click, dialog, or manual data entry
needs a clear justification. If users start keeping parallel spreadsheets or
notes, the application has failed its primary objective.

## Current scope boundary

In scope: Categories, Components, Inventory Instances, member auth
(`members.js`, Supabase Auth), Clinker (chat panel, conversation persistence,
trust-level/confirmation flow, image-to-inventory proposal flow).

Explicitly out of scope today (removed, not just paused): Onshape BOM
import/reimport, fabrication-job tracking, part-order carts/vendors, the
agenda/tasks system, and their associated services, routes, and detectors.