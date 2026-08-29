const progress = new Map()
export function beginTurnProgress(id) { progress.set(id, { phase: 'thinking', updatedAt: Date.now() }) }
export function updateTurnProgress(id, phase) { if (id && progress.has(id)) progress.set(id, { phase, updatedAt: Date.now() }) }
export function getTurnProgress(id) { return progress.get(id) || null }
export function endTurnProgress(id) { progress.delete(id) }
