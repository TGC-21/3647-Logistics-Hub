-- ============================================================
-- Partshelf – Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

create extension if not exists "uuid-ossp";

-- ── Categories ───────────────────────────────────────────────
create table if not exists categories (
  id            text primary key,
  name          text not null,
  required_keys text[] not null default '{}',
  created_at    timestamptz not null default now()
);

-- ── Components ───────────────────────────────────────────────
create table if not exists components (
  id            text primary key,
  name          text not null,
  description   text,
  category_id   text references categories(id) on delete set null,
  quantity      text,
  location      text,
  image_url     text,
  tags          text[]  not null default '{}',
  attributes    jsonb   not null default '[]',
  created_at    timestamptz not null default now()
);

-- ── Assemblies (subsystems / projects) ───────────────────────
create table if not exists assemblies (
  id                   text primary key,
  name                 text not null,
  description          text,
  onshape_url          text,
  onshape_document_id  text,
  onshape_workspace_id text,
  onshape_element_id   text,        -- the specific assembly element within the document
  thumbnail_url        text,        -- best-effort, pulled from the parent document's thumbnail at link time
  status               text not null default 'draft',  -- draft | active | complete
  created_at           timestamptz not null default now()
);

-- ── Assembly children (subassemblies) ────────────────────────
-- Subassemblies are NOT stored in `assemblies` — they live only here, so
-- they can never show up in "All assemblies" or be opened/edited/deleted
-- as if they were independent top-level assemblies. The BOM hierarchy is
-- preserved by making each row belong to exactly one parent:
--   • parent_assembly_id — set when this is a direct child of a root assembly
--   • parent_child_id    — set when this is nested under ANOTHER subassembly
-- Deleting the parent (either kind) cascades down through the whole
-- subtree, including that subtree's own assembly_parts rows.
drop table if exists assembly_children cascade;
create table assembly_children (
  id                    text primary key,
  parent_assembly_id    text references assemblies(id) on delete cascade,
  parent_child_id       text references assembly_children(id) on delete cascade,
  name                  text not null,
  description           text,
  thumbnail_url         text,
  onshape_document_id   text,
  onshape_workspace_id  text,
  onshape_wvm_type      text not null default 'w',  -- 'w' workspace | 'v' version | 'm' microversion
  onshape_element_id    text,
  quantity              integer not null default 1,
  created_at            timestamptz not null default now(),
  constraint assembly_children_exactly_one_parent check (
    (parent_assembly_id is not null and parent_child_id is null) or
    (parent_assembly_id is null and parent_child_id is not null)
  )
);
create index if not exists idx_assembly_children_parent_assembly on assembly_children(parent_assembly_id);
create index if not exists idx_assembly_children_parent_child    on assembly_children(parent_child_id);

-- Migration for existing installs — these are no-ops on a fresh setup
alter table assemblies add column if not exists onshape_element_id text;
alter table assemblies add column if not exists thumbnail_url      text;

-- ── Row Level Security ───────────────────────────────────────
create table if not exists assembly_parts (
  id                  text primary key,
  assembly_id         text references assemblies(id) on delete cascade,
  assembly_child_id   text references assembly_children(id) on delete cascade,
  part_name           text not null,
  part_number         text not null default '',
  quantity_needed     integer not null default 1,
  quantity_collected  integer not null default 0,
  status              text not null default 'pending',  -- pending | partial | complete
  source              text not null default 'manual',   -- manual | csv | onshape
  notes               text,
  onshape_reference   jsonb,
  created_at          timestamptz not null default now(),
  constraint assembly_parts_exactly_one_owner check (
    (assembly_id is not null and assembly_child_id is null) or
    (assembly_id is null and assembly_child_id is not null)
  )
);

-- Migration for existing installs — these are no-ops on a fresh setup
alter table assembly_parts alter column assembly_id drop not null;
alter table assembly_parts add column if not exists assembly_child_id text references assembly_children(id) on delete cascade;
alter table assembly_parts drop constraint if exists assembly_parts_exactly_one_owner;
alter table assembly_parts add constraint assembly_parts_exactly_one_owner check (
  (assembly_id is not null and assembly_child_id is null) or
  (assembly_id is null and assembly_child_id is not null)
);
create index if not exists idx_assembly_parts_assembly_child on assembly_parts(assembly_child_id);

-- ── Storage bucket for component images ──────────────────────
insert into storage.buckets (id, name, public)
values ('component-images', 'component-images', true)
on conflict do nothing;

-- ── Row Level Security ───────────────────────────────────────
alter table categories      enable row level security;
alter table components      enable row level security;
alter table assemblies      enable row level security;
alter table assembly_parts  enable row level security;
alter table assembly_children enable row level security;

-- Categories
create policy "Public read categories"   on categories for select using (true);
create policy "Public insert categories" on categories for insert with check (true);
create policy "Public update categories" on categories for update using (true);
create policy "Public delete categories" on categories for delete using (true);

-- Components
create policy "Public read components"   on components for select using (true);
create policy "Public insert components" on components for insert with check (true);
create policy "Public update components" on components for update using (true);
create policy "Public delete components" on components for delete using (true);

-- Assemblies
create policy "Public read assemblies"   on assemblies for select using (true);
create policy "Public insert assemblies" on assemblies for insert with check (true);
create policy "Public update assemblies" on assemblies for update using (true);
create policy "Public delete assemblies" on assemblies for delete using (true);

-- Assembly children
create policy "Public read assembly_children"   on assembly_children for select using (true);
create policy "Public insert assembly_children" on assembly_children for insert with check (true);
create policy "Public update assembly_children" on assembly_children for update using (true);
create policy "Public delete assembly_children" on assembly_children for delete using (true);

-- Assembly parts
create policy "Public read assembly_parts"   on assembly_parts for select using (true);
create policy "Public insert assembly_parts" on assembly_parts for insert with check (true);
create policy "Public update assembly_parts" on assembly_parts for update using (true);
create policy "Public delete assembly_parts" on assembly_parts for delete using (true);

-- Storage
create policy "Public image uploads"
  on storage.objects for insert
  with check (bucket_id = 'component-images');

create policy "Public image reads"
  on storage.objects for select
  using (bucket_id = 'component-images');

create policy "Public image deletes"
  on storage.objects for delete
  using (bucket_id = 'component-images');
