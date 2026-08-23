/**
 * Unit tests for the pin-slot key builder (`src/pin.ts`). The WAS rule that
 * Space, Collection, and Resource ids are URL-safe means `/` never appears
 * inside a segment, so the bare `space/${spaceId}/${collectionId}/${resourceId}`
 * key is unambiguous; the builder refuses an empty or slash-bearing segment
 * with a `TypeError`.
 */
import { describe, expect, it } from 'vitest'
import { resourceLogPinId } from '../../src/index.js'

describe('resourceLogPinId', () => {
  it('builds a plain pin id from unencoded segments', () => {
    expect(
      resourceLogPinId({ spaceId: 's', collectionId: 'c', resourceId: 'r' })
    ).toBe('space/s/c/r')
  })

  it('leaves a urn:uuid: spaceId unencoded', () => {
    expect(
      resourceLogPinId({
        spaceId: 'urn:uuid:123',
        collectionId: 'c',
        resourceId: 'r'
      })
    ).toBe('space/urn:uuid:123/c/r')
  })

  it('throws TypeError on a slash-bearing collectionId', () => {
    expect(() =>
      resourceLogPinId({ spaceId: 's', collectionId: 'a/b', resourceId: 'c' })
    ).toThrow(TypeError)
  })

  it('throws TypeError on a slash-bearing resourceId', () => {
    expect(() =>
      resourceLogPinId({ spaceId: 's', collectionId: 'a', resourceId: 'b/c' })
    ).toThrow(TypeError)
  })

  it('throws TypeError on a slash-bearing spaceId', () => {
    expect(() =>
      resourceLogPinId({ spaceId: 'a/b', collectionId: 'c', resourceId: 'r' })
    ).toThrow(TypeError)
  })

  it('throws TypeError on an empty segment', () => {
    expect(() =>
      resourceLogPinId({ spaceId: '', collectionId: 'c', resourceId: 'r' })
    ).toThrow(TypeError)
  })
})
