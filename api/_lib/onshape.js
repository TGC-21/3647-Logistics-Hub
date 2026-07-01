// api/_lib/onshape.js — shared helper for all Onshape API calls

export const ONSHAPE_BASE = 'https://cad.onshape.com/api/v8'

export const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export function applyCors(res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
}

export function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

// ── Auth + fetch ──────────────────────────────────────────────

export async function onshapeGet(path) {
  const accessKey = process.env.ONSHAPE_ACCESS_KEY
  const secretKey = process.env.ONSHAPE_SECRET_KEY
  if (!accessKey || !secretKey) {
    throw new Error('ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY must be set in Vercel environment variables.')
  }
  const credentials = Buffer.from(`${accessKey}:${secretKey}`).toString('base64')
  const res = await fetch(`${ONSHAPE_BASE}${path}`, {
    headers: { Authorization: `Basic ${credentials}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Onshape API ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

// ── BOM fetching ──────────────────────────────────────────────

/** Flat BOM — used by the preview endpoint. */
export async function fetchBom(documentId, workspaceId, elementId) {
  return onshapeGet(
    `/assemblies/d/${documentId}/w/${workspaceId}/e/${elementId}/bom` +
    `?indented=false&multiLevel=false&generateIfAbsent=true`
  )
}

/**
 * Hierarchical BOM — multiLevel=true returns nested rows where ASSEMBLY rows
 * carry a `rows` array of their own children.
 */
export async function fetchBomHierarchical(documentId, workspaceId, elementId) {
  return onshapeGet(
    `/assemblies/d/${documentId}/w/${workspaceId}/e/${elementId}/bom` +
    `?indented=true&multiLevel=true&generateIfAbsent=true`
  )
}

// ── BOM parsing ───────────────────────────────────────────────

function resolveRow(row, headerById) {
  const vals   = row.headerIdToValue ?? {}
  const byName = {}
  Object.entries(vals).forEach(([hid, v]) => {
    const name = headerById[hid]
    if (name) byName[name] = v
  })
  const partName   = byName['name'] || byName['part name'] || byName['description'] || 'Unknown part'
  const partNumber = byName['part number'] || byName['part #'] || byName['pn'] || ''
  const quantity   = parseInt(byName['quantity'] || byName['qty'] || byName['count'] || '1', 10) || 1
  return { partName: String(partName), partNumber: String(partNumber), quantity, raw: row }
}

/** Flat parser — existing preview + legacy paths use this. */
export function parseBomRows(bomData) {
  const headers    = bomData.headers ?? []
  const headerById = {}
  headers.forEach(h => { headerById[h.id] = h.name?.toLowerCase() })
  const parts = (bomData.rows ?? [])
    .map(row => resolveRow(row, headerById))
    .filter(p => p.partName && p.partName !== 'Unknown part')
  return { headers, parts }
}

/**
 * Hierarchical parser.
 * MAX_CHILD_DEPTH = 2 means we expand subassemblies up to 2 levels below
 * the root (root → children → grandchildren). Anything deeper is a leaf part.
 *
 * Returns a node: { parts, subassemblies }
 *   parts          — direct part rows at this level
 *   subassemblies  — [{ partName, partNumber, quantity,
 *                       elementId, documentId, workspaceId,
 *                       children: { parts, subassemblies } }]
 */
export const MAX_CHILD_DEPTH = 2

export function parseBomHierarchy(bomData) {
  const headers    = bomData.headers ?? []
  const headerById = {}
  headers.forEach(h => { headerById[h.id] = h.name?.toLowerCase() })

  function parseLevel(rows, depth) {
    const parts         = []
    const subassemblies = []

    for (const row of rows) {
      const parsed     = resolveRow(row, headerById)
      const isAssembly = row.itemSource === 'ASSEMBLY' && Array.isArray(row.rows)

      if (isAssembly && depth < MAX_CHILD_DEPTH) {
        const elementId   = row.elementId  || row.assemblyElementId  || null
        const documentId  = row.documentId || null
        const workspaceId = row.workspaceId || row.workspaceOrVersionId || null
        subassemblies.push({
          ...parsed,
          elementId,
          documentId,
          workspaceId,
          children: parseLevel(row.rows, depth + 1),
        })
      } else {
        if (parsed.partName !== 'Unknown part') parts.push(parsed)
      }
    }

    return { parts, subassemblies }
  }

  return { headers, ...parseLevel(bomData.rows ?? [], 0) }
}
