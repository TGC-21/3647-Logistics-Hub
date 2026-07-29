// repositories/CartItemRepository.js
//
// Only file that touches .from('cart_items'). Phase 1 part 5 shipped
// the core CRUD; Phase 1 part 6 (Onshape import/reimport) adds the two
// methods OnshapeReimportService needs to re-earmark cart items onto a
// reimported assembly_part's brand-new id.

import { getSupabase } from './supabaseClient.js'
import { DatabaseError } from './errors.js'

function toLocal(row) {
  return {
    id:              row.id,
    cartId:          row.cart_id,
    vendorListingId: row.vendor_listing_id ?? null,
    assemblyPartId:  row.assembly_part_id ?? null,
    nameOverride:    row.name_override ?? '',
    linkOverride:    row.link_override ?? '',
    priceOverride:   row.price_override ?? null,
    quantity:        row.quantity ?? 1,
    status:          row.status ?? 'pending',
    createdAt:       row.created_at,
  }
}

export class CartItemRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  async findById(id) {
    const { data, error } = await this.db
      .from('cart_items').select('*').eq('id', id).maybeSingle()
    if (error) throw new DatabaseError(`cart_items lookup failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  /** Every cart item (any status) earmarked to any part in a given set —
   *  used to snapshot the old tree's earmarks before reimport wipes the
   *  parts they point to (the FK is ON DELETE SET NULL, so the rows
   *  themselves survive un-earmarked either way — this is what lets
   *  reimport re-earmark them onto the replacement part instead of
   *  leaving them stranded as general-restock items). */
  async findByAssemblyPartIds(assemblyPartIds) {
    if (!assemblyPartIds || !assemblyPartIds.length) return []
    const { data, error } = await this.db
      .from('cart_items').select('id, assembly_part_id').in('assembly_part_id', assemblyPartIds)
    if (error) throw new DatabaseError(`cart_items lookup failed: ${error.message}`, error)
    return (data || []).map(row => ({ id: row.id, assemblyPartId: row.assembly_part_id }))
  }

  async updateAssemblyPartId(id, assemblyPartId) {
    const { error } = await this.db
      .from('cart_items').update({ assembly_part_id: assemblyPartId }).eq('id', id)
    if (error) throw new DatabaseError(`cart_items re-earmark failed: ${error.message}`, error)
  }

  /** Deletes 'pending' cart items earmarked to any of the given
   *  assembly_part ids outright — used when the parts they point to
   *  are about to be cascade-deleted. 'ordered'/'received' items are
   *  left alone: the FK (ON DELETE SET NULL) un-earmarks them
   *  automatically, demoting them to general-restock items rather than
   *  destroying the record of a real purchase. Mirrors
   *  src/db.js's deletePendingCartItemsForAssemblyPartIds exactly. */
  async deletePendingForAssemblyPartIds(assemblyPartIds) {
    if (!assemblyPartIds || !assemblyPartIds.length) return
    const { error } = await this.db
      .from('cart_items').delete().in('assembly_part_id', assemblyPartIds).eq('status', 'pending')
    if (error) throw new DatabaseError(`cart_items pending cleanup failed: ${error.message}`, error)
  }

  async insert({ id, cartId, vendorListingId = null, assemblyPartId = null, nameOverride = '', linkOverride = '', priceOverride = null, quantity }) {
    const { data, error } = await this.db
      .from('cart_items')
      .insert({
        id,
        cart_id:            cartId,
        vendor_listing_id:  vendorListingId,
        assembly_part_id:   assemblyPartId,
        name_override:      nameOverride || null,
        link_override:      linkOverride || null,
        price_override:     priceOverride,
        quantity,
        status: 'pending',
      })
      .select().single()
    if (error) throw new DatabaseError(`cart_items insert failed: ${error.message}`, error)
    return toLocal(data)
  }

  async updateStatus(id, status) {
    const { data, error } = await this.db
      .from('cart_items').update({ status }).eq('id', id).select().maybeSingle()
    if (error) throw new DatabaseError(`cart_items status update failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  async delete(id) {
    const { data, error } = await this.db
      .from('cart_items').delete().eq('id', id).select()
    if (error) throw new DatabaseError(`cart_items delete failed: ${error.message}`, error)
    return data.length > 0
  }
}
