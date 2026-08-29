# Partshelf

## Goal

A centralized inventory tracker for parts: components, categories, and physical
inventory instances (location + quantity). The user base is small (~25 people).
Partshelf is paired with **Clinker**, an in-app AI agent that can look up and
mutate inventory data through natural-language chat, acting on the member's
behalf.

Partshelf previously also covered Onshape-driven assembly design, fabrication
job tracking, part ordering, and an agenda/tasks system. That scope was
deliberately cut — those domains, their services, routes, and UI were removed
(see `deprecated/` for anything not yet fully deleted) so the app and Clinker
could both stay simple and well-scoped. Do not assume those systems still
exist when reading older design docs or commit history.

## Engineering Philosophy

The software should adapt to the team's workflow — not require the team to
adapt to the software. Every architectural decision should support:

- Reduce duplicate work.
- Maintain a single source of truth.
- Make workflows obvious.
- Keep the interface responsive.

## Essential relationships

**Categories** — an adjective for components describing the larger class a
part belongs to (Gears, Pulleys, Bolts, ...). A category defines required
typed characteristics (e.g. a Bolt category might require "Thread size,"
"Length," "Head type").

**Components** — abstraction of a real-life part. A component is identified
by its category + attribute values, **not** by name. A 1/4-20, 2" socket-head
bolt is exactly one component, no matter how many physical copies exist.

**Inventory Instances** — a physical pile of a Component that exists in real
life, at one location, with one quantity. Multiple instances can point at the
same component (e.g. the same bolt split across two bins).

```
Category ──▶ Component ──▶ Inventory Instance
```

## Major Systems

**Inventory** — create/edit/delete inventory instances, manage categories.
This is the whole application surface today.

**Clinker** — the AI agent panel (sidebar / mobile tab). A member chats with
Clinker to look up, create, or update inventory data. Clinker calls the same
service layer (`CategoryService`, `ComponentService`,
`InventoryInstanceService`) the browser UI calls, gated by a per-member trust
level and a confirmation flow for actions above that level. See
`docs/development/clinker.md`.

## Repo Structure

```
src/                    Frontend application (inventory UI, Clinker panel)
backend/                Hono backend, routes called via HTTP
backend/_lib/           Shared backend utilities, harness policy/tool registry
backend/harness/        Clinker's conversation loop, tool schema, context window
docs/                   Project documentation
docs/fixes/             Known issues / prioritized backlog
docs/development/       Feature writeups (Clinker)
api/                    Deprecated — old Vercel serverless entrypoints
deprecated/             Removed domains (Designer/Fabrication/Cart/Agenda/Onshape)
```

## Documentation guide

1. `README.md` — project overview (this file)
2. `docs/architecture.md` — overall architecture
3. `docs/database.md` — database schema
4. `docs/development/clinker.md` — the Clinker agent: how it works, how to extend it
5. `docs/fixes/TODO.md` — prioritized engineering backlog