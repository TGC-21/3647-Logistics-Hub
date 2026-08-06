// repositories/PendingActionRepository.js
//
// Only file that touches .from('pending_actions'). Backs the
// ConfirmationRequiredError → suspend → approve/deny → resume flow (see
// AGENTIC_HARNESS.md Phase 3). A row here represents one suspended
// harness action, keyed by enough information (action_name + action_args)
// to replay it verbatim once approved — this repository never
// interprets that payload, only stores/retrieves it.

import { getSupabase } from './supabaseClient.js'
import { DatabaseError, NotFoundError } from './errors.js'

function toLocal(row) {
  return {
    id:          row.id,
    memberId:    row.member_id,
    isAgent:     row.is_agent,
    actionName:  row.action_name,
    actionArgs:  row.action_args,
    severity:    row.severity,
    status:      row.status,
    reason:      row.reason ?? null,
    createdAt:   row.created_at,
    resolvedAt:  row.resolved_at ?? null,
    resolvedBy:  row.resolved_by ?? null,
  }
}

export class PendingActionRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  async findById(id) {
    const { data, error } = await this.db
      .from('pending_actions').select('*').eq('id', id).maybeSingle()
    if (error) throw new DatabaseError(`pending_actions lookup failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  async requireById(id) {
    const found = await this.findById(id)
    if (!found) throw new NotFoundError(`Pending action ${id} not found`)
    return found
  }

  /** Every action awaiting a given member's decision — the "inbox" a
   *  confirm/deny UI reads from. */
  async findAwaitingForMember(memberId) {
    const { data, error } = await this.db
      .from('pending_actions')
      .select('*')
      .eq('member_id', memberId)
      .eq('status', 'awaiting_confirmation')
      .order('created_at', { ascending: true })
    if (error) throw new DatabaseError(`pending_actions lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }

  async insert({ id, memberId, isAgent = true, actionName, actionArgs, severity, reason = null }) {
    const { data, error } = await this.db
      .from('pending_actions')
      .insert({
        id, member_id: memberId, is_agent: isAgent,
        action_name: actionName, action_args: actionArgs,
        severity, reason, status: 'awaiting_confirmation',
      })
      .select().single()
    if (error) throw new DatabaseError(`pending_actions insert failed: ${error.message}`, error)
    return toLocal(data)
  }

  /** Only transitions a row that's still awaiting confirmation — an
   *  already-resolved (or expired) row can't be re-approved/re-denied
   *  out from under a concurrent decision. Returns null if the row
   *  wasn't in the expected state, so the service can distinguish
   *  "already handled" from a real failure. */
  async resolve(id, { status, resolvedBy }) {
    const { data, error } = await this.db
      .from('pending_actions')
      .update({ status, resolved_at: new Date().toISOString(), resolved_by: resolvedBy })
      .eq('id', id)
      .eq('status', 'awaiting_confirmation')
      .select().maybeSingle()
    if (error) throw new DatabaseError(`pending_actions resolve failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }
}