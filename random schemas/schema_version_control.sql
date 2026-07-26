-- ============================================================
-- Partshelf – Version Control Migration (Members + Change Log)
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- Safe to run on an existing database — additive only.
-- ============================================================

-- ── Members (identity, prerequisite for actor tracking) ────────
-- ID-lookup "login" only, per product decision — no password. The 7-digit
-- id itself is the primary key and the thing a member types to log in.
create table if not exists members (
  id          text primary key,   -- 7-digit id, e.g. '1234567'
  name        text not null,
  created_at  timestamptz not null default now()
);

alter table members enable row level security;

create policy "Public read members"   on members for select using (true);
create policy "Public insert members" on members for insert with check (true);
create policy "Public update members" on members for update using (true);

comment on table members is
  'Identity for actor tracking in change_log. ID-lookup login only, no password — see product decision in conversation history.';

-- ── Change log (git/Onshape-style commit history) ───────────────
-- One row per FIELD changed. Multiple rows sharing a commit_id represent
-- one user action/save (e.g. editing 3 attributes at once = 3 rows, 1
-- commit_id) — this is what makes it feel like a "commit" rather than a
-- flat event log. create/delete rows have field = null and store the
-- FULL record as JSON in new_value/old_value respectively.
create table if not exists change_log (
  id            text primary key,
  entity_type   text not null,     -- 'inventory_instance' | 'component' | 'assembly' | 'assembly_child' | 'assembly_part' | 'category' | ...
  entity_id     text not null,
  action        text not null check (action in ('create', 'update', 'delete')),
  field         text,              -- null for create/delete (whole-record ops)
  old_value     jsonb,
  new_value     jsonb,
  actor_id      text references members(id) on delete set null,
  commit_id     text not null,     -- groups every field change from one save/action together
  -- Cascade deletes (e.g. deleting an assembly also deletes its parts)
  -- share the PARENT's commit_id but record their own entity_type/entity_id,
  -- and carry a pointer back to the parent entity that triggered the
  -- cascade — lets history queries answer "what else went away when this
  -- assembly was deleted" without re-deriving it from commit_id alone.
  caused_by_entity_type text,
  caused_by_entity_id   text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_change_log_entity  on change_log(entity_type, entity_id);
create index if not exists idx_change_log_commit  on change_log(commit_id);
create index if not exists idx_change_log_actor   on change_log(actor_id);
create index if not exists idx_change_log_caused_by on change_log(caused_by_entity_type, caused_by_entity_id);

alter table change_log enable row level security;

create policy "Public read change_log"   on change_log for select using (true);
create policy "Public insert change_log" on change_log for insert with check (true);

comment on table change_log is
  'Git/Onshape-style version history. commit_id groups related field changes from one save into one unit. Cascade deletes log every affected child row, tagged with caused_by_entity_type/caused_by_entity_id pointing at the row whose deletion triggered them.';
