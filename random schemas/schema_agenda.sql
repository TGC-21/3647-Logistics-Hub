-- ============================================================
-- Partshelf – Agenda Migration (Tasks + Task Links)
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- Safe to run on an existing database — additive only.
--
-- See AGENDA.md for the feature spec / design discussion this schema
-- implements. Deliberately does NOT touch change_log (skipped for v1
-- per product decision) and does NOT add a file-attachments table
-- (skipped for v1 — task_links covers "reference existing app data";
-- literal uploads are a future feature).
-- ============================================================

-- ── Tasks ────────────────────────────────────────────────────
-- The Agenda's basic unit. Deliberately has no `assignees[]` — per
-- product decision, assigner vs. executor is enough distinction for a
-- 25-person team; adding a separate "who was formally assigned" array
-- on top of "who actually claimed it" was judged to be a source of
-- confusion rather than useful signal. executors mirrors
-- fabrication_jobs.claimed_by's shape (a plain array of member ids,
-- since more than one person can commit to a task — unlike a
-- fabrication job, which is claimed by exactly one).
--
-- status is intentionally NOT "draft" — draft/not-drafted isn't a real
-- state per the product discussion; start_date (nullable, defaults to
-- "starts immediately") covers the "when does this start mattering"
-- question instead. "Overdue" is deliberately NOT a stored status — it
-- is derived client-side from deadline vs. now(), the same way
-- assemblies' derivedAssemblyStatus is computed rather than stored.
create table tasks (
  id            text primary key,
  title         text not null,
  description   text,
  deadline      timestamptz,                     -- nullable: not every task needs one
  status        text not null default 'not_started',
  priority      text not null default 'medium',
  assigner_id   text references members(id) on delete set null,
  executors     text[] not null default '{}',    -- member ids who committed to this task
  start_date    timestamptz,                      -- null = starts immediately
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  constraint tasks_status_valid check (
    status in ('not_started', 'in_progress', 'complete', 'archived')
  ),
  constraint tasks_priority_valid check (
    priority in ('low', 'medium', 'high')
  )
);
create index idx_tasks_deadline on tasks(deadline);
create index idx_tasks_status   on tasks(status);
create index idx_tasks_start_date on tasks(start_date);

-- ── Task links (polymorphic references to other app entities) ──
-- A task can reference zero or more existing objects elsewhere in the
-- app — same "loosely typed reference, no real FK" convention
-- change_log.js already uses for caused_by_entity_type/id, chosen over
-- five separate nullable FK columns on `tasks` because a task can link
-- to MULTIPLE items (e.g. two fabrication jobs and one cart item), and
-- because it costs nothing extra to support all five entity types this
-- way — the alternative (5 nullable *_id columns) doesn't even support
-- multiplicity without a join table anyway.
--
-- entity_type is one of: 'assembly' | 'assembly_part' |
-- 'inventory_instance' | 'fabrication_job' | 'cart_item'
--
-- No DB-level FK to any of those five tables (they don't share a common
-- parent to reference polymorphically) — same tradeoff change_log
-- already accepted. Orphaned links (entity since deleted) are expected
-- to be handled at the app layer the same way change_log's deleted-actor
-- case is (fetchMemberById returning null → "(deleted member)" style
-- fallback), not enforced in SQL.
create table task_links (
  id          text primary key,
  task_id     text not null references tasks(id) on delete cascade,
  entity_type text not null,
  entity_id   text not null,
  created_at  timestamptz not null default now(),
  constraint task_links_entity_type_valid check (
    entity_type in ('assembly', 'assembly_part', 'inventory_instance', 'fabrication_job', 'cart_item')
  )
);
create index idx_task_links_task   on task_links(task_id);
create index idx_task_links_entity on task_links(entity_type, entity_id);

-- ── Row Level Security ───────────────────────────────────────
-- Same "public, no auth model" policy every other table in schema.sql
-- uses — Partshelf has no per-user access control anywhere yet.
alter table tasks      enable row level security;
alter table task_links enable row level security;

create policy "Public read tasks"   on tasks for select using (true);
create policy "Public insert tasks" on tasks for insert with check (true);
create policy "Public update tasks" on tasks for update using (true);
create policy "Public delete tasks" on tasks for delete using (true);

create policy "Public read task_links"   on task_links for select using (true);
create policy "Public insert task_links" on task_links for insert with check (true);
create policy "Public update task_links" on task_links for update using (true);
create policy "Public delete task_links" on task_links for delete using (true);
