-- ============================================================
-- Partshelf – Bulk/Quick-Collect Migration
-- Additive only. Adds `unlimited` to inventory_instances and updates
-- reserve_inventory_units() to skip availability/depletion for
-- unlimited-flagged source rows. See conversation history for design
-- rationale: an "unlimited" instance is a real inventory_instances row,
-- not a parallel counter, so every existing reservation/unlink/
-- history/reimport code path works on it unmodified.
-- ============================================================

alter table inventory_instances
  add column if not exists unlimited boolean not null default false;

comment on column inventory_instances.unlimited is
  'If true, this pile never depletes — reserve_inventory_units() skips the availability check and never decrements/deletes this row when forking off it. Used by the quick-collect "bulk stock" pile and any user-created unlimited instance.';

create or replace function reserve_inventory_units(
  p_instance_id   text,
  p_quantity      integer,
  p_location      text
) returns inventory_instances
language plpgsql
as $$
declare
  src        inventory_instances;
  new_row    inventory_instances;
begin
  select * into src from inventory_instances where id = p_instance_id for update;

  if src is null then
    raise exception 'Inventory instance % not found', p_instance_id;
  end if;

  if src.unlimited then
    -- Never depletes: skip the availability check and skip mutating/
    -- deleting the source row entirely.
    null;
  else
    if src.quantity < p_quantity then
      raise exception 'Only % available, % requested', src.quantity, p_quantity;
    end if;

    if src.quantity = p_quantity then
      delete from inventory_instances where id = p_instance_id;
    else
      update inventory_instances set quantity = quantity - p_quantity where id = p_instance_id;
    end if;
  end if;

  insert into inventory_instances (
    id, component_id, name, description, image_url, location, quantity, tags, status, notes, unlimited
  ) values (
    src.id || '-fork-' || substr(md5(random()::text), 1, 8),
    src.component_id, src.name, src.description, src.image_url,
    p_location, p_quantity, src.tags, 'in_assembly', src.notes, false
  )
  returning * into new_row;

  return new_row;
end;
$$;