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

  -- ============================================================
-- PHASE 1: Inventory Instances Refactor
-- Run this AFTER the existing schema.sql has already been applied.
-- ============================================================

-- ── Inventory Instances ──────────────────────────────────────
-- Each row = ONE physical item. Replaces components.quantity as a count;
-- location now lives on the instance, not the component "type".
create table if not exists inventory_instances (
  id            text primary key,
  component_id  text not null references components(id) on delete cascade,
  location      text,
  status        text not null default 'available',  -- available | in_assembly | in_use
  notes         text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_inventory_instances_component on inventory_instances(component_id);
create index if not exists idx_inventory_instances_status    on inventory_instances(status);

alter table inventory_instances enable row level security;
create policy "Public read inventory_instances"   on inventory_instances for select using (true);
create policy "Public insert inventory_instances" on inventory_instances for insert with check (true);
create policy "Public update inventory_instances" on inventory_instances for update using (true);
create policy "Public delete inventory_instances" on inventory_instances for delete using (true);

-- ── Migrate existing components.quantity → instances ─────────
-- For every component with a numeric quantity > 0, spin up N instance
-- rows carrying over the component's old location. Non-numeric or blank
-- quantities are treated as 1 (better to over-create than silently lose
-- an item — you can delete extras after reviewing).
do $$
declare
  comp record;
  qty  integer;
  i    integer;
begin
  for comp in select id, quantity, location from components loop
    qty := coalesce(nullif(regexp_replace(comp.quantity, '[^0-9]', '', 'g'), '')::integer, 1);
    if qty < 1 then qty := 1; end if;
    for i in 1..qty loop
      insert into inventory_instances (id, component_id, location, status)
      values (comp.id || '_inst_' || i, comp.id, comp.location, 'available');
    end loop;
  end loop;
end $$;

-- ── Drop the now-redundant columns from components ───────────
-- Quantity and location are derived from inventory_instances going forward.
alter table components drop column if exists quantity;
alter table components drop column if exists location;

-- ── Link assembly_parts to a component + its reserved instances ──
alter table assembly_parts add column if not exists component_id text references components(id) on delete set null;
alter table assembly_parts add column if not exists linked_instance_ids text[] not null default '{}';
