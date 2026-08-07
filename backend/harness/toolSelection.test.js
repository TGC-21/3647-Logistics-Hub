import { describe, expect, it } from 'vitest'
import { selectToolActions } from './toolSelection.js'

describe('selectToolActions', () => {
  it('limits a fabrication request to the fabrication/assembly tool family', () => {
    const selected = selectToolActions([{ role: 'user', content: 'Find fabrication jobs involving spacers' }])
    expect(selected).toContain('FabricationJobService.findJobs')
    expect(selected).toContain('AssemblyPartService.search')
    expect(selected).not.toContain('AgendaService.listTasks')
  })

  it('keeps the full registry for an ambiguous request', () => {
    const selected = selectToolActions([{ role: 'user', content: 'What should I know?' }])
    expect(selected).toContain('AgendaService.listTasks')
    expect(selected).toContain('FabricationJobService.findJobs')
  })
})
