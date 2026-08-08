import { describe, expect, it } from 'vitest'
import { buildContextWindow } from './contextWindow.js'

const toolCall = id => ({ role: 'assistant', content: '', tool_calls: [{ id, function: { name: 'read_tool', arguments: '{}' } }] })
const toolResult = id => ({ role: 'tool', tool_call_id: id, content: JSON.stringify({ rows: 'x'.repeat(350) }) })

describe('buildContextWindow', () => {
  it('keeps the latest request and complete recent tool-call/result pairs', () => {
    const messages = [
      { role: 'user', content: 'old request' }, toolCall('old'), toolResult('old'),
      { role: 'user', content: 'current request' }, toolCall('new'), toolResult('new'),
    ]
    const result = buildContextWindow(messages, { maxHistoryBytes: 700 })

    expect(result.trimmed).toBe(true)
    expect(result.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(result.messages[2].content).toBe('current request')
    expect(result.messages[3].tool_calls[0].id).toBe('new')
    expect(result.messages[4].tool_call_id).toBe('new')
  })

  it('does not add a summary when all active context fits', () => {
    const result = buildContextWindow([{ role: 'user', content: 'hello' }, toolCall('a'), toolResult('a')], { maxHistoryBytes: 2_000 })
    expect(result.trimmed).toBe(false)
    expect(result.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool'])
  })

  it('always includes the assembly retrieval guardrail in the system prompt', () => {
    const result = buildContextWindow([{ role: 'user', content: 'Check the Intake parts' }])
    expect(result.messages[0].content).toContain('AssemblyPartService.listTreeForAssembly')
    expect(result.messages[0].content).toContain('OnshapeLookupService.previewAssembly')
  })
})
