import { describe, it, expect } from 'vitest'
import { ACTION_SEVERITY } from '../harnessPolicy.js'
import { HARNESS_TOOLS } from '../harnessTools.js'
import { CategoryService } from '../../../src/services/CategoryService.js'
import { ComponentService } from '../../../src/services/ComponentService.js'
import { InventoryInstanceService } from '../../../src/services/InventoryInstanceService.js'

const SERVICES = { CategoryService, ComponentService, InventoryInstanceService }

describe('harness tool coverage', () => {
  it('registers every harness action in the live service registry', () => {
    const invalid = Object.keys(ACTION_SEVERITY).filter(action => {
      const [service, method] = action.split('.')
      return !SERVICES[service] || typeof SERVICES[service].prototype[method] !== 'function'
    })
    expect(invalid).toEqual([])
  })

  it('keeps policy, tool schemas, and live inventory scope aligned', () => {
    expect(HARNESS_TOOLS.map(tool => tool.actionName).sort()).toEqual(Object.keys(ACTION_SEVERITY).sort())
  })
})
