// repositories/HarnessConversationRepository.js
//
// Only file that touches .from('harness_conversations'). Backs the
// conversation loop's persistence — a row is the resumable unit for a
// paused (ConfirmationRequiredError) or ongoing agent conversation.
// See AGENTIC_HARNESS_PHASE3_EXECUTION.md.
//
// pending_proposals (schema_harness_proposal_queue.sql) is mapped the
// same way pending_action_id already is: a plain column, read/written
// through the same generic update()/appendMessage() path, no special
// casing needed elsewhere in this file.

import { getSupabase } from './supabaseClient.js'
import { DatabaseError, NotFoundError, ConflictError } from './errors.js'

function toLocal(row) {
  return {
    id:               row.id,
    memberId:         row.member_id,
    status:           row.status,
    messages:         row.messages ?? [],
    pendingActionId:  row.pending_action_id ?? null,
    pendingProposals: row.pending_proposals ?? [],
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  }
}

export class HarnessConversationRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  async findById(id) {
    const { data, error } = await this.db
      .from('harness_conversations').select('*').eq('id', id).maybeSingle()
    if (error) throw new DatabaseError(`harness_conversations lookup failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  async requireById(id) {
    const found = await this.findById(id)
    if (!found) throw new NotFoundError(`Harness conversation ${id} not found`)
    return found
  }

  /** Every active/paused conversation for a member — used to resume
   *  "pick up where I left off" rather than always starting fresh. */
  async findOpenForMember(memberId) {
    const { data, error } = await this.db
      .from('harness_conversations')
      .select('*')
      .eq('member_id', memberId)
      .in('status', ['active', 'awaiting_confirmation'])
      .order('updated_at', { ascending: false })
    if (error) throw new DatabaseError(`harness_conversations lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }

