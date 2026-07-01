// api/_lib/onshape.js — shared helper for all Onshape API calls
// Centralizes the Access/Secret key auth so every endpoint (documents,
// elements, bom-preview, bom-import) calls Onshape the same way.

export const ONSHAPE_BASE = 'https://cad.onshape.com/api/v8'

// CORS headers shared across all Onshape-related endpoints
export const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export function applyCors(res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
}

/**
 * GET an Onshape API path using Basic auth (Access Key / Secret Key).
 * Throws a descriptive Error on missing credentials or non-2xx responses.
 */
export async function onshapeGet(path) {
  const accessKey = process.env.ONSHAPE_ACCESS_KEY
  const secretKey = process.env.ONSHAPE_SECRET_KEY

  if (!accessKey || !secretKey) {
    throw new Error('ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY must be set in Vercel environment variables.')
  }

  const credentials = Buffer.from(`${accessKey}:${secretKey}`).toString('base64')
  const res = await fetch(`${ONSHAPE_BASE}${path}`, {
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept:        'application/json',
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Onshape API ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

export function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

/**
 * Fetch the raw BOM for an assembly element from Onshape.
 */
export async function fetchBom(documentId, workspaceId, elementId) {
  return onshapeGet(
    `/assemblies/d/${documentId}/w/${workspaceId}/e/${elementId}/bom` +
    `?indented=false&multiLevel=false&generateIfAbsent=true`
  )
}

/**
 * Resolve an Onshape BOM response into a flat list of parts.
 * Used by both the preview endpoint (read-only) and the import endpoint
 * (which also writes the result to Supabase) — kept in one place so the
 * two never drift and disagree on what a given BOM row parses to.
 */
export function parseBomRows(bomData) {
  const headers = bomData.headers ?? []
  const rows    = bomData.rows    ?? []

  const headerById = {}
  headers.forEach(h => { headerById[h.id] = h.name?.toLowerCase() })

  const parts = rows.map(row => {
    const vals = row.headerIdToValue ?? {}

    // Resolve each header ID to a value
    const byName = {}
    Object.entries(vals).forEach(([hid, v]) => {
      const name = headerById[hid]
      if (name) byName[name] = v
    })

    const partName   = byName['name'] || byName['part name'] || byName['description'] || 'Unknown part'
    const partNumber = byName['part number'] || byName['part #'] || byName['pn'] || ''
    const qty        = parseInt(byName['quantity'] || byName['qty'] || byName['count'] || '1', 10) || 1

    return {
      partName:   String(partName),
      partNumber: String(partNumber),
      quantity:   qty,
      raw:        row,   // raw row, kept for future mapping/debugging
    }
  }).filter(p => (p.partName && p.partName !== 'Unknown part') || rows.length === 1)

  return { headers, parts }
}
