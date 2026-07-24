const ONSHAPE_BASE = 'https://cad.onshape.com/api/v6'

// Cap on concurrent in-flight requests to Onshape when fanning out across
// sibling subassemblies (see seedSubassembliesConcurrently in onshape-bom.js).
// Kept here so both this module and onshape-bom.js agree on one constant.
export const MAX_ONSHAPE_CONCURRENCY = 5


export function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

export function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))


/**
 * Retries a 429 (rate limited) with backoff before giving up — everything
 * else (404, 5xx, etc.) is thrown immediately, unchanged from before. This
 * matters more now than it used to: parallelizing sibling subassembly
 * fetches (seedSubassembliesConcurrently) means several requests can land
 * on Onshape at once, which is exactly the situation that trips a limiter.
 */
export async function onshapeGet(path, { retries = 3 } = {}) {
  const accessKey = process.env.ONSHAPE_ACCESS_KEY
  const secretKey = process.env.ONSHAPE_SECRET_KEY
  if (!accessKey || !secretKey) {
    throw new Error('ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY must be set.')
  }
  const credentials = Buffer.from(`${accessKey}:${secretKey}`).toString('base64')

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${ONSHAPE_BASE}${path}`, {
      headers: { Authorization: `Basic ${credentials}`, Accept: 'application/json' },
    })
    if (res.ok) return res.json()

    if (res.status === 429 && attempt < retries) {
      // Honor Retry-After if Onshape sends one; otherwise back off
      // exponentially (400ms, 800ms, 1600ms…) with a little jitter so a
      // burst of parallel requests doesn't all retry in lockstep.
      const retryAfterHeader = res.headers.get('retry-after')
      const retryAfterMs     = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : null
      const backoffMs        = retryAfterMs ?? (400 * 2 ** attempt + Math.random() * 150)
      console.warn(`[onshape] 429 rate limited on ${path} — retrying in ${Math.round(backoffMs)}ms (attempt ${attempt + 1}/${retries})`)
      await sleep(backoffMs)
      continue
    }

    const text = await res.text()
    throw new Error(`Onshape API ${res.status}: ${text.slice(0, 400)}`)
  }
}

export async function onshapePost(path, body, { retries = 3 } = {}) {
  const accessKey = process.env.ONSHAPE_ACCESS_KEY
  const secretKey = process.env.ONSHAPE_SECRET_KEY
  if (!accessKey || !secretKey) {
    throw new Error('ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY must be set.')
  }
  const credentials = Buffer.from(`${accessKey}:${secretKey}`).toString('base64')

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${ONSHAPE_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: 'application/json',
        'Content-Type': 'application/json;charset=UTF-8; qs=0.09',
      },
      body: JSON.stringify(body),
    })
    if (res.ok) return res.json()

    if (res.status === 429 && attempt < retries) {
      const retryAfterHeader = res.headers.get('retry-after')
      const retryAfterMs     = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : null
      const backoffMs        = retryAfterMs ?? (400 * 2 ** attempt + Math.random() * 150)
      console.warn(`[onshape] 429 rate limited on POST ${path} — retrying in ${Math.round(backoffMs)}ms (attempt ${attempt + 1}/${retries})`)
      await sleep(backoffMs)
      continue
    }

    const text = await res.text()
    throw new Error(`Onshape API ${res.status}: ${text.slice(0, 800)}`)
  }
}

// ── BOM fetching ──────────────────────────────────────────────


// Standard BOM column (header) ids. Unlike custom/category-scoped columns,
// these map to Onshape's built-in part properties and have been observed
// stable across documents/templates — same assumption CATEGORY_HEADER_ID
// already relies on. Passed via `bomColumnIds` to ask Onshape to omit
// everything else (material tables, full enum option lists, appearance,
// weight, etc.) from the response entirely rather than serializing and
// discarding it client-side in resolveRow().
//
// If a document's BOM template turns out to use different ids for these
// standard fields, parts fetched with this restriction will silently come
// back as "Unknown part" (nothing resolves to name/qty) even though rows
// exist — that's the signal to widen or drop this list.
const CATEGORY_HEADER_ID = '57f3fb8efa3416c06701d625'

const STANDARD_BOM_COLUMN_IDS = [
  '57f3fb8efa3416c06701d60d', // Name
  '57f3fb8efa3416c06701d60f', // Part number
  '5ace84d3c046ad611c65a0dd', // Quantity  ← was '5ace8269c046ad612c65a0ba' (that id is actually "Item", not Quantity)
  CATEGORY_HEADER_ID,         // Category
]
const QUANTITY_HEADER_ID    = '5ace84d3c046ad611c65a0dd'
const NAME_HEADER_ID        = '57f3fb8efa3416c06701d60d'
const PART_NUMBER_HEADER_ID = '57f3fb8efa3416c06701d60f'

// ── Value unwrapping ─────────────────────────────────────────
//
// Several BOM columns (confirmed for Category; treated as a general risk
// for any column) come back as an object or single-element array wrapping
// the real value rather than a bare primitive — e.g.
// { value: 4 } or [{ name: 'Assembly', ... }] instead of just `4`.
// This unwraps common shapes defensively before anything tries to
// parseInt/String a column value, so a wrapped response degrades to "use
// the wrapped payload" instead of silently producing NaN/"[object Object]".
function unwrapBomValue(val) {
  if (val === null || val === undefined) return val
  if (Array.isArray(val)) return val.length ? unwrapBomValue(val[0]) : null
  if (typeof val === 'object') {
    if ('value' in val) return val.value
    if ('name' in val) return val.name
  }
  return val
}
/**
 * Fetches a BOM at `path`, with a fallback for elements that have never had
 * ANY BOM materialized: `generateIfAbsent=true` is supposed to generate one
 * synchronously, but in practice it can 404 on the very first request for a
 * shape (indented/multiLevel combo) an element has never been asked for —
 * especially elements buried deep in a tree (nested subassemblies, mirrored
 * branches, etc.) that a person has never actually opened the BOM tab for
 * in the Onshape UI. Forcing the plain/default BOM shape first reliably
 * triggers generation; once generated, the originally-requested shape works.
 */
async function fetchBomWithFallback(documentId, wvmType, workspaceId, elementId, queryString, bomColumnIds) {
  const base = `/assemblies/d/${documentId}/${wvmType}/${workspaceId}/e/${elementId}/bom`
  const fullQuery = bomColumnIds?.length
    ? `${queryString}&${bomColumnIds.map(id => `bomColumnIds=${id}`).join('&')}`
    : queryString
  const path = `${base}?${fullQuery}`

  try {
    return await onshapeGet(path)
  } catch (e) {
    if (!/Onshape API 404/.test(e.message)) throw e
  }

  console.warn(`[onshape] BOM 404 for element ${elementId} — forcing default BOM generation, then retrying…`)
  // The forcing call intentionally does NOT pass bomColumnIds — it exists
  // purely to trigger generation, and its response is discarded either way,
  // so there's no reason to ask Onshape to shape it.
  try {
    await onshapeGet(`${base}?generateIfAbsent=true`)
  } catch (e) {
    // If even the plain default BOM 404s, this element has no BOM to give —
    // no point retrying the shaped request, fall through to the final error.
  }

  // Poll with increasing delays instead of one flat 800ms wait — most
  // generations finish well under that, so this returns as soon as the
  // BOM is actually ready rather than always paying the worst-case delay.
  const pollDelaysMs = [150, 300, 500, 800]
  let lastErr
  for (const delay of pollDelaysMs) {
    await sleep(delay)
    try {
      return await onshapeGet(path)
    } catch (e2) {
      lastErr = e2
      if (!/Onshape API 404/.test(e2.message)) throw e2
    }
  }
  
  throw new Error(
    `Could not load the BOM for element ${elementId} (document ${documentId}, ${wvmType} ${workspaceId}). ` +
    `Onshape returned 404 even after forcing BOM generation — check that this element is an Assembly ` +
    `(not a Part Studio/other tab), that the ${wvmType === 'v' ? 'version' : wvmType === 'm' ? 'microversion' : 'workspace'} id is current, and that you have access to it.` +
    (lastErr ? ` (last error: ${lastErr.message})` : '')
  )
}

/**
 * Flat BOM — multiLevel=false + indented=false.
 * Used only at/past MAX_CHILD_DEPTH (leaf level) where we treat every row
 * as a direct part regardless of type.
 *
 * `wvmType` must match the branch type of the referenced element — 'w'
 * (workspace), 'v' (version), or 'm' (microversion). Mirrored / released /
 * frozen references commonly come back as 'v', and hitting the workspace
 * endpoint (`/w/`) for a version-only element 404s even though the ids
 * themselves are perfectly valid.
 */
export async function fetchBom(documentId, workspaceId, elementId, wvmType = 'w', bomColumnIds = STANDARD_BOM_COLUMN_IDS) {
  return fetchBomWithFallback(documentId, wvmType, workspaceId, elementId, 'indented=false&multiLevel=false&generateIfAbsent=true', bomColumnIds)
}

// ── Onshape reference trimming ────────────────────────────────
//
// Onshape BOM rows carry a large amount of UI-only payload per row (full
// material property tables, every enum dropdown's complete option list,
// color/appearance objects, BOM-tree bookkeeping ids, etc.) that nothing
// in Partshelf ever reads. The only piece with a real future consumer is
// `itemSource` — SPACER_AUTO_DETECTION_ROADMAP.md keys its Part-Studio
// grouping/caching off documentId+wvmType+wvmId+elementId+fullConfiguration,
// and per-part identity off partId/partIdentity. Everything else in a raw
// row is discarded before it ever reaches assembly_parts.onshape_reference.
function pickOnshapeReference(row) {
  const src = row?.itemSource || {}
  return {
    documentId:                   src.documentId ?? null,
    wvmType:                      src.wvmType ?? null,
    wvmId:                        src.wvmId ?? null,
    elementId:                    src.elementId ?? null,
    partId:                       src.partId ?? null,
    partIdentity:                 src.partIdentity ?? null,
    configuration:                src.configuration ?? null,
    fullConfiguration:            src.fullConfiguration ?? null,
    sourceElementMicroversionId:  src.sourceElementMicroversionId ?? null,
    isStandardContent:            src.isStandardContent ?? false,
  }
}

// ── Fabrication metadata identity key ───────────────────────────
//
// Same identity tuple resolveBomWithSubassemblies/detection already use
// to group/cache Onshape geometry calls, repurposed as a stable join key
// for carrying fabrication_metadata across a reimport. partIdentity is
// used (not partId) — per onshape-bodydetails.js's own note, it's the
// stronger differentiator for identifying a specific part instance.
// Returns null when there's nothing safe to key on (no partIdentity
// recorded — e.g. rows imported before pickOnshapeReference started
// retaining it), so callers can skip preservation for those rather than
// risk a false collision.
export function fabricationIdentityKey(ref) {
  if (!ref || !ref.partIdentity) return null
  return [
    ref.documentId, ref.wvmType, ref.wvmId, ref.elementId,
    ref.partIdentity, ref.fullConfiguration,
  ].join('::')
}

// ── Source key: the stable cross-reimport identity ──────────────
//
// Every rebuilt assembly_parts row on reimport gets a brand-new `id` —
// nothing about a part's PK survives. To relink promises (inventory
// instances, fabrication jobs, cart items) that were pointing at the OLD
// row onto its replacement, we need something that identifies "the same
// underlying Onshape part" across two independent imports. `partNumber`
// isn't safe (user-editable text, can be blank or duplicated); `partId`
// alone isn't safe either (see Onshape's own docs — `partIdentity` is
// the stronger differentiator within a Part Studio, per the
// spacer-detection roadmap's identical reasoning).
//
// This composite is exactly what Onshape itself uses to aggregate
// repeated identical part instances into one BOM row with a quantity —
// so if two rows share this key, Onshape already considers them "the
// same part," which is precisely the identity a relink needs. Returns
// null if the reference is missing enough fields to trust (e.g. a
// manually-added, non-Onshape part) — callers must treat null as
// "never matches," not as a wildcard.
export function buildSourceKey(ref) {
  if (!ref || !ref.documentId || !ref.elementId) return null
  const partKey = ref.partIdentity || ref.partId
  if (!partKey) return null
  return [
    ref.documentId, ref.wvmType || 'w', ref.wvmId, ref.elementId,
    partKey, ref.fullConfiguration || '',
  ].join('::')
}


// ── Row value resolver ────────────────────────────────────────

export function resolveRow(row, headerById) {
  const vals   = row.headerIdToValue ?? {}
  const byName = {}
  Object.entries(vals).forEach(([hid, v]) => {
    const name = headerById[hid]
    if (name) byName[name] = v
  })

  // Prefer looking up the well-known columns directly by header id — this
  // is immune to a document's BOM template renaming/localizing a column
  // (e.g. "Qty (ea)" instead of "Quantity"), which the old name-matching
  // logic would silently miss and fall back to a default. Only fall back
  // to name-based matching when the id isn't present in this row at all
  // (e.g. a custom/non-standard BOM template that omits it).
  const rawQuantity   = vals[QUANTITY_HEADER_ID]    ?? byName['quantity'] ?? byName['qty'] ?? byName['count']
  const rawPartName   = vals[NAME_HEADER_ID]        ?? byName['name'] ?? byName['part name'] ?? byName['description']
  const rawPartNumber = vals[PART_NUMBER_HEADER_ID] ?? byName['part number'] ?? byName['part #'] ?? byName['pn']

  const unwrappedQuantity = unwrapBomValue(rawQuantity)
  const parsedQuantity    = parseInt(unwrappedQuantity, 10)

  const partName   = unwrapBomValue(rawPartName) ? String(unwrapBomValue(rawPartName)) : 'Unknown part'
  const partNumber = unwrapBomValue(rawPartNumber) ? String(unwrapBomValue(rawPartNumber)) : ''
  const quantity   = Number.isFinite(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : 1

  if (!Number.isFinite(parsedQuantity)) {
    console.warn(`[onshape] Could not resolve a quantity for row "${partName}" — raw value:`, rawQuantity, '— defaulting to 1.')
  }

  return {
    partName: String(partName),
    partNumber: String(partNumber),
    quantity,
    raw: pickOnshapeReference(row),
  }
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



function getCategoryInfo(row) {
  const val = row.headerIdToValue?.[CATEGORY_HEADER_ID]
  if (!val) return null
  const obj = Array.isArray(val) ? val[0] : val
  if (!obj || !obj.name) return null

  const documentIdContainer = row.itemSource.documentId
  return { name: String(obj.name).toLowerCase(), documentId: documentIdContainer ?? null }
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

// How many generations of subassemblies to recurse into as real
// assembly_children nodes before flattening the rest into direct parts.
// Increased from 2 → 5 after finding real trees (e.g. a mirrored branch)
// nested 3+ generations deep that were being flattened prematurely.
export const MAX_CHILD_DEPTH = 5

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
 * WHY resolvedWvmType matters:
 *   `itemSource.wvmType` tells us whether the referenced element lives on
 *   a workspace ('w'), version ('v'), or microversion ('m'). Mirrored /
 *   released / frozen instances commonly resolve to 'v' even when the
 *   containing assembly is on a workspace — assuming 'w' for everything
 *   404s for those rows even though the ids themselves are correct.
 *
 * Returns { headers, directParts, subassemblies }
 */
async function fetchIndentedBom(documentId, workspaceId, elementId, wvmType, bomColumnIds) {
  return fetchBomWithFallback(documentId, wvmType, workspaceId, elementId, 'indented=true&multiLevel=false&generateIfAbsent=true', bomColumnIds)
}
/**
 * Builds the dedupe key for a single Onshape element reference — same
 * source used both to skip refetching an identical subassembly (mirrored
 * arms, repeated gearboxes, etc.) and, per the auto-detection roadmap, to
 * group BOM rows by source Part Studio.
 */
function elementCacheKey(documentId, wvmType, workspaceId, elementId) {
  return `${documentId}::${wvmType}::${workspaceId}::${elementId}`
}

export async function resolveBomWithSubassemblies(
  documentId, workspaceId, elementId, wvmType = 'w', rootOwnerId = null,
  bomColumnIds = STANDARD_BOM_COLUMN_IDS,
  // Shared across one whole import/re-import call tree (root call creates
  // it, recursive calls from onshape-bom.js pass the same Map along) so
  // that a subassembly instanced more than once anywhere in the tree —
  // e.g. two identical gearboxes, a mirrored left/right arm — is fetched
  // and resolved from Onshape exactly once, no matter how many BOM rows
  // reference it.
  resolveCache = new Map()
) {
  const cacheKey = elementCacheKey(documentId, wvmType, workspaceId, elementId)
  if (resolveCache.has(cacheKey)) {
    console.log(`[onshape] Reusing cached resolution for element ${elementId} (already fetched elsewhere in this tree)`)
    return resolveCache.get(cacheKey)
  }

  // Store the in-flight promise itself (not just the eventual result) so
  // that if two sibling rows both reference this same element and get
  // processed concurrently (see seedSubassembliesConcurrently), the second
  // one awaits the first's in-flight fetch instead of kicking off a
  // duplicate request.
  const promise = resolveBomWithSubassembliesUncached(documentId, workspaceId, elementId, wvmType, rootOwnerId, bomColumnIds, resolveCache)
  resolveCache.set(cacheKey, promise)
  return promise
}

async function resolveBomWithSubassembliesUncached(documentId, workspaceId, elementId, wvmType, rootOwnerId, bomColumnIds, resolveCache) {
  const bomData = await fetchIndentedBom(documentId, workspaceId, elementId, wvmType, bomColumnIds)
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
    `Root document owner: ${ownerId} and root doc id: ${documentId}`
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
    const isOurs = documentId !== null && category.documentId !== null && category.documentId === documentId

    if (!isOurs) {
      // Vendor/outside assembly — treat as a purchased (COTS) part rather
      // than something we recurse into.
      console.log(`[onshape] "${parsed.partName}" is an outside-owned assembly (COTS) → logging as part.`)
      directParts.push(parsed)
      continue
    }

    // ── Genuine child (sub)assembly — resolve where its own BOM lives ──
    const src = row.itemSource || {}
    const resolvedElementId   = src.elementId
    const resolvedDocumentId  = src.documentId || documentId
    const resolvedWorkspaceId = src.wvmId || workspaceId
    // 'w' (workspace), 'v' (version), or 'm' (microversion) — mirrored,
    // released, or otherwise frozen references commonly come back as 'v',
    // and hitting the workspace endpoint for those 404s even though the
    // ids themselves are valid.
    const resolvedWvmType     = src.wvmType || 'w'

    if (!resolvedElementId) {
      console.warn(`[onshape] Assembly row "${parsed.partName}" has no itemSource.elementId; treating as part.`)
      directParts.push(parsed)
      continue
    }

    console.log(`[onshape] "${parsed.partName}" is a child assembly → elementId: ${resolvedElementId} (${resolvedWvmType}:${resolvedWorkspaceId})`)
    subassemblies.push({
      ...parsed,
      resolvedElementId,
      resolvedDocumentId,
      resolvedWorkspaceId,
      resolvedWvmType,
    })
  }

  console.log(`[onshape] Resolved: ${directParts.length} direct part(s), ${subassemblies.length} child subassembly(ies)`)
  return { headers, directParts, subassemblies }
}

// api/_lib/onshape.js (or a shared api/_lib/assemblyTree.js), used by both
// onshape-bom.js and onshape-detect-fabrication.js server-side
export async function fetchAssemblyPartTree(supabase, assemblyId) {
  const { data, error } = await supabase.rpc('get_assembly_part_tree', { p_assembly_id: assemblyId })
  if (error) throw error
  return data
}