// componentMatch.js — canonicalizes attribute values by field type so
// component "sameness" can be checked reliably, per category's
// requiredKeysConfig definitions ({ key, type: 'quantity'|'enum'|'string'|'segments' }).

/** Rounds a number to a fixed precision for stable signature comparison —
 *  avoids two floating-point-noisy values of "the same" dimension
 *  (e.g. from independent geometry reconstructions) failing to dedupe
 *  into one component. */
function roundForSignature(n) {
  return Math.round(n * 10000) / 10000
}

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
    case 'segments': {
      // Structural data: { totalLength, segments: [...] } (see
      // AXIAL_SHAFT_DETECTION_ROADMAP.md). Two shafts with identical
      // geometry should dedupe to the same component even if their
      // segment `id`s differ — ids are for override addressing and edit
      // history only, never identity — so `id`, `warnings`, and
      // `userAdded` are excluded from the signature. Every numeric field
      // is rounded to avoid floating-point noise from independent
      // geometry reconstructions defeating dedup. Segment ORDER matters
      // (it's the physical order along the shaft), so this is a
      // positional serialization, not a sorted one — unlike the rest of
      // this function, which sorts by field name for stability but never
      // reorders the segments themselves.
      if (!rawValue || !Array.isArray(rawValue.segments)) return ''
      return rawValue.segments.map(seg => {
        const fields = Object.entries(seg)
          .filter(([k]) => k !== 'id' && k !== 'warnings' && k !== 'userAdded')
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${typeof v === 'number' ? roundForSignature(v) : v}`)
        return `${seg.type}(${fields.join(',')})`
      }).join('|')
    }
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
