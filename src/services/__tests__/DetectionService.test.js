// services/__tests__/DetectionService.test.js
//
// Same convention as the rest of this pass: plain fake repositories,
// no Supabase. The real detectors (spacer/axial-shaft/plate) and the
// bodydetails fetch are exercised via lightweight fakes injected at the
// module level below, since DetectionService imports DETECTORS and the
// bodydetails helpers directly rather than taking them as constructor
// args (they're pure algorithm/gateway modules, not repositories — same
// reasoning OnshapeImportService already applies to api/_lib/onshape.js).
// vi.mock intercepts those two imports so this file can control exactly
// what "geometry" and "detector" behavior each test exercises without
// needing a real Onshape response or real B-rep math.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchBodyDetails = vi.fn()
const mockFindBodyByPartId = vi.fn()
vi.mock('../../api/_lib/onshape-bodydetails.js', () => ({
  fetchBodyDetails: (...args) => mockFetchBodyDetails(...args),
  findBodyByPartId: (...args) => mockFindBodyByPartId(...args),
  bodyDetailsCacheKey: (documentId, wvmType, wvmId, elementId, fullConfiguration) =>
    `${documentId}::${wvmType}::${wvmId}::${elementId}::${fullConfiguration || ''}`,
}))

function makeDetector(kind, { candidateNames = [], classify = () => ({ status: 'detected', confidence: 'high', warnings: [], extra: {} }) } = {}) {
  return {
    kind,
    generatorId: null,
    candidateFilter: row => candidateNames.some(n => (row.partName || '').toLowerCase().includes(n)),
    isFromRootDocument: (row, rootDocumentId) => row.raw?.documentId === rootDocumentId,
    classifyGeometry: classify,
  }
}

let spacerDetector, plateDetector
vi.mock('../../api/_lib/fabrication-detectors.js', () => ({
  get DETECTORS() { return [spacerDetector, plateDetector] },
  candidateRowsForDetector: (detector, rows, rootDocumentId) =>
    rows.filter(row => detector.candidateFilter(row) && detector.isFromRootDocument(row, rootDocumentId)),
}))

import { DetectionService } from '../DetectionService.js'

function makeFakeRepos(overrides = {}) {
  const assemblyRepo = {
    findById: vi.fn(async () => ({ id: 'asm1', onshapeDocumentId: 'doc1' })),
    ...overrides.assemblyRepo,
  }
  const assemblyPartRepo = {
    findTreeForAssembly: vi.fn(async () => []),
    updateFabricationMetadata: vi.fn(async () => {}),
    ...overrides.assemblyPartRepo,
  }
  return { assemblyRepo, assemblyPartRepo }
}

beforeEach(() => {
  mockFetchBodyDetails.mockReset()
  mockFindBodyByPartId.mockReset()
  spacerDetector = makeDetector('spacer', { candidateNames: ['spacer'] })
  plateDetector  = makeDetector('plate',  { candidateNames: ['plate', 'spacer'] })   // deliberately overlapping, to exercise claim priority
})

