/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, expect, it } from 'vitest'
import {
  isResourceLogRefusal,
  LogNotConfirmedError,
  ResourceLogClosedError,
  ResourceLogConflictError,
  ResourceLogContinuityError,
  ResourceLogIntegrityError
} from '../../src/index.js'

describe('isResourceLogRefusal', () => {
  it('refuses a fabricated log', () => {
    expect(isResourceLogRefusal(new ResourceLogIntegrityError('bad'))).toBe(
      true
    )
  })

  it('refuses every continuity reason but rollback', () => {
    for (const reason of ['fork', 'scid-switch', 'method-switch'] as const) {
      expect(
        isResourceLogRefusal(
          new ResourceLogContinuityError({ reason, pinnedHead: '3-abc' })
        )
      ).toBe(true)
    }
    expect(
      isResourceLogRefusal(
        new ResourceLogContinuityError({
          reason: 'rollback',
          pinnedHead: '3-abc'
        })
      )
    ).toBe(false)
  })

  it('matches by name, not by constructor', () => {
    expect(isResourceLogRefusal({ name: 'ResourceLogIntegrityError' })).toBe(
      true
    )
    expect(
      isResourceLogRefusal({
        name: 'ResourceLogContinuityError',
        reason: 'fork'
      })
    ).toBe(true)
    expect(
      isResourceLogRefusal({
        name: 'ResourceLogContinuityError',
        reason: 'rollback'
      })
    ).toBe(false)
  })

  it('leaves the other classes, a license refusal, and non-errors alone', () => {
    expect(
      isResourceLogRefusal(
        new ResourceLogClosedError({ nextLog: { method: 'm', scid: 's' } })
      )
    ).toBe(false)
    expect(isResourceLogRefusal(new LogNotConfirmedError('x'))).toBe(false)
    expect(isResourceLogRefusal(new ResourceLogConflictError('x'))).toBe(false)
    expect(isResourceLogRefusal({ name: 'ResourceLogLicenseError' })).toBe(
      false
    )
    expect(isResourceLogRefusal(new Error('x'))).toBe(false)
    expect(isResourceLogRefusal(null)).toBe(false)
    expect(isResourceLogRefusal(undefined)).toBe(false)
  })
})
