/**
 * Unit tests for the shared verification-method fragment reader
 * (`src/vmFragment.ts`). The helper is the one place the former four
 * spellings of "multibase = fragment after #" agree, so these pin the
 * decided semantics -- last `#` wins, absent or empty fragment is
 * `undefined`.
 */
import { describe, expect, it } from 'vitest'
import {
  buildVersionedVm,
  parseVersionedVm,
  vmFragmentOf
} from '../../src/index.js'

const multibase = 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'

describe('vmFragmentOf', () => {
  it('reads the fragment of a `${did}#${multibase}` id', () => {
    expect(vmFragmentOf(`did:key:${multibase}#${multibase}`)).toBe(multibase)
    expect(
      vmFragmentOf(`did:webvh:scid:example.com:space:abc:id#${multibase}`)
    ).toBe(multibase)
  })

  it('reads the fragment of a DID URL carrying query parameters', () => {
    expect(
      vmFragmentOf(`did:webvh:scid:example.com?versionId=3#${multibase}`)
    ).toBe(multibase)
  })

  it('resolves an id with no `#` to undefined', () => {
    expect(vmFragmentOf(multibase)).toBeUndefined()
    expect(vmFragmentOf('did:key:z6Mkabc')).toBeUndefined()
  })

  it('resolves a trailing `#` (empty fragment) to undefined', () => {
    expect(vmFragmentOf('did:key:z6Mkabc#')).toBeUndefined()
  })

  it('resolves an empty id to undefined', () => {
    expect(vmFragmentOf('')).toBeUndefined()
  })

  it('takes the LAST segment of a degenerate double-`#` id', () => {
    expect(vmFragmentOf(`did:example:1#first#${multibase}`)).toBe(multibase)
  })
})

describe('buildVersionedVm / parseVersionedVm', () => {
  const did = 'did:webvh:QmScid:example.com:space:abc:id'

  it('round-trips a versioned verification method', () => {
    const parsed = {
      did,
      controllerVersionId: '3-zHash',
      keyMultibase: multibase
    }
    expect(parseVersionedVm(buildVersionedVm(parsed))).toEqual(parsed)
    expect(buildVersionedVm(parsed)).toBe(
      `${did}?versionId=3-zHash#${multibase}`
    )
  })

  it('round-trips an unversioned verification method', () => {
    const parsed = { did, keyMultibase: multibase }
    expect(parseVersionedVm(buildVersionedVm(parsed))).toEqual(parsed)
    expect(buildVersionedVm(parsed)).toBe(`${did}#${multibase}`)
  })

  it('refuses a URL with no key fragment or an empty DID', () => {
    expect(parseVersionedVm(did)).toBeUndefined()
    expect(parseVersionedVm(`${did}?versionId=3-zHash#`)).toBeUndefined()
    expect(parseVersionedVm(`#${multibase}`)).toBeUndefined()
    expect(parseVersionedVm(`?versionId=3-zHash#${multibase}`)).toBeUndefined()
  })

  it('refuses a query that is not exactly one versionId parameter', () => {
    expect(parseVersionedVm(`${did}?#${multibase}`)).toBeUndefined()
    expect(parseVersionedVm(`${did}?versionId=#${multibase}`)).toBeUndefined()
    expect(parseVersionedVm(`${did}?other=1#${multibase}`)).toBeUndefined()
    expect(
      parseVersionedVm(`${did}?versionId=3-zHash&other=1#${multibase}`)
    ).toBeUndefined()
    expect(
      parseVersionedVm(`${did}?other=1&versionId=3-zHash#${multibase}`)
    ).toBeUndefined()
    expect(
      parseVersionedVm(`${did}?versionId=3%2DzHash#${multibase}`)
    ).toBeUndefined()
  })
})
