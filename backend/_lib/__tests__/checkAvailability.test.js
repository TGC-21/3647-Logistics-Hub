describe('AssemblyPartService.checkAvailability', () => {
  it('reports gap = 0 when linked inventory covers the remaining need', async () => {
    const repos = makeFakeRepos({
      partRepo: {
        findTreeForAssembly: vi.fn(async () => [
          { id: 'p1', partName: 'Bearing', partNumber: '', quantityNeeded: 4, quantityCollected: 1, componentId: 'c1' },
        ]),
      },
      instanceRepo: { countsByComponentIds: vi.fn(async () => ({ c1: { total: 5, available: 5 } })) },
    })
    const service = new AssemblyPartService(repos)
    const result = await service.checkAvailability({ assemblyId: 'asm1' })
    expect(result.rows[0].gap).toBe(0)
    expect(result.toPurchase).toEqual([])
  })

  it('falls back to a name-based guess when nothing is linked', async () => {
    const repos = makeFakeRepos({
      partRepo: { findTreeForAssembly: vi.fn(async () => [
        { id: 'p1', partName: '18T Spur Gear', partNumber: '', quantityNeeded: 2, quantityCollected: 0, componentId: null },
      ]) },
      componentRepo: { search: vi.fn(async () => [{ id: 'c9', fallbackName: '18T Spur Gear' }]) },
      instanceRepo: { countsByComponentIds: vi.fn(async () => ({ c9: { total: 1, available: 1 } })) },
    })
    const service = new AssemblyPartService(repos)
    const result = await service.checkAvailability({ assemblyId: 'asm1' })
    expect(result.rows[0].matchConfidence).toBe('guessed')
    expect(result.rows[0].gap).toBe(1)
  })
})