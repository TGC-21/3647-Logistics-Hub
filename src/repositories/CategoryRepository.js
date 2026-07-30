// repositories/CategoryRepository.js
//
// Narrow slice, pulled in as a dependency of Migration Plan Phase 1 item
// 3 (Component identity) rather than its own full migration pass (that's
// Plan item 10) — ComponentService needs a category's
// required_keys_config to build a component signature, and this is the
// one read it needs to do that.

import { getSupabase } from './supabaseClient.js'
import { DatabaseError, NotFoundError } from './errors.js'

function toLocal(row) {
  return {
    id:                 row.id,
    name:               row.name,
    requiredKeysConfig: row.required_keys_config ?? [],
  }
}

export class CategoryRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  async findAll() {
    const { data, error } = await this.db.from('categories').select('*').order('name')
    if (error) throw new DatabaseError(`categories lookup failed: ${error.message}`, error)
  return (data ?? []).map(toLocal)
  }

  async findById(id) {
    const { data, error } = await this.db
      .from('categories').select('*').eq('id', id).maybeSingle()
    if (error) throw new DatabaseError(`categories lookup failed: ${error.message}`, error)
    if (!data) throw new NotFoundError(`Category ${id} not found`)
    return toLocal(data)
  }

  async findByName(name) {
    const { data, error } = await this.db
      .from('categories').select('*').eq('name', name).maybeSingle()
    if (error) throw new DatabaseError(`categories lookup failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  /** Creates a category with a fixed set of typed required
   *  characteristics. `requiredKeys` (the plain-name array kept in sync
   *  alongside requiredKeysConfig — see schema.sql's column comment) is
   *  derived here rather than trusted from the caller, same rule
   *  src/db.js's localCatToDb already enforces: requiredKeysConfig is
   *  the single source of truth, requiredKeys is never independently
   *  specified. */
  async insert({ id, name, requiredKeysConfig }) {
    const requiredKeys = (requiredKeysConfig || []).map(c => c.key).filter(Boolean)
    const { data, error } = await this.db
      .from('categories')
      .insert({ id, name, required_keys: requiredKeys, required_keys_config: requiredKeysConfig || [] })
      .select().single()
    if (error) throw new DatabaseError(`category insert failed: ${error.message}`, error)
    return toLocal(data)
  }

    async update(id, { name, requiredKeysConfig }) {
    const requiredKeys = (requiredKeysConfig || []).map(c => c.key).filter(Boolean)
    const { data, error } = await this.db
      .from('categories')
      .update({ name, required_keys: requiredKeys, required_keys_config: requiredKeysConfig || [] })
      .eq('id', id).select().single()
    if (error) throw new DatabaseError(`category update failed: ${error.message}`, error)
    return toLocal(data)
  }

  /** Components in this category are un-categorized automatically by
   *  the schema's ON DELETE SET NULL — nothing else for this repository
   *  to clean up. */
  async deleteById(id) {
    const { error } = await this.db.from('categories').delete().eq('id', id)
    if (error) throw new DatabaseError(`category delete failed: ${error.message}`, error)
  }
}
