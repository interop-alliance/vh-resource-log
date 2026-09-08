/**
 * Unit tests for the pin-slot key builders (`src/pin.ts`). The WAS rule that
 * Space, Collection, and Resource ids are URL-safe means `/` never appears
 * inside a segment, so the bare `space/${spaceId}/${collectionId}/${resourceId}`
 * key is unambiguous; the builders refuse an empty or slash-bearing segment
 * with a `TypeError`. `collectionLogPinId` names a Collection's governing
 * history log at its reserved `meta/log` sub-resource, under the same checks.
 */
import { describe, expect, it } from 'vitest'
import { collectionLogPinId, resourceLogPinId } from '../../src/index.js'

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

  it('throws TypeError on a slash-bearing resourceId', () => {
    expect(() =>
      resourceLogPinId({ spaceId: 's', collectionId: 'a', resourceId: 'b/c' })
    ).toThrow(/^resourceId must be a non-empty id/)
  })
})

describe('collectionLogPinId', () => {
  it('builds the meta/log slot key for a collection', () => {
    expect(
      collectionLogPinId({ spaceId: 'space-1', collectionId: 'coll-1' })
    ).toBe('space/space-1/coll-1/meta/log')
  })
})

describe.each([
  [
    'resourceLogPinId',
    (ids: { spaceId: string; collectionId: string }) =>
      resourceLogPinId({ ...ids, resourceId: 'r' })
  ],
  ['collectionLogPinId', collectionLogPinId]
])('%s shared segment guard', (_name, build) => {
  it('throws TypeError on a slash-bearing spaceId', () => {
    expect(() => build({ spaceId: 'a/b', collectionId: 'c' })).toThrow(
      TypeError
    )
  })

  it('throws TypeError on a slash-bearing collectionId', () => {
    expect(() => build({ spaceId: 's', collectionId: 'a/b' })).toThrow(
      TypeError
    )
  })

  it('names the offending segment without a builder name', () => {
    expect(() => build({ spaceId: 's', collectionId: '' })).toThrow(
      /^collectionId must be a non-empty id without "\/"/
    )
  })
})
