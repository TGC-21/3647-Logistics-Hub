// api/_lib/changeLog.js
//
// Server-side counterpart to src/changeLog.js. Vercel functions
// (api/onshape-bom.js, api/onshape-detect-fabrication.js, etc) run with
// the Supabase SERVICE-ROLE key via their own createClient() call — they
// never share a JS bundle with the browser, so src/changeLog.js (which
// imports the browser's anon-key `supabase` from src/db.js) is
// unreachable from here. This is a standalone twin with the same row
// shape and the same non-throwing-on-log-failure behavior, just taking
// a `supabase` client as a parameter instead of importing one.
//
// actorId here will usually be null/'system' — reimport and detection
// aren't attributed to a signed-in member's click the way client-side
// edits are, unless you thread the current member's id through the
// fetch call from the browser into the API request body. Left as
// 'system' by default rather than guessing.

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }
export function genCommitId() { return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }

export async function recordChangeServer(supabase, {
  entityType, entityId, action, field = null, oldValue = null, newValue = null,
  actorId = null, commitId, causedByEntityType = null, causedByEntityId = null,
}) {
  if (!commitId) throw new Error('recordChangeServer requires a commitId.')
  const { error } = await supabase.from('change_log').insert({
    id:                    genId(),
    entity_type:           entityType,
    entity_id:             entityId,
    action,
    field,
    old_value:             oldValue ?? null,
    new_value:             newValue ?? null,
    actor_id:              actorId || null,
    commit_id:             commitId,
    caused_by_entity_type: causedByEntityType,
    caused_by_entity_id:   causedByEntityId,
  })
  if (error) console.warn(`[change_log] server insert failed for ${entityType}:${entityId}:`, error.message)
}