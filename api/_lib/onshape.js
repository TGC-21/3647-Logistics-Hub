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
  return onshapeGet(
    `/assemblies/d/${documentId}/w/${workspaceId}/e/${elementId}/bom` +
    `?indented=false&multiLevel=false&generateIfAbsent=true`
  )
}

/**
 * Assembly Definition endpoint.
 * The ONLY reliable source of subassembly elementId values.
 * BOM rows of type ASSEMBLY do not carry an elementId; the definition does.
 */
export async function fetchAssemblyDefinition(documentId, workspaceId, elementId) {
  return onshapeGet(
    `/assemblies/d/${documentId}/w/${workspaceId}/e/${elementId}/definition` +
    `?includeMateFeatures=false&includeNonSolids=false`
  )
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

// ── Subassembly-aware resolver ────────────────────────────────

export const MAX_CHILD_DEPTH = 2

/**
 * resolveBomWithSubassemblies
 *
 * WHY indented=true + multiLevel=true:
 *   • multiLevel=false  → Onshape flattens everything. Sub-assembly rows
 *     are dissolved into their constituent parts. ASSEMBLY-type rows never
 *     appear, so subassemblies can never be detected.
 *   • multiLevel=true alone → ASSEMBLY rows appear, but their child parts
 *     are ALSO included as top-level rows, duplicating them.
 *   • indented=true + multiLevel=true → ASSEMBLY rows appear AND each row
 *     carries an `indent` integer (0 = direct child of this assembly,
 *     1 = inside a sub-assembly, …). Filtering to indent === 0 gives us
 *     exactly the direct parts + sub-assembly references without duplicates.
 *
 * WHY definition endpoint:
 *   BOM rows of itemSource ASSEMBLY do not carry an elementId.
 *   The definition endpoint returns every placed instance with its
 *   documentId + elementId, which we need to fetch each sub-assembly's
 *   own BOM recursively.
 *
 * Returns { headers, directParts, subassemblies }
 */
export async function resolveBomWithSubassemblies(documentId, workspaceId, elementId) {
  const [bomData, defData] = await Promise.all([
    onshapeGet(
      `/assemblies/d/${documentId}/w/${workspaceId}/e/${elementId}/bom` +
      `?indented=true&multiLevel=true&generateIfAbsent=true`
    ),
    fetchAssemblyDefinition(documentId, workspaceId, elementId).catch(e => {
      console.warn('[onshape] definition fetch failed (will attempt name-match only):', e.message)
      return null
    }),
  ])

  const headers    = bomData.headers ?? []
  const headerById = {}
  headers.forEach(h => { headerById[h.id] = h.name?.toLowerCase() })

  // Build lookup maps from definition Assembly instances.
  // Onshape may use 'Assembly' or 'ASSEMBLY' for the type field.
  const defAssemblies = (defData?.instances ?? []).filter(
    i => i.type === 'Assembly' || i.type === 'ASSEMBLY'
  )
  const byInstanceId = {}
  const byElementId  = {}
  const byName       = {}
  defAssemblies.forEach(i => {
    if (i.id)        byInstanceId[i.id]       = i
    if (i.elementId) byElementId[i.elementId] = i
    const k = (i.name || '').toLowerCase()
    if (k && !byName[k]) byName[k] = i   // first match wins on duplicate names
  })

  // ── Diagnostic log (visible in Vercel function logs) ─────
  const allRows = bomData.rows ?? []
  const indent0  = allRows.filter(r => (r.indent ?? r.indentLevel ?? 0) === 0)
  const asmRows  = indent0.filter(r => {
    const src = (r.itemSource || '').toUpperCase()
    return src === 'ASSEMBLY' || src === 'ASSEMBLY_REFERENCE'
  })
  console.log(
    `[onshape] BOM: ${allRows.length} total rows, ${indent0.length} at indent=0, ` +
    `${asmRows.length} ASSEMBLY-type at indent=0. ` +
    `Definition: ${defAssemblies.length} Assembly instance(s): [${defAssemblies.map(i => i.name).join(', ')}]`
  )
  if (allRows.length > 0) {
    // Log a sample of the raw row structure so field names are visible in logs
    const sample = allRows[0]
    console.log('[onshape] Sample row fields:', JSON.stringify({
      indent:     sample.indent,
      indentLevel: sample.indentLevel,
      itemSource: sample.itemSource,
      partId:     sample.partId,
      elementId:  sample.elementId,
      documentId: sample.documentId,
    }))
  }

  const directParts   = []
  const subassemblies = []

  for (const row of allRows) {
    // ── Skip rows that belong to sub-assemblies ────────────
    // indented=true puts the depth in row.indent (or row.indentLevel on some
    // versions). Any row with depth > 0 belongs to a sub-assembly and will be
    // picked up when we recursively import that sub-assembly.
    const rowIndent = row.indent ?? row.indentLevel ?? 0
    if (rowIndent > 0) continue

    const parsed = resolveRow(row, headerById)
    if (parsed.partName === 'Unknown part') continue

    // Normalise itemSource — Onshape uses ASSEMBLY, Assembly, ASSEMBLY_REFERENCE
    const src           = (row.itemSource || '').toUpperCase()
    const isAssemblyRow = src === 'ASSEMBLY' || src === 'ASSEMBLY_REFERENCE'

    if (!isAssemblyRow) {
      directParts.push(parsed)
      continue
    }

    // ── Resolve the sub-assembly's elementId ───────────────
    // Four strategies, ordered most → least reliable.
    let resolvedElementId   = null
    let resolvedDocumentId  = documentId
    let resolvedWorkspaceId = workspaceId

    if (row.elementId) {
      // S1: elementId sits directly on the BOM row
      resolvedElementId   = row.elementId
      resolvedDocumentId  = row.documentId  || documentId
      resolvedWorkspaceId = row.workspaceId || workspaceId

    } else if (row.partId && byInstanceId[row.partId]) {
      // S2: row.partId matches a definition instance id
      const inst         = byInstanceId[row.partId]
      resolvedElementId  = inst.elementId
      resolvedDocumentId = inst.documentId || documentId

    } else if (row.partId && byElementId[row.partId]) {
      // S3: row.partId IS the elementId
      const inst         = byElementId[row.partId]
      resolvedElementId  = inst.elementId
      resolvedDocumentId = inst.documentId || documentId

    } else {
      // S4: name match (fragile — last resort)
      const inst = byName[(parsed.partName || '').toLowerCase()]
      if (inst) {
        resolvedElementId  = inst.elementId
        resolvedDocumentId = inst.documentId || documentId
        console.warn(`[onshape] S4 name-match for "${parsed.partName}" → elementId ${resolvedElementId}`)
      }
    }

    if (resolvedElementId) {
      console.log(`[onshape] Subassembly "${parsed.partName}" resolved → elementId: ${resolvedElementId}`)
      subassemblies.push({
        ...parsed,
        resolvedElementId,
        resolvedDocumentId,
        resolvedWorkspaceId,
      })
    } else {
      console.warn(
        `[onshape] Cannot resolve elementId for "${parsed.partName}". ` +
        `row.partId=${row.partId}. ` +
        `Definition had: [${defAssemblies.map(i => `${i.name}→${i.id}`).join(', ')}]`
      )
      // Keep the sub-assembly as a flat part so nothing is silently lost
      directParts.push(parsed)
    }
  }

  console.log(`[onshape] Resolved: ${directParts.length} direct parts, ${subassemblies.length} subassemblies`)
  return { headers, directParts, subassemblies }
}