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

-- ── Assembly children (subassembly references) ──────────────
-- One row per subassembly used in a parent assembly.
-- `quantity` = how many instances of the child assembly the parent needs.
-- On delete of the parent, children rows cascade; the child assembly itself
-- is left intact (it can exist standalone or be referenced elsewhere).
create table if not exists assembly_children (
  id                 text primary key,
  parent_assembly_id text not null references assemblies(id) on delete cascade,
  child_assembly_id  text not null references assemblies(id) on delete restrict,
  quantity           integer not null default 1,
  created_at         timestamptz not null default now()
);

-- Migration for existing installs — these are no-ops on a fresh setup
alter table assemblies add column if not exists onshape_element_id text;
alter table assemblies add column if not exists thumbnail_url      text;

-- ── Row Level Security ───────────────────────────────────────
create table if not exists assembly_parts (
  id                  text primary key,
  assembly_id         text not null references assemblies(id) on delete cascade,
  part_name           text not null,
  part_number         text not null default '',
  quantity_needed     integer not null default 1,
  quantity_collected  integer not null default 0,
  status              text not null default 'pending',  -- pending | partial | complete
  source              text not null default 'manual',   -- manual | csv | onshape
  notes               text,
  onshape_reference   jsonb,
  created_at          timestamptz not null default now()
);

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
