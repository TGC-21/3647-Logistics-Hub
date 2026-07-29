// repositories/supabaseClient.js
//
// Single place that constructs the service-role Supabase client used by
// every repository. Repositories never call createClient() themselves —
// today that's duplicated inline in almost every api/*.js file (see
// getSupabase() in api/onshape-bom.js, api/onshape-detect-fabrication.js,
// etc.) with identical env-var-checking code copy-pasted each time.
// This file is the one place that knows SUPABASE_URL / SUPABASE_SERVICE_KEY
// exist as env vars.
//
// Kept as a lazily-created singleton (not re-created per call) since a
// Vercel function's module scope is reused across warm invocations —
// same reasoning the old per-file getSupabase() functions relied on
// implicitly, just centralized instead of copy-pasted.

import { createClient } from '@supabase/supabase-js'

let client = null

export function getSupabase() {
  if (client) return client
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.')
  }
  client = createClient(url, key)
  return client
}

/** Test-only escape hatch — lets a unit test inject a fake/mock client
 *  into repositories instead of hitting a real Supabase project. Not
 *  used by application code. */
export function resetSupabaseClientForTests(mockClient = null) {
  client = mockClient
}
