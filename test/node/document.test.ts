/**
 * Unit tests for the controller-document readers (`src/document.ts`): how a
 * verification relation resolves (references through `verificationMethod`,
 * embedded methods verbatim, order preserved), and the one key-multibase rule
 * a relation member is read under (fragment and `publicKeyMultibase` agree,
 * either alone is the key, a disagreement names no key).
 */
import { describe, expect, it } from 'vitest'
import {
  memberKeyMultibase,
  relationIds,
  relationKeyMultibases,
  relationMembers,
  resolvedRelationMethods
} from '../../src/index.js'

const DID = 'did:webvh:QmScid:storage.example:space:s:id'
const KEY_A = 'z6MkAlphaAlphaAlphaAlphaAlphaAlphaAlphaAlphaAlpha1'
const KEY_B = 'z6MkBravoBravoBravoBravoBravoBravoBravoBravoBravo2'
const KEY_C = 'z6MkCharlieCharlieCharlieCharlieCharlieCharlie3'

const vm = (key: string) => ({
  id: `${DID}#${key}`,
  type: 'Multikey',
  controller: DID,
  publicKeyMultibase: key
})

describe('relationIds', () => {
  it('reads string references and embedded ids, skipping an id-less member', () => {
    expect(relationIds([`${DID}#${KEY_A}`, vm(KEY_B), {}])).toEqual([
      `${DID}#${KEY_A}`,
      `${DID}#${KEY_B}`
    ])
    expect(relationIds(undefined)).toEqual([])
  })
})

describe('relationMembers', () => {
  it('pairs each member with the method it resolves to, in document order', () => {
    const doc = {
      verificationMethod: [vm(KEY_A)],
      assertionMethod: [`${DID}#${KEY_A}`, vm(KEY_B), `${DID}#${KEY_C}`]
    }
    expect(relationMembers({ doc, relation: 'assertionMethod' })).toEqual([
      { id: `${DID}#${KEY_A}`, method: vm(KEY_A) },
      { id: `${DID}#${KEY_B}`, method: vm(KEY_B) },
      { id: `${DID}#${KEY_C}`, method: undefined }
    ])
  })

  it('keeps an id-less embedded method as a member with no id', () => {
    const doc = { keyAgreement: [{ publicKeyMultibase: KEY_A }] }
    expect(relationMembers({ doc, relation: 'keyAgreement' })).toEqual([
      { id: undefined, method: { publicKeyMultibase: KEY_A } }
    ])
  })

  it('reads an absent relation as no members', () => {
    expect(relationMembers({ doc: {}, relation: 'authentication' })).toEqual([])
  })
})

describe('resolvedRelationMethods', () => {
  it('drops a reference nothing backs and takes embedded methods verbatim', () => {
    const doc = {
      verificationMethod: [vm(KEY_A)],
      capabilityDelegation: [`${DID}#${KEY_A}`, `${DID}#${KEY_C}`, vm(KEY_B)]
    }
    expect(
      resolvedRelationMethods({ doc, relation: 'capabilityDelegation' })
    ).toEqual([vm(KEY_A), vm(KEY_B)])
  })

  it('resolves every relation of one document through one index', () => {
    const doc = {
      verificationMethod: [vm(KEY_A), vm(KEY_B)],
      capabilityInvocation: [`${DID}#${KEY_A}`],
      capabilityDelegation: [`${DID}#${KEY_A}`, `${DID}#${KEY_B}`]
    }
    expect(
      resolvedRelationMethods({ doc, relation: 'capabilityInvocation' })
    ).toEqual([vm(KEY_A)])
    expect(
      resolvedRelationMethods({ doc, relation: 'capabilityDelegation' })
    ).toEqual([vm(KEY_A), vm(KEY_B)])
  })
})

describe('memberKeyMultibase', () => {
  it('reads an agreeing fragment and publicKeyMultibase as the key', () => {
    expect(
      memberKeyMultibase({ id: `${DID}#${KEY_A}`, method: vm(KEY_A) })
    ).toBe(KEY_A)
  })

  it('reads a fragment alone as the key', () => {
    expect(
      memberKeyMultibase({ id: `${DID}#${KEY_A}`, method: undefined })
    ).toBe(KEY_A)
    expect(
      memberKeyMultibase({
        id: `${DID}#${KEY_A}`,
        method: { id: `${DID}#${KEY_A}` }
      })
    ).toBe(KEY_A)
  })

  it('reads a publicKeyMultibase alone as the key', () => {
    expect(
      memberKeyMultibase({
        id: undefined,
        method: { publicKeyMultibase: KEY_A }
      })
    ).toBe(KEY_A)
    expect(
      memberKeyMultibase({ id: DID, method: { publicKeyMultibase: KEY_A } })
    ).toBe(KEY_A)
  })

  it('names no key when the two readings disagree', () => {
    expect(
      memberKeyMultibase({ id: `${DID}#${KEY_A}`, method: vm(KEY_B) })
    ).toBeUndefined()
  })

  it('names no key when neither reading is present', () => {
    expect(memberKeyMultibase({ id: DID, method: undefined })).toBeUndefined()
    expect(memberKeyMultibase({ id: undefined, method: {} })).toBeUndefined()
  })
})

describe('relationKeyMultibases', () => {
  it('collects the keys of agreeing, fragment-only, and multibase-only members and skips a mismatch', () => {
    const doc = {
      verificationMethod: [vm(KEY_A), { ...vm(KEY_B), id: `${DID}#${KEY_C}` }],
      capabilityInvocation: [
        `${DID}#${KEY_A}`,
        `${DID}#${KEY_C}`,
        { publicKeyMultibase: KEY_B },
        `${DID}#z6MkUnbacked`
      ]
    }
    expect(
      relationKeyMultibases({ doc, relation: 'capabilityInvocation' })
    ).toEqual(new Set([KEY_A, KEY_B, 'z6MkUnbacked']))
  })
})
