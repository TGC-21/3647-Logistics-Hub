// repositories/CartRepository.js
//
// Only file that touches .from('carts'). Grown narrowly for
// CartService's needs — findOrCreateCartForVendor is the one cart-level
// operation the current UI (src/partOrders.js) relies on server-side
// equivalents of; everything else about carts (rename, delete, notes)
// stays client-side/db.js until a service actually needs it.

import { getSupabase } from './supabaseClient.js'
import { DatabaseError } from './errors.js'

function toLocal(row) {
  return {
    id:       row.id,
    name:     row.name,
    vendorId: row.vendor_id ?? null,
    status:   row.status ?? 'open',
    notes:    row.notes ?? '',
    createdAt: row.created_at,
  }
}

export class CartRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  /** Every cart, any status — the harness's "what carts exist" read. */
  async findAll() {
    const { data, error } = await this.db.from('carts').select('*').order('created_at', { ascending: false })
    if (error) throw new DatabaseError(`carts lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }

  async findOpenForVendor(vendorId) {
    const { data, error } = await this.db
      .from('carts').select('*').eq('vendor_id', vendorId).eq('status', 'open').maybeSingle()
    if (error) throw new DatabaseError(`carts lookup failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  async insert({ id, name, vendorId }) {
    const { data, error } = await this.db
      .from('carts')
      .insert({ id, name, vendor_id: vendorId, status: 'open' })
      .select().single()
    if (error) throw new DatabaseError(`carts insert failed: ${error.message}`, error)
    return toLocal(data)
  }
}
