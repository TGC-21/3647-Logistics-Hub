const ONSHAPE_BASE = 'https://cad.onshape.com/api/v6'

export function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

export function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export async function onshapeGet(path) {
  const accessKey = process.env.ONSHAPE_ACCESS_KEY
  const secretKey = process.env.ONSHAPE_SECRET_KEY
  if (!accessKey || !secretKey) {
    throw new Error('ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY must be set.')
  }
  const credentials = Buffer.from(`${accessKey}:${secretKey}`).toString('base64')
  const res = await fetch(`${ONSHAPE_BASE}${path}`, {
    headers: { Authorization: `Basic ${credentials}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Onshape API ${res.status}: ${text.slice(0, 400)}`)
  }
  return res.json()
}

// ── BOM fetching ──────────────────────────────────────────────

/**
 * Flat BOM — multiLevel=false + indented=false.
 * Used only at MAX_CHILD_DEPTH (leaf level) where we treat every row
 * as a direct part regardless of type.
 */
export async function fetchBom(documentId, workspaceId, elementId) {
  const path = `/assemblies/d/${documentId}/w/${workspaceId}/e/${elementId}/bom` +
               `?indented=false&multiLevel=false&generateIfAbsent=true`
  try {
    return await onshapeGet(path)
  } catch (e) {
    if (!/Onshape API 404/.test(e.message)) throw e
    console.warn(`[onshape] flat BOM 404 for element ${elementId} — retrying once…`)
    await sleep(800)
    return onshapeGet(path)
  }
}

// ── Row value resolver ────────────────────────────────────────

export function resolveRow(row, headerById) {
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

// ── Flat parser ───────────────────────────────────────────────

export function parseBomRows(bomData) {
  const headers    = bomData.headers ?? []
  const headerById = {}
  headers.forEach(h => { headerById[h.id] = h.name?.toLowerCase() })
  const parts = (bomData.rows ?? [])
    .map(row => resolveRow(row, headerById))
    .filter(p => p.partName && p.partName !== 'Unknown part')
  return { headers, parts }
}

// ── Category / owner resolution ─────────────────────────────────
//
// Every BOM row carries a "Category" column (header id below). Its value
// is an array containing one object whose `name` is either "Onshape part"
// or "Assembly", and whose `ownerId` identifies who owns that category
// definition. We use `name` to tell parts from assemblies, and — for rows
// that ARE assemblies — compare `ownerId` against the root assembly's
// document owner to tell "our" subassemblies from vendor/COTS assemblies
// (which get treated as plain parts).

const CATEGORY_HEADER_ID = '57f3fb8efa3416c06701d625'

function getCategoryInfo(row) {
  const val = row.headerIdToValue?.[CATEGORY_HEADER_ID]
  if (!val) return null
  const obj = Array.isArray(val) ? val[0] : val
  if (!obj || !obj.name) return null

  const ownerIdContainer = row.itemSource.documentId
  return { name: String(obj.name).toLowerCase(), ownerId: ownerIdContainer ?? null }
}

// Cache document → ownerId lookups so a deep BOM tree doesn't repeat
// the same /documents/{id} call for every row that references it.
const documentOwnerCache = new Map()

export async function fetchDocumentOwnerId(documentId) {
  if (documentOwnerCache.has(documentId)) return documentOwnerCache.get(documentId)
  const promise = onshapeGet(`/documents/${documentId}`)
    .then(doc => doc?.owner?.id ?? null)
    .catch(e => {
      console.warn(`[onshape] could not resolve owner for document ${documentId}:`, e.message)
      return null
    })
  documentOwnerCache.set(documentId, promise)
  return promise
}

export const MAX_CHILD_DEPTH = 2

/**
 * resolveBomWithSubassemblies
 *
 * WHY indented=true + multiLevel=false:
 *   • multiLevel=false alone   → flat; assembly rows still appear as
 *     themselves (not exploded) as long as indented=true is also set.
 *   • indented=true            → each assembly row's `itemSource` carries
 *     the referenced element's own documentId/elementId/workspaceId
 *     directly, so we don't need a second "definition" call to find
 *     subassembly elementIds — the BOM row already has everything we need.
 *   • multiLevel=false crucially means Onshape does NOT recurse into
 *     subassembly contents for us — we do that ourselves, one level at a
 *     time, which is what lets us classify each assembly row (ours vs.
 *     vendor/COTS) before deciding whether to descend into it at all.
 *
 * WHY the Category header instead of itemSource/type:
 *   Row-level `itemSource` does not reliably distinguish parts from
 *   assemblies across all Onshape BOM template configurations. The
 *   "Category" column (header id 57f3fb8efa3416c06701d625), however,
 *   always resolves to either "Onshape part" or "Assembly" and also
 *   carries an `ownerId` we can use to detect vendor/COTS assemblies.
 *
 * Returns { headers, directParts, subassemblies }
 */
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Fetches the indented, single-level BOM for an element.
 *
 * `generateIfAbsent=true` is supposed to generate the BOM synchronously if
 * it doesn't exist yet, but in practice Onshape sometimes returns a 404 on
 * the very first request for a given param combination (indented=true +
 * multiLevel=false may never have been requested for this element before)
 * while generation catches up. One short retry clears that up; if it 404s
 * again, it's a real problem (wrong ids, no access, or a Part Studio/other
 * non-assembly element was selected) and we surface a clear message.
 */
async function fetchIndentedBom(documentId, workspaceId, elementId) {
  const path = `/assemblies/d/${documentId}/w/${workspaceId}/e/${elementId}/bom` +
               `?indented=true&multiLevel=false&generateIfAbsent=true`

  try {
    return await onshapeGet(path)
  } catch (e) {
    if (!/Onshape API 404/.test(e.message)) throw e
  }

  // First 404: the element may never have had ANY BOM materialized, and
  // generateIfAbsent doesn't reliably trigger generation for a non-default
  // shape on a completely fresh element. Force-generate the plain/default
  // BOM first (the shape generateIfAbsent is most reliable for), then
  // retry our actual shaped request.
  console.warn(`[onshape] BOM 404 for element ${elementId} — forcing default BOM generation, then retrying…`)
  try {
    await onshapeGet(
      `/assemblies/d/${documentId}/w/${workspaceId}/e/${elementId}/bom?generateIfAbsent=true`
    )
  } catch (e) {
    // If even the plain default BOM 404s, this element has no BOM to give —
    // no point retrying the shaped request, fall through to the final error.
  }

  await sleep(800)
  try {
    return await onshapeGet(path)
  } catch (e2) {
    throw new Error(
      `Could not load the BOM for element ${elementId} (document ${documentId}, workspace ${workspaceId}). ` +
      `Onshape returned 404 even after forcing BOM generation — check that this element is an Assembly ` +
      `(not a Part Studio/other tab), that the workspace id is current, and that you have access to it.`
    )
  }
}

export async function resolveBomWithSubassemblies(documentId, workspaceId, elementId, rootOwnerId = null) {
  const bomData = await fetchIndentedBom(documentId, workspaceId, elementId)

  const headers    = bomData.headers ?? []
  const headerById = {}
  headers.forEach(h => { headerById[h.id] = h.name?.toLowerCase() })

  // The "document owner" we compare against is always the root assembly's
  // document owner — resolved once, then threaded through every recursive
  // call so nested subassemblies are still judged against the same owner.
  const ownerId = rootOwnerId ?? await fetchDocumentOwnerId(documentId)

  const allRows = bomData.rows ?? []
  console.log(
    `[onshape] BOM for element ${elementId}: ${allRows.length} row(s). ` +
    `Root document owner: ${ownerId}`
  )

  const directParts   = []
  const subassemblies = []

  for (const row of allRows) {
    const parsed = resolveRow(row, headerById)
    if (parsed.partName === 'Unknown part') continue

    const category = getCategoryInfo(row)

    if (!category) {
      // No category info at all — fail safe as a direct part rather than
      // silently dropping the row.
      console.warn(`[onshape] Row "${parsed.partName}" has no Category value; treating as part.`)
      directParts.push(parsed)
      continue
    }

    const isPart     = category.name.includes('part')
    const isAssembly = !isPart && category.name.includes('assembly')

    if (isPart) {
      directParts.push(parsed)
      continue
    }

    if (!isAssembly) {
      // Unrecognized category — fail safe as a part.
      console.warn(`[onshape] Row "${parsed.partName}" has unrecognized category "${category.name}"; treating as part.`)
      directParts.push(parsed)
      continue
    }

    // ── It's an assembly row — is it ours, or a vendor/COTS assembly? ──
    const isOurs = ownerId !== null && category.ownerId !== null && category.ownerId === ownerId

    if (!isOurs) {
      // Vendor/outside assembly — treat as a purchased (COTS) part rather
      // than something we recurse into.
      console.log(`[onshape] "${parsed.partName}" is an outside-owned assembly (COTS) → logging as part.`)
      directParts.push(parsed)
      continue
    }

    // ── Genuine child (sub)assembly — resolve where its own BOM lives ──
    const src = row.itemSource || {}
    const resolvedElementId  = src.elementId
    const resolvedDocumentId = src.documentId || documentId
    const resolvedWorkspaceId = src.wvmId || workspaceId

    if (!resolvedElementId) {
      console.warn(`[onshape] Assembly row "${parsed.partName}" has no itemSource.elementId; treating as part.`)
      directParts.push(parsed)
      continue
    }

    console.log(`[onshape] "${parsed.partName}" is a child assembly → elementId: ${resolvedElementId}`)
    subassemblies.push({
      ...parsed,
      resolvedElementId,
      resolvedDocumentId,
      resolvedWorkspaceId,
    })
  }

  console.log(`[onshape] Resolved: ${directParts.length} direct part(s), ${subassemblies.length} child subassembly(ies)`)
  return { headers, directParts, subassemblies }
}