describe('DetectionService.detectFabricationCandidates', () => {
  it('rejects an assembly with no linked Onshape document', async () => {
    const repos = makeFakeRepos({ assemblyRepo: { findById: vi.fn(async () => ({ id: 'asm1', onshapeDocumentId: '' })) } })
    const service = new DetectionService(repos)
    await expect(service.detectFabricationCandidates({ assemblyId: 'asm1' })).rejects.toThrow('not linked to Onshape')
  })

  it('skips rows already in a terminal fabrication_metadata status', async () => {
    const repos = makeFakeRepos({
      assemblyPartRepo: {
        findTreeForAssembly: vi.fn(async () => [
          { id: 'p1', partName: 'Spacer A', onshapeReference: { documentId: 'doc1', partId: 'pid1' }, fabricationMetadata: { status: 'queued' } },
        ]),
        updateFabricationMetadata: vi.fn(async () => {}),
      },
    })
    const service = new DetectionService(repos)

    const result = await service.detectFabricationCandidates({ assemblyId: 'asm1' })

    expect(result.skippedCount).toBe(1)
    expect(result.candidateCount).toBe(0)
    expect(repos.assemblyPartRepo.updateFabricationMetadata).not.toHaveBeenCalled()
  })

  it('marks a candidate from an outside document as ignored without an Onshape fetch', async () => {
    const repos = makeFakeRepos({
      assemblyPartRepo: {
        findTreeForAssembly: vi.fn(async () => [
          { id: 'p1', partName: 'Spacer A', onshapeReference: { documentId: 'other-doc', partId: 'pid1' }, fabricationMetadata: {} },
        ]),
        updateFabricationMetadata: vi.fn(async () => {}),
      },
    })
    const service = new DetectionService(repos)

    await service.detectFabricationCandidates({ assemblyId: 'asm1' })

    expect(repos.assemblyPartRepo.updateFabricationMetadata).toHaveBeenCalledWith('p1', expect.objectContaining({ status: 'ignored' }))
    expect(mockFetchBodyDetails).not.toHaveBeenCalled()
  })

  it('fetches bodydetails once per Part Studio for multiple candidates in the same studio', async () => {
    const repos = makeFakeRepos({
      assemblyPartRepo: {
        findTreeForAssembly: vi.fn(async () => [
          { id: 'p1', partName: 'Spacer A', onshapeReference: { documentId: 'doc1', wvmType: 'w', wvmId: 'ws1', elementId: 'el1', partId: 'pid1' }, fabricationMetadata: {} },
          { id: 'p2', partName: 'Spacer B', onshapeReference: { documentId: 'doc1', wvmType: 'w', wvmId: 'ws1', elementId: 'el1', partId: 'pid2' }, fabricationMetadata: {} },
        ]),
        updateFabricationMetadata: vi.fn(async () => {}),
      },
    })
    mockFetchBodyDetails.mockResolvedValue({ bodies: [{ id: 'pid1' }, { id: 'pid2' }] })
    mockFindBodyByPartId.mockImplementation((resp, partId) => resp.bodies.find(b => b.id === partId))

    const service = new DetectionService(repos)
    const result = await service.detectFabricationCandidates({ assemblyId: 'asm1' })

    expect(mockFetchBodyDetails).toHaveBeenCalledTimes(1)
    expect(result.detectedCount).toBe(2)
  })

  it('claim priority: a row spacer already detected never reaches plate classification', async () => {
    const repos = makeFakeRepos({
      assemblyPartRepo: {
        findTreeForAssembly: vi.fn(async () => [
          { id: 'p1', partName: 'Spacer Plate', onshapeReference: { documentId: 'doc1', wvmType: 'w', wvmId: 'ws1', elementId: 'el1', partId: 'pid1' }, fabricationMetadata: {} },
        ]),
        updateFabricationMetadata: vi.fn(async () => {}),
      },
    })
    mockFetchBodyDetails.mockResolvedValue({ bodies: [{ id: 'pid1' }] })
    mockFindBodyByPartId.mockImplementation((resp, partId) => resp.bodies.find(b => b.id === partId))
    const plateClassify = vi.fn(() => ({ status: 'detected', confidence: 'high', warnings: [], extra: {} }))
    plateDetector.classifyGeometry = plateClassify

    const service = new DetectionService(repos)
    await service.detectFabricationCandidates({ assemblyId: 'asm1' })

    expect(plateClassify).not.toHaveBeenCalled()
    expect(repos.assemblyPartRepo.updateFabricationMetadata).toHaveBeenCalledWith('p1', expect.objectContaining({ kind: 'spacer', status: 'detected' }))
  })

  it('downgrades a plate candidate to needs_review when postGeometryCheck excludes it', async () => {
    plateDetector.candidateFilter = row => (row.partName || '').toLowerCase().includes('plate')
    plateDetector.postGeometryCheck = vi.fn(async () => false)
    const repos = makeFakeRepos({
      assemblyPartRepo: {
        findTreeForAssembly: vi.fn(async () => [
          { id: 'p1', partName: 'Cover Plate', onshapeReference: { documentId: 'doc1', wvmType: 'w', wvmId: 'ws1', elementId: 'el1', partId: 'pid1' }, fabricationMetadata: {} },
        ]),
        updateFabricationMetadata: vi.fn(async () => {}),
      },
    })
    mockFetchBodyDetails.mockResolvedValue({ bodies: [{ id: 'pid1' }] })
    mockFindBodyByPartId.mockImplementation((resp, partId) => resp.bodies.find(b => b.id === partId))

    const service = new DetectionService(repos)
    const result = await service.detectFabricationCandidates({ assemblyId: 'asm1' })

    expect(result.needsReviewCount).toBe(1)
    expect(repos.assemblyPartRepo.updateFabricationMetadata).toHaveBeenCalledWith('p1', expect.objectContaining({ status: 'needs_review' }))
  })
})
