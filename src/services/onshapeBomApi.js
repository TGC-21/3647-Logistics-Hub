async function callOnshapeBomApi(action, payload={}){
  const res = await fetch('/api/onshape-bom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'onshape BOM request failed')
  return data

}

export async function importAssembly({documentId, workspaceId, elementId, name, thumbnailUrl, actorId }){
    // Route responds with { success, assemblyId, partCount, childCount,
    // onshapeUrl, assembly, message }. Return everything but `success` —
    // confirmLinkAssembly() reads data.assemblyId/partCount/childCount,
    // not just the bare `assembly` row.
    const { success, ...result } = await callOnshapeBomApi('import', { documentId, workspaceId, elementId, name, thumbnailUrl, actorId})
    return result
}

export async function reimportAssembly({ assemblyId, actorId }){
    // Route responds with { success, assemblyId, partCount, childCount,
    // relinkedInventoryCount, ..., message } — there is no `assembly`
    // key on a reimport response (OnshapeReimportService.reimportAssembly
    // never returns one), so destructuring `{ assembly }` here always
    // resolved to undefined and confirmReimport()'s `result.message`
    // read crashed with "cannot read properties of undefined". Return
    // the whole result instead.
    const { success, ...result } = await callOnshapeBomApi('reimport', { assemblyId, actorId})
    return result
}