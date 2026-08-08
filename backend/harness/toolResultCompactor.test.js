import { describe, expect, it } from 'vitest'
import { compactAssistantMessage, compactToolResult } from './toolResultCompactor.js'

describe('compactToolResult', () => {
  it('removes verbose storage and integration fields while retaining actionable part data', () => {
    const result = compactToolResult({
      id: 'part1', partName: 'Spacer', quantityNeeded: 2, quantityCollected: 0,
      onshapeReference: { fullConfiguration: 'very large', documentId: 'doc1' },
      linkedInstanceIds: ['instance1'], createdAt: '2026-01-01',
      fabricationMetadata: { kind: 'spacer', status: 'queued', warnings: ['irrelevant'] },
    })

    expect(result).toEqual({
      id: 'part1', partName: 'Spacer', quantityNeeded: 2, quantityCollected: 0,
      fabricationMetadata: { kind: 'spacer', status: 'queued' },
    })
  })

  it('marks oversized lists as truncated instead of silently claiming they are complete', () => {
    const result = compactToolResult(Array.from({ length: 20 }, (_, i) => ({ id: String(i), notes: 'x'.repeat(500) })), { maxBytes: 900 })
    expect(result.truncated).toBe(true)
    expect(result.totalItems).toBe(20)
    expect(result.items.length).toBeLessThan(20)
  })
})

describe('compactAssistantMessage', () => {
  it('drops reasoning_content while retaining normal assistant content and tool calls', () => {
    expect(compactAssistantMessage({ role: 'assistant', content: '', reasoning_content: 'long private trace', tool_calls: [{ id: 'call1' }] }))
      .toEqual({ role: 'assistant', content: '', tool_calls: [{ id: 'call1' }] })
  })
})
// backend/harness/toolResultCompactor.test.js — add this block

describe('compactToolResult — join-key preservation', () => {
  it('never strips fields a caller needs to cross-reference results across tool calls', () => {
    const part = {
      id: 'part1', componentId: 'comp1', partNumber: 'PN-123', partName: 'Bearing',
      fabricationMetadata: { kind: 'spacer', status: 'queued' },
      onshapeReference: { fullConfiguration: 'huge blob' },   // fine to drop
      linkedInstanceIds: ['inst1'],                            // fine to drop
    }
    const result = compactToolResult(part)

    // These are exactly the fields matching/cross-referencing logic (and
    // AssemblyPartService.checkAvailability's own matching tiers) depend
    // on — if any of these ever get added to OMITTED_KEYS, joins silently
    // break with no visible error, which is worse than a loud one.
    expect(result.id).toBe('part1')
    expect(result.componentId).toBe('comp1')
    expect(result.partNumber).toBe('PN-123')
    expect(result.partName).toBe('Bearing')
  })
})