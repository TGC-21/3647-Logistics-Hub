async function callAssembliesApi(action, payload = {}){
    const res = await fetch('/api/assemblies-v2', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action, ...payload}),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'assembly task request failed')
    return data
}

export async function createAssembly({ name, description, onshapeUrl, status, actorId = null }){
    const { assembly } = await callAssembliesApi('create', {name, description, onshapeUrl, status, actorId})
    return assembly
}

export async function updateAssembly({ assemblyId, name, description, onshapeUrl, status, actorId = null }){
    const { assembly } = await callAssembliesApi('update', {assemblyId, name, description, onshapeUrl, status, actorId})
    return assembly
}

export async function deleteAssembly({ assemblyId, actorId = null }){
    const { result } = await callAssembliesApi('delete', { assemblyId, actorId })
    return result
}