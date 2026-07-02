// api/_lib/onshape.js — shared Onshape API helper

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
 * Hierarchical BOM.
 *
 * IMPORTANT: only multiLevel=true here — do NOT add indented=true.
 * When both flags are set together Onshape returns the nested structure
 * AND a flat list of every row, causing every subassembly's parts to appear
 * twice: once inside row.rows (correct) and again as top-level flat rows
 * (incorrect — they show up as direct parts of the parent assembly).
 * multiLevel=true alone gives only the clean nested tree.
 */
export async function fetchBomHierarchical(documentId, workspaceId, elementId) {
  return onshapeGet(
    `/assemblies/d/${documentId}/w/${workspaceId}/e/${elementId}/bom` +
    `?multiLevel=true&generateIfAbsent=true`
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

/** Flat parser — used by the preview endpoint. */
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
 * Hierarchical parser — walks the nested rows from fetchBomHierarchical.
 *
 * A row is treated as a subassembly node if:
 *   - row.rows exists as an array (primary — always present on nested rows), OR
 *   - row.itemSource === 'ASSEMBLY' (secondary — catches empty assemblies)
 *
 * Returns { headers, parts, subassemblies } where:
 *   parts         — direct leaf parts at this level
 *   subassemblies — [{ partName, partNumber, quantity,
 *                       elementId, documentId, workspaceId,
 *                       children: { parts, subassemblies } }]
 *
 * The depth parameter is used internally to cap the tree walk at
 * MAX_CHILD_DEPTH. The import path (onshape-bom.js) also caps recursion
 * at the API-call level via seedAssemblyContents, so both guards apply.
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
      const parsed = resolveRow(row, headerById)

      // Treat as a subassembly node if it has nested rows OR is typed ASSEMBLY
      const isAssemblyNode = Array.isArray(row.rows) ||
                             row.itemSource === 'ASSEMBLY' ||
                             row.itemSource === 'ASSEMBLY_REFERENCE'

      if (isAssemblyNode && depth < MAX_CHILD_DEPTH) {
        subassemblies.push({
          ...parsed,
          elementId:   row.elementId   || row.assemblyElementId  || null,
          documentId:  row.documentId  || null,
          workspaceId: row.workspaceId || row.workspaceOrVersionId || null,
          children:    parseLevel(row.rows ?? [], depth + 1),
        })
      } else if (isAssemblyNode) {
        // Assembly at or beyond max depth — add as a flat part
        if (parsed.partName !== 'Unknown part') parts.push(parsed)
      } else {
        if (parsed.partName !== 'Unknown part') parts.push(parsed)
      }
    }

    return { parts, subassemblies }
  }

  return { headers, ...parseLevel(bomData.rows ?? [], 0) }
}
