// backend/_lib/bulkOps.js
//
// Shared executor for every bulkX service method — runs one mutation per
// item, never lets one failure abort the rest, and returns a uniform
// { succeeded, failed } shape every bulk method reuses. This is what
// makes bulk operations partial-failure-tolerant instead of "one bad id
// ruins the whole batch," which matters a lot more for an LLM caller
// than a human one: a human notices when nothing changed, a model
// hallucinating one wrong id in a list of otherwise-valid ones shouldn't
// cost the other nine.

import { ValidationError } from '../../src/repositories/errors.js'

export const MAX_BULK_ITEMS = 50   // hard ceiling — protects against a hallucinated or misparsed massive batch

/**
 * `items` — array of per-item input (e.g. [{ partId, quantityNeeded }])
 * `fn`    — async (item) => result; throws on per-item failure
 * `keyOf` — extracts a stable identifier from an item, for reporting
 *
 * Returns { succeeded: [{ key, result }], failed: [{ key, error }], summary }
 */
export async function runBulk(items, fn, { keyOf = (item) => item.id ?? JSON.stringify(item) } = {}) {
  if (!Array.isArray(items) || !items.length) {
    throw new ValidationError('At least one item is required')
  }
  if (items.length > MAX_BULK_ITEMS) {
    throw new ValidationError(`Too many items in one bulk call (${items.length}) — max is ${MAX_BULK_ITEMS}. Split into smaller batches.`)
  }

  const succeeded = []
  const failed = []

  for (const item of items) {
    const key = keyOf(item)
    try {
      const result = await fn(item)
      succeeded.push({ key, result })
    } catch (err) {
      failed.push({ key, error: err.message || 'Unknown error' })
    }
  }

  return {
    succeeded, failed,
    summary: `${succeeded.length}/${items.length} succeeded${failed.length ? `, ${failed.length} failed` : ''}.`,
  }
}