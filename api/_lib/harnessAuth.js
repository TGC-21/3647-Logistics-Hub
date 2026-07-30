// api/_lib/harnessAuth.js
//
// Cheap gate for routes the agent harness (or any other external
// automated caller) is allowed to invoke. This is NOT a real per-user
// auth system — it's a single shared secret, checked via a request
// header, that keeps a route from being wide open to anyone who finds
// the URL. See AGENTIC_HARNESS.md's "Decisions" section: this is a lock
// on the harness's own door, not a replacement for the still-open
// per-member auth question (MIGRATION_PLAN.md's Phase 3).
//
// Usage — first line inside a route's try block, so the existing
// statusForError(err) catch-all maps a failure to 401 the same way it
// maps every other typed error:
//
//   import { assertHarnessToken } from './_lib/harnessAuth.js'
//   try {
//     assertHarnessToken(req)
//     ...
//   } catch (err) { return res.status(statusForError(err)).json({ error: err.message }) }
//
// Set HARNESS_API_TOKEN in Vercel's env vars AND the harness's own
// local .env to the same random string (e.g. `openssl rand -hex 32`).
//
// Opt-in per route, NOT global middleware. Routes the browser also
// calls can't require this — client-side code has no way to hold a
// secret without exposing it to every visitor. Only gate routes that
// are harness-only today. api/fabrication-jobs.js currently has zero
// client callers (see MIGRATION_EXAMPLE.md), so it's gated from day
// one; when client cutover happens for a given route later, that
// route's auth story needs a real decision, not just reusing this as-is.
import { UnauthorizedError } from '../../src/repositories/errors.js'

export function assertHarnessToken(req) {
  const expected = process.env.HARNESS_API_TOKEN
  if (!expected) {
    // Fail closed: an unconfigured deployment treats every harness-only
    // route as unavailable rather than silently open to anyone.
    throw new UnauthorizedError('Harness auth is not configured on this deployment (HARNESS_API_TOKEN missing).')
  }
  const provided = req.headers['x-harness-token']
  if (provided !== expected) {
    throw new UnauthorizedError('Missing or invalid X-Harness-Token header.')
  }
}