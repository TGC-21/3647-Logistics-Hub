// backend/harness/turnLock.js
//
// Shared in-memory lock so at most one conversation-loop turn — whether
// started via agent-chat.js's runTurn() or pending-actions.js's
// resumeTurn() — can be in flight for a given conversation at a time.
//
// Previously agent-chat.js tracked its own private `activeTurns` Set,
// so an approve/deny hitting resumeTurn() directly from
// pending-actions.js had no way to see — or block on — a concurrent
// runTurn() for the same conversation. Both would race to
// read-modify-write the same harness_conversations row (see
// HarnessConversationRepository's appendMessage/update). This module
// is the single lock both entry points now share.
//
// Process-local only (same scope the old activeTurns Set had) — fine
// since the harness loop runs in a single Node process (backend/server.js).

const activeLocks = new Set()

export function tryAcquire(key) {
  if (activeLocks.has(key)) return false
  activeLocks.add(key)
  return true
}

export function release(key) {
  activeLocks.delete(key)
}

export function isLocked(key) {
  return activeLocks.has(key)
}

/** Runs fn() while holding the lock for `key`. Throws (without running
 *  fn) if the lock is already held — callers translate that into
 *  whatever response shape fits their route. */
export async function withTurnLock(key, fn) {
  if (!tryAcquire(key)) {
    const err = new Error(`A Clinker turn is already running for "${key}".`)
    err.code = 'TURN_LOCKED'
    throw err
  }
  try {
    return await fn()
  } finally {
    release(key)
  }
}