-- ============================================================
-- Partshelf – Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- Fresh install — no migration steps included.
-- ============================================================

create extension if not exists "uuid-ossp";

-- ── Categories ───────────────────────────────────────────────
-- required_fields defines the typed characteristics a component in this
-- category must have. Types:
--   'quantity' — numeric (compared as a number)
--   'preset'   — chosen from `options` (compared by exact option value)
--   'string'   — free text (compared trimmed + case-insensitive)
-- Shape: [{ key: 'Thread size', type: 'preset', options: ['M3','M4'] }, ...]
-- required_keys_config defines the typed characteristics a component in
-- this category must have. Types:
--   'quantity' — numeric (compared as a number)
--   'enum'     — chosen from `options` (compared by exact option value)
--   'string'   — free text (compared trimmed + case-insensitive)
-- Shape: [{ key: 'Thread size', type: 'enum', options: ['M3','M4'] }, ...]
-- required_keys is a flat name list kept in sync with required_keys_config
-- for any old code/queries that only need the plain characteristic names.
create table categories (
  id              text primary key,
  name            text not null,
  required_keys        text[] not null default '{}',
  required_keys_config jsonb   not null default '[]',
  created_at      timestamptz not null default now()
);

-- ── Components (internal config — never shown directly in the UI) ──
-- A component is a deduplicated "configuration": a category plus a set of
-- attribute values. It's found-or-created whenever an inventory instance
-- is created or edited, keyed by (category_id, attributes) using the
-- category's required_fields typing rules for comparison. A component is
-- category's required_keys_config typing rules for comparison. A component is
-- deleted automatically once its last instance is removed.
--
-- fallback_name / fallback_description / fallback_image_url are shown on
-- any instance that doesn't set its own override — editable directly via
-- the "component view" in the UI.
create table components (
  id                    text primary key,
  category_id           text references categories(id) on delete set null,
  attributes            jsonb not null default '[]',   -- [{ key, value }, ...]
  fallback_name         text not null default '',
  fallback_description  text,
  fallback_image_url    text,
  created_at            timestamptz not null default now()
);
create index idx_components_category on components(category_id);

-- ── Inventory instances (what users actually see, create, and edit) ──
-- Each row is one physical pile of a component sitting in one location.
-- Name/description/image are optional per-instance overrides of the
-- parent component's fallback values. status/location track whether this
-- pile is free or has been claimed by an assembly part (see reserveInstance
-- / unreserveInstance in db.js).
create table inventory_instances (
  id            text primary key,
  component_id  text not null references components(id) on delete cascade,
  name          text,
  description   text,
  image_url     text,
  location      text not null default '',
  quantity      integer not null default 1,
  tags          text[] not null default '{}',
  status        text not null default 'available',  -- available | in_assembly
  notes         text,
  created_at    timestamptz not null default now()
);
create index idx_inventory_instances_component on inventory_instances(component_id);

-- ── Assemblies (subsystems / projects) ───────────────────────
create table assemblies (
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
create index idx_assembly_children_parent_assembly on assembly_children(parent_assembly_id);
create index idx_assembly_children_parent_child    on assembly_children(parent_child_id);

-- ── Assembly parts ────────────────────────────────────────────
-- A line item an assembly (or subassembly node) needs. Independent of
-- Inventory stock — tracking "how many have I collected" here is separate
-- from how many physically exist in inventory_instances, EXCEPT when a
-- part has actually reserved specific inventory: component_id identifies
-- which component this part draws from, and linked_instance_ids lists the
-- specific inventory_instances rows currently reserved for it. Belongs to
-- exactly one owner: a root assembly OR a subassembly node.
create table assembly_parts (
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
  component_id        text references components(id) on delete set null,
  linked_instance_ids text[] not null default '{}',
  created_at          timestamptz not null default now(),
  constraint assembly_parts_exactly_one_owner check (
    (assembly_id is not null and assembly_child_id is null) or
    (assembly_id is null and assembly_child_id is not null)
  )
);
create index idx_assembly_parts_assembly       on assembly_parts(assembly_id);
create index idx_assembly_parts_assembly_child on assembly_parts(assembly_child_id);
create index idx_assembly_parts_component      on assembly_parts(component_id);

-- ── Storage bucket for component images ──────────────────────
insert into storage.buckets (id, name, public)
values ('component-images', 'component-images', true)
on conflict do nothing;

-- ── Row Level Security ───────────────────────────────────────
alter table categories          enable row level security;
alter table components          enable row level security;
alter table inventory_instances enable row level security;
alter table assemblies          enable row level security;
alter table assembly_children   enable row level security;
alter table assembly_parts      enable row level security;

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

-- Inventory instances
create policy "Public read inventory_instances"   on inventory_instances for select using (true);
create policy "Public insert inventory_instances" on inventory_instances for insert with check (true);
create policy "Public update inventory_instances" on inventory_instances for update using (true);
create policy "Public delete inventory_instances" on inventory_instances for delete using (true);

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