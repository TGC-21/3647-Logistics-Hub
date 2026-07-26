// api/_lib/__tests__/harnessAuth.test.js

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assertHarnessToken } from '../harnessAuth.js'
import { UnauthorizedError } from '../../../repositories/errors.js'

const ORIGINAL_TOKEN = process.env.HARNESS_API_TOKEN

describe('assertHarnessToken', () => {
  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.HARNESS_API_TOKEN
    else process.env.HARNESS_API_TOKEN = ORIGINAL_TOKEN
  })

  it('fails closed when HARNESS_API_TOKEN is not configured', () => {
    delete process.env.HARNESS_API_TOKEN
    expect(() => assertHarnessToken({ headers: {} })).toThrow(UnauthorizedError)
  })

  it('rejects a missing header', () => {
    process.env.HARNESS_API_TOKEN = 'secret123'
    expect(() => assertHarnessToken({ headers: {} })).toThrow(UnauthorizedError)
  })

  it('rejects a wrong token', () => {
    process.env.HARNESS_API_TOKEN = 'secret123'
    expect(() => assertHarnessToken({ headers: { 'x-harness-token': 'nope' } })).toThrow(UnauthorizedError)
  })

  it('passes with the correct token', () => {
    process.env.HARNESS_API_TOKEN = 'secret123'
    expect(() => assertHarnessToken({ headers: { 'x-harness-token': 'secret123' } })).not.toThrow()
  })
})