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
      .from('components').select('*').eq('id', id).maybeSingle()
    if (error) throw new DatabaseError(`components lookup failed: ${error.message}`, error)
    if (!data) throw new NotFoundError(`Component ${id} not found`)
    return toLocal(data)
  }

  /** Every component in one category — the candidate set
   *  ComponentService signature-matches against to find a duplicate
   *  before creating a new row. */
  async findByCategory(categoryId) {
    const { data, error } = await this.db
      .from('components').select('*').eq('category_id', categoryId)
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
}
