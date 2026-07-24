// src/members.js
//
// Member identity — the prerequisite for actor tracking in change_log.
// ID-lookup "login" only (no password), per product decision. The
// 7-digit id a member types in is both their identity and their key.
//
// currentMemberId is kept in module state (mirrors the rest of the
// codebase's toastFn-injection pattern) plus sessionStorage, so a page
// refresh doesn't silently drop who's logged in. This is NOT a secure
// session — it's identification, not authentication (again, matches the
// agreed product decision) — so don't rely on it for anything sensitive.

import { supabase } from './db.js'

const STORAGE_KEY = 'partshelf_current_member_id'

let currentMemberId   = null
let currentMemberName = null

// ── Boot: restore whoever was logged in last, if any ────────────
export function restoreMemberSession() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) currentMemberId = saved
  } catch (e) {
    // sessionStorage unavailable (e.g. embedded/artifact context) — fall
    // back to in-memory only for this session.
  }
  return currentMemberId
}

export function getCurrentMemberId()   { return currentMemberId }
export function getCurrentMemberName() { return currentMemberName }

export function logoutMember() {
  currentMemberId = null
  currentMemberName = null
  try { localStorage.removeItem(STORAGE_KEY) } catch (e) {}
}

function normalizeMemberInput(id, name) {
  const idStr = String(id || '').trim()
  const nameStr = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60)
  const errors = []
  if (!/^\d{7}$/.test(idStr)) errors.push('ID must be exactly 7 digits.')
  if (name !== undefined && !nameStr) errors.push('Name is required.')
  return { idStr, nameStr, errors }
}

/** Creates a new member. Does NOT log them in automatically — call
 *  loginMember() after, if that's the desired flow, to keep the two
 *  concerns (creating a record vs. establishing "who's using the app
 *  right now") independently callable. */
export async function addMember(id, name) {
  const { idStr, nameStr, errors } = normalizeMemberInput(id, name)
  if (errors.length) throw new Error(errors.join(' '))

  const { data, error } = await supabase
    .from('members')
    .insert({ id: idStr, name: nameStr })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') throw new Error('This ID is already registered.')
    throw error
  }
  return data
}

/** "Logs in" by looking up the id — sets currentMemberId/currentMemberName
 *  and persists to sessionStorage. Throws if the id isn't registered. */
export async function loginMember(id) {
  const idStr = String(id || '').trim()
  if (!/^\d{7}$/.test(idStr)) throw new Error('ID must be exactly 7 digits.')

  const { data, error } = await supabase
    .from('members')
    .select('*')
    .eq('id', idStr)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Member not found — create a member first.')

  currentMemberId   = data.id
  currentMemberName = data.name
  try { localStorage.setItem(STORAGE_KEY, data.id) } catch (e) {}

  return data
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