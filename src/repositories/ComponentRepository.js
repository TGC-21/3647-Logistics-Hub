// repositories/ComponentRepository.js
//
// Migration Plan Phase 1, item 3 (Component identity / find-or-create).
// Narrow slice of components access — only what ComponentService needs:
// list every component in a category (to run componentMatch.js's
// signature comparison against), insert a brand-new one, and patch its
// fallback display fields. Deliberately does NOT port
// fetchComponentsForFabricatePicker's category-join shape from
// src/db.js — that's a UI-picker concern, not identity resolution, and
// can be added later if a service actually needs it.

import { getSupabase } from './supabaseClient.js'
import { DatabaseError, NotFoundError } from './errors.js'

const COMPONENT_COLUMNS = 'id, category_id, attributes, fallback_name, fallback_description, fallback_image_url, created_at'

function toLocal(row) {
  return {
    id:                   row.id,
    categoryId:           row.category_id ?? null,
    attributes:           row.attributes ?? [],
    fallbackName:         row.fallback_name ?? '',
    fallbackDescription:  row.fallback_description ?? '',
    fallbackImage:        row.fallback_image_url ?? null,
    createdAt:            row.created_at,
  }
}

export class ComponentRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  async findById(id) {
    const { data, error } = await this.db
      .from('components').select(COMPONENT_COLUMNS).eq('id', id).maybeSingle()
    if (error) throw new DatabaseError(`components lookup failed: ${error.message}`, error)
    if (!data) throw new NotFoundError(`Component ${id} not found`)
    return toLocal(data)
  }

  /** Every component in one category — the candidate set
   *  ComponentService signature-matches against to find a duplicate
   *  before creating a new row. */
  async findByCategory(categoryId) {
    const { data, error } = await this.db
      .from('components').select(COMPONENT_COLUMNS).eq('category_id', categoryId)
    if (error) throw new DatabaseError(`components lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }

  async insert({ id, categoryId, attributes, fallbackName, fallbackDescription, fallbackImage }) {
    const { data, error } = await this.db
      .from('components')
      .insert({
        id,
        category_id:           categoryId,
        attributes,
        fallback_name:         fallbackName ?? '',
        fallback_description:  fallbackDescription ?? '',
        fallback_image_url:    fallbackImage ?? null,
      })
      .select().single()
    if (error) throw new DatabaseError(`component insert failed: ${error.message}`, error)
    return toLocal(data)
  }

  async updateFallback(id, { name, description, image }) {
    const { data, error } = await this.db
      .from('components')
      .update({
        fallback_name:        name ?? '',
        fallback_description: description ?? '',
        fallback_image_url:   image ?? null,
      })
      .eq('id', id).select().single()
    if (error) throw new DatabaseError(`component fallback update failed: ${error.message}`, error)
    return toLocal(data)
  }

  async deleteById(id) {
    const { error } = await this.db.from('components').delete().eq('id', id)
    if (error) throw new DatabaseError(`component delete failed: ${error.message}`, error)
  }

  
  /** Every component, any category — the "browse everything" read the
   *  harness needs for list_components. Mirrors
   *  InventoryInstanceRepository.findAll()'s shape/reasoning. */
  async findAll() {
    const { data, error } = await this.db.from('components').select(COMPONENT_COLUMNS)
    if (error) throw new DatabaseError(`components lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }


  /**
   * Free-text search over a component's fallback_name AND its
   * attribute VALUES (e.g. "24T" matching a gear whose "Tooth Count"
   * attribute is "24"). Postgres can't cleanly ilike into a jsonb
   * array's nested values in one indexable expression, so this
   * queries fallback_name via ilike (cheap, indexable) and separately
   * pulls every component to filter attribute values in JS — fine at
   * Partshelf's stated scale (inventories in the hundreds, not
   * millions; README.md's own scale assumption). Revisit with a real
   * Postgres full-text/GIN index on attributes if the catalog ever
   * grows past that.
   */
  async search(query) {
    const q = (query || '').trim().toLowerCase()
    if (!q) return []

    const { data, error } = await this.db.from('components').select(COMPONENT_COLUMNS)
    if (error) throw new DatabaseError(`components search failed: ${error.message}`, error)

    return (data ?? [])
      .map(toLocal)
      .filter(c =>
        (c.fallbackName || '').toLowerCase().includes(q) ||
        (c.fallbackDescription || '').toLowerCase().includes(q) ||
        (c.attributes || []).some(a => String(a.value ?? '').toLowerCase().includes(q) || String(a.key ?? '').toLowerCase().includes(q))
      )
  }
}
