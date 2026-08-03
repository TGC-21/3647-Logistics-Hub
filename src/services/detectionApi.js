async function callDetectionApi(action, payload){
    const res = await fetch('/api/onshape-assembly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({action, ...payload}),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'fabrication detect failed')
    return data
}

export async function detectFabricationCandidates({ assemblyId }){
    const { skippedCount, candidateCount, detectedCount, needsReviewCount, ignoredCount, warnings, message } = await callDetectionApi('detect', { assemblyId })
    return { skippedCount, candidateCount, detectedCount, needsReviewCount, ignoredCount, warnings, message }   // { candidateCount, detectedCount, needsReviewCount, ignoredCount, warnings, message }

}