# Database Architecture

This document explains the conceptual database design — why it's organized
this way, not the literal column-by-column schema (see the SQL under
`random schemas/` for that).

## Design goals

**Model the real world.** Categories, Components, and Inventory Instances
mirror how the team actually thinks about parts.

**Single source of truth.** A part's definition, its required
characteristics, and its physical location/quantity each exist in exactly
one place.

**Separate "what" from "where".** The most important structural decision in
this schema: a Component describes *what* something is; an Inventory
Instance describes *where* it physically exists. Multiple instances can
reference one component.

```
Component                    Inventory Instance         Inventory Instance
1/4-20 x 2" Socket   ◀──┬──  Drawer C4, Qty 18
Head Bolt                └──  Pit Toolbox, Qty 6
```

## Core inventory tables

- **`categories`** — name + `required_keys_config` (typed characteristic
  definitions: string/quantity/enum/segments).
- **`components`** — `category_id` + `attributes` (jsonb array of
  `{key, value}`) + fallback display fields (name/description/image) used
  when an instance doesn't override them.
- **`inventory_instances`** — `component_id` + location, quantity, tags,
  status (`available` | `in_assembly`), optional per-instance name/
  description/image overrides, and an `unlimited` flag for bulk/untracked
  stock that never depletes.

Component identity (whether two attribute sets count as "the same"
component) is computed once, in `src/componentMatch.js`, and reused by both
the browser and the server — never re-derived independently.

## Auth & change history

- **`members`** — 7-digit ID + name, linked to Supabase Auth
  (`auth_user_id`) for password login. `trust_level` caps how much Clinker
  may do on a member's behalf without asking first.
- **`change_log`** — git/commit-style history. One row per changed field;
  rows sharing a `commit_id` are one save/action. `actor_id` attributes a
  change to a member regardless of whether it came from the browser or from
  Clinker.

## Clinker tables

- **`pending_actions`** — a suspended Clinker action awaiting a member's
  approve/deny decision, keyed with enough info (`action_name`,
  `action_args`) to replay it verbatim once approved.
- **`harness_conversations`** — persisted chat state: `messages` (OpenAI-
  shaped history), `status` (`active` | `awaiting_confirmation` |
  `completed` | `abandoned`), and `pending_proposals` (queued
  image-sourced inventory proposals awaiting review — see
  `docs/development/clinker.md`).

## Entity relationship diagram

```
                    Category
                        │
                        ▼
                  Component
                        │
                        ▼
                Inventory Instance
```

```
                    Member
                    │     │
       trust_level ─┘     └─ auth_user_id → Supabase Auth
                        │
          ┌─────────────┼──────────────┐
          ▼             ▼              ▼
     change_log   pending_actions  harness_conversations
```