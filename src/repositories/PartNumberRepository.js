// repositories/PartNumberRepository.js
//
// Only file that touches .from('part_numbers'). Mirrors src/db.js's
// ensurePartNumberStub — find-or-create-by-value — as a repository
// method pair (findByValue / insert) so CartService can compose the
// find-or-create logic itself rather than the repository silently
// deciding it (same "repositories don't decide business rules"
// discipline errors.js's own doc comment calls out).

import { getSupabase } from './supabaseClient.js'
import { DatabaseError } from './errors.js'

function toLocal(row) {
  return {
    id:          row.id,
    componentId: row.component_id ?? null,
    value:       row.value,
    createdAt:   row.created_at,
  }
}

export class PartNumberRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  async findByValue(value) {
    const { data, error } = await this.db
      .from('part_numbers').select('*').eq('value', value).maybeSingle()
    if (error) throw new DatabaseError(`part_numbers lookup failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  async insert({ id, value }) {
    const { data, error } = await this.db
      .from('part_numbers')
      .insert({ id, value, component_id: null })
      .select().single()
    if (error) {
      // Same race the client-side ensurePartNumberStub already guards
      // against: two concurrent callers both trying to stub the same
      // SKU. Re-read once rather than surfacing a duplicate-key error.
      const { data: retry } = await this.db.from('part_numbers').select('*').eq('value', value).maybeSingle()
      if (retry) return toLocal(retry)
      throw new DatabaseError(`part_numbers insert failed: ${error.message}`, error)
    }
    return toLocal(data)
  }
}
