// componentMatch.js — canonicalizes attribute values by field type so
// component "sameness" can be checked reliably, per category's
// requiredKeysConfig definitions ({ key, type: 'quantity'|'preset'|'string' }).

/** Normalize a single attribute value based on its declared type. */
export function canonicalizeValue(type, rawValue) {
  if (rawValue === null || rawValue === undefined) return ''
  switch (type) {
    case 'quantity': {
      const n = parseFloat(rawValue)
      return Number.isFinite(n) ? String(n) : ''
    }
    case 'enum':
      // Presets are chosen from a fixed list — compare by the option's
      // own value verbatim (already canonical by construction).
      return String(rawValue)
    case 'string':
    default:
      // Loose match: trim + case-fold + collapse internal whitespace.
      return String(rawValue).trim().toLowerCase().replace(/\s+/g, ' ')
  }
}

/** Builds a stable signature string for a (categoryId, attributes) pair,
 *  used to find-or-create the matching component. `fields` is the
 *  category's requiredKeysConfig array; `attrs` is { key: value }. */
export function buildComponentSignature(categoryId, fields, attrs) {
  const parts = [...fields]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(f => `${f.key}=${canonicalizeValue(f.type, attrs[f.key])}`)
  return `${categoryId || 'none'}::${parts.join('|')}`
}