  /** Recent conversations are presentation data for the agent panel.  They
   * are deliberately separate from findOpenForMember(): opening the panel
   * must start a fresh chat rather than silently continuing an old one. */
  async findRecentForMember(memberId, limit = 12) {
    const { data, error } = await this.db
      .from('harness_conversations')
      .select('*')
      .eq('member_id', memberId)
      .order('updated_at', { ascending: false })
      .limit(limit)
    if (error) throw new DatabaseError(`harness_conversations recent lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }

  /** Looks up whichever conversation is blocked on a given
   *  pending_actions row — how the resume path finds its way back once
   *  a member approves/denies. */
  async findByPendingActionId(pendingActionId) {
    const { data, error } = await this.db
      .from('harness_conversations').select('*').eq('pending_action_id', pendingActionId).maybeSingle()
    if (error) throw new DatabaseError(`harness_conversations lookup failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  async insert({ id, memberId, status = 'active', messages = [], pendingActionId = null, pendingProposals = [] }) {
    const { data, error } = await this.db
      .from('harness_conversations')
      .insert({ id, member_id: memberId, status, messages, pending_action_id: pendingActionId, pending_proposals: pendingProposals })
      .select().single()
    if (error) throw new DatabaseError(`harness_conversations insert failed: ${error.message}`, error)
    return toLocal(data)
  }

  /** Generic partial update — the loop calls this after every LLM
   *  round-trip (append to messages) and every status transition
   *  (pause/resume/complete), and now also for pending_proposals
   *  queue mutations. updated_at is bumped explicitly since there's no
   *  DB trigger for it.
   *
   *  `expectedUpdatedAt`, when passed, turns this into an optimistic-
   *  concurrency-checked write: the UPDATE only applies if the row's
   *  current updated_at still matches what the caller last read. If
   *  another writer touched the row in between (e.g. resumeTurn() and
   *  runTurn() racing on the same conversation), zero rows match and
   *  this throws ConflictError instead of silently overwriting
   *  whatever the other writer just wrote — the read-modify-write race
   *  that was previously losing whole messages/status transitions. */
  async update(id, patch, { expectedUpdatedAt = null } = {}) {
    const columns = { updated_at: new Date().toISOString() }
    if (patch.status !== undefined)          columns.status = patch.status
    if (patch.messages !== undefined)        columns.messages = patch.messages
    if (patch.pendingActionId !== undefined) columns.pending_action_id = patch.pendingActionId
    if (patch.pendingProposals !== undefined) columns.pending_proposals = patch.pendingProposals

    let query = this.db.from('harness_conversations').update(columns).eq('id', id)
    if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt)
    const { data, error } = await query.select().maybeSingle()
    if (error) throw new DatabaseError(`harness_conversations update failed: ${error.message}`, error)
    if (!data && expectedUpdatedAt) {
      throw new ConflictError(`harness_conversations ${id} was modified concurrently — retry from a fresh read.`)
    }
    return data ? toLocal(data) : null
  }

  /** Convenience: append one message and persist in one call — the
   *  loop's most common write (every LLM turn, every tool result).
   *
   *  Retries the read-append-write on a ConflictError (another writer
   *  won the race) by re-reading the now-current messages array and
   *  re-appending — this is what actually fixes the "a message
   *  vanishes" symptom instead of just detecting it. A message is
   *  never silently dropped; the append is replayed against whatever
   *  the winning writer left behind. */
  async appendMessage(id, message, { retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const current = await this.requireById(id)
      try {
        return await this.update(
          id,
          { messages: [...current.messages, message] },
          { expectedUpdatedAt: current.updatedAt }
        )
      } catch (err) {
        if (err.name === 'ConflictError' && attempt < retries) continue
        throw err
      }
    }
  }

  /** Batched counterpart to appendMessage() — persists an entire batch
   *  of messages in ONE read-modify-write instead of one round trip per
   *  message. conversationLoop.js accumulates a turn's assistant +
   *  tool-result messages locally (see its `pendingMessages` buffer)
   *  and flushes once per LLM round-trip via this method, instead of
   *  calling appendMessage() once per message — which was re-fetching
   *  and re-writing the full (growing) messages array on every single
   *  message in a turn. Same retry-on-conflict discipline as
   *  appendMessage(). No-ops (returns the current row) if newMessages
   *  is empty, so callers don't need to guard an empty batch themselves. */
  async appendMessages(id, newMessages, { retries = 3 } = {}) {
    if (!newMessages || !newMessages.length) return this.requireById(id)
    for (let attempt = 0; ; attempt++) {
      const current = await this.requireById(id)
      try {
        return await this.update(
          id,
          { messages: [...current.messages, ...newMessages] },
          { expectedUpdatedAt: current.updatedAt }
        )
      } catch (err) {
        if (err.name === 'ConflictError' && attempt < retries) continue
        throw err
      }
    }
  }

  /** Appends one or more proposals to the queue, retrying on a
   *  concurrent-write conflict the same way appendMessage() does —
   *  the queue is read-modify-written, so it needs the same race
   *  protection as the messages array. */
  async appendProposals(id, newProposals, { retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const current = await this.requireById(id)
      try {
        return await this.update(
          id,
          { pendingProposals: [...current.pendingProposals, ...newProposals] },
          { expectedUpdatedAt: current.updatedAt }
        )
      } catch (err) {
        if (err.name === 'ConflictError' && attempt < retries) continue
        throw err
      }
    }
  }

  /** Flips one proposal's status in place (pending -> confirmed |
   *  discarded), same retry-on-conflict discipline. Returns the
   *  updated conversation, or null if no proposal with that id was
   *  found (caller decides whether that's an error). */
  async resolveProposal(id, proposalId, { status, instanceId = null }, { retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const current = await this.requireById(id)
      const idx = current.pendingProposals.findIndex(p => p.id === proposalId)
      if (idx === -1) return null
      const next = [...current.pendingProposals]
      next[idx] = { ...next[idx], status, instanceId, resolvedAt: new Date().toISOString() }
      try {
        return await this.update(id, { pendingProposals: next }, { expectedUpdatedAt: current.updatedAt })
      } catch (err) {
        if (err.name === 'ConflictError' && attempt < retries) continue
        throw err
      }
    }
  }
}
