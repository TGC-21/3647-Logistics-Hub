// src/members.js
//
// Migrated off the bare 7-digit-ID lookup onto Supabase Auth
// (password-based). The public surface (getCurrentMemberId,
// getCurrentMemberName, restoreMemberSession, loginMember, addMember,
// logoutMember) is kept as close to the old shape as possible so
// loginScreen.js and every other caller barely change.
//
// Supabase Auth needs a unique identifier per account; members are
// identified by their 7-digit ID everywhere else in the schema
// (assigner_id, actor_id, etc.), so that ID stays the "username" the
// person types — internally it's mapped to a synthesized address
// (`{id}@partshelf.local`) purely to satisfy Auth's email field. The
// member never sees or types an email.
//
// A member created before this migration has members.auth_user_id =
// null — no password yet. loginMember() detects this and returns a
// distinct error so loginScreen.js can route them to "set a password"
// instead of "wrong password", rather than a generic failure.

import { supabase } from './db.js'

let currentMemberId    = null
let currentMemberName  = null
let currentTrustLevel  = 0

function syntheticEmail(id) { return `${id}@partshelf.local` }

export function getCurrentMemberId()   { return currentMemberId }
export function getCurrentMemberName() { return currentMemberName }
export function getCurrentTrustLevel() { return currentTrustLevel }

/** Restores a session Supabase Auth already has client-side (its SDK
 *  persists sessions itself — no more manual localStorage handling
 *  needed here). Resolves once Supabase's own session check completes. */
export async function restoreMemberSession() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  await hydrateFromAuthUser(session.user.id)
  return currentMemberId
}

async function hydrateFromAuthUser(authUserId) {
  const { data, error } = await supabase
    .from('members').select('*').eq('auth_user_id', authUserId).maybeSingle()
  if (error) throw error
  if (!data) { currentMemberId = null; currentMemberName = null; currentTrustLevel = 0; return }
  currentMemberId   = data.id
  currentMemberName = data.name
  currentTrustLevel = data.trust_level ?? 0
}

export function logoutMember() {
  currentMemberId = null
  currentMemberName = null
  currentTrustLevel = 0
  return supabase.auth.signOut()
}

function normalizeId(id) {
  const idStr = String(id || '').trim()
  if (!/^\d{7}$/.test(idStr)) throw new Error('ID must be exactly 7 digits.')
  return idStr
}

/**
 * Creates a new member AND its Supabase Auth account together —
 * password is required now (no more "create then log in separately").
 * Does NOT log the new member in automatically, matching the old
 * function's contract; call loginMember() after if desired.
 */
export async function addMember(id, name, password) {
  const idStr = normalizeId(id)
  const nameStr = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60)
  if (!nameStr) throw new Error('Name is required.')
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.')

  const { data: authData, error: authError } = await supabase.auth.signUp({
    email: syntheticEmail(idStr),
    password,
  })
  if (authError) {
    if (/already registered/i.test(authError.message)) throw new Error('This ID is already registered.')
    throw authError
  }

  const { data, error } = await supabase
    .from('members')
    .insert({ id: idStr, name: nameStr, auth_user_id: authData.user.id })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') throw new Error('This ID is already registered.')
    throw error
  }
  return data
}

/** Logs in by ID + password via Supabase Auth. Throws a distinct,
 *  recognizable message for "this member exists but hasn't set a
 *  password yet" so the UI can route to a setup flow instead of a
 *  generic "wrong password." */
export async function loginMember(id, password) {
  const idStr = normalizeId(id)
  if (!password) throw new Error('Password is required.')

  const { data: memberRow, error: lookupErr } = await supabase
    .from('members').select('auth_user_id').eq('id', idStr).maybeSingle()
  if (lookupErr) throw lookupErr
  if (!memberRow) throw new Error('Member not found — create a member first.')
  if (!memberRow.auth_user_id) throw new Error('NEEDS_PASSWORD_SETUP')

  const { data, error } = await supabase.auth.signInWithPassword({
    email: syntheticEmail(idStr),
    password,
  })
  if (error) throw new Error('Incorrect ID or password.')

  await hydrateFromAuthUser(data.user.id)
  return { id: currentMemberId, name: currentMemberName }
}

/** One-time path for a pre-migration member (auth_user_id still null):
 *  sets their password for the first time, same as addMember's Auth
 *  half but without creating a new members row. */
export async function setInitialPassword(id, password) {
  const idStr = normalizeId(id)
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.')

  const { data: memberRow, error: lookupErr } = await supabase
    .from('members').select('*').eq('id', idStr).maybeSingle()
  if (lookupErr) throw lookupErr
  if (!memberRow) throw new Error('Member not found.')
  if (memberRow.auth_user_id) throw new Error('This member already has a password — sign in instead.')

  const { data: authData, error: authError } = await supabase.auth.signUp({
    email: syntheticEmail(idStr),
    password,
  })
  if (authError) throw authError

  const { error: linkErr } = await supabase
    .from('members').update({ auth_user_id: authData.user.id }).eq('id', idStr)
  if (linkErr) throw linkErr

  await hydrateFromAuthUser(authData.user.id)
  return { id: currentMemberId, name: currentMemberName }
}

export async function fetchMemberById(id) {
  if (!id) return null
  const { data, error } = await supabase.from('members').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

export async function fetchAllMembers() {
  const { data, error } = await supabase.from('members').select('*').order('name')
  if (error) throw error
  return data
}