import { describe, expect, it } from 'vitest'
import { selectToolActions } from './toolSelection.js'

describe('selectToolActions', () => {
  it('limits an inventory request to the live inventory tool family', () => {
    const selected = selectToolActions([{ role: 'user', content: 'How many bolts are in inventory?' }])
    expect(selected).toContain('InventoryInstanceService.listAll')
    expect(selected).toContain('ComponentService.search')
    expect(selected).not.toContain('AgendaService.listTasks')
  })

  it('keeps the full registry for an ambiguous request', () => {
    const selected = selectToolActions([{ role: 'user', content: 'What should I know?' }])
    expect(selected).toContain('InventoryInstanceService.listAll')
  })
})
