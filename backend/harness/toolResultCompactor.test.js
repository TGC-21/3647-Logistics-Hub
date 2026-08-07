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
