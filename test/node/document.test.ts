/**
 * Unit tests for the controller-document readers (`src/document.ts`): how a
 * verification relation resolves (references through `verificationMethod`,
 * embedded methods verbatim, order preserved), and the one key-multibase rule
 * a relation member is read under (the resolved method's
 * `publicKeyMultibase`; an id fragment names no key, a reference nothing
 * backs names none).
 */
import { describe, expect, it } from 'vitest'
import {
  memberKeyMultibase,
  relationIds,
  relationKeyMultibases,
  relationMemberNamed,
  relationMembers,
  resolvedRelationMethods,
  type ControllerDocument
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

  it('resolves relative references and ids against the document id', () => {
    const relative = { id: `#${KEY_A}`, publicKeyMultibase: KEY_A }
    const doc = {
      id: DID,
      verificationMethod: [relative, vm(KEY_B)],
      assertionMethod: [`${DID}#${KEY_A}`, `#${KEY_B}`]
    }
    expect(relationMembers({ doc, relation: 'assertionMethod' })).toEqual([
      { id: `${DID}#${KEY_A}`, method: relative },
      { id: `#${KEY_B}`, method: vm(KEY_B) }
    ])
  })

  it('leaves a relative reference unresolved when the document has no id', () => {
    const doc = {
      verificationMethod: [vm(KEY_A)],
      assertionMethod: [`#${KEY_A}`]
    }
    expect(relationMembers({ doc, relation: 'assertionMethod' })).toEqual([
      { id: `#${KEY_A}`, method: undefined }
    ])
  })
})

describe('relationMemberNamed', () => {
  it('finds the member the DID URL names, absolute or relative', () => {
    const relative = { id: `#${KEY_B}`, publicKeyMultibase: KEY_B }
    const doc = {
      id: DID,
      verificationMethod: [vm(KEY_A)],
      assertionMethod: [`${DID}#${KEY_A}`, relative, `${DID}#${KEY_C}`]
    }
    const named = (fragment: string) =>
      relationMemberNamed({
        doc,
        relation: 'assertionMethod',
        did: DID,
        fragment
      })
    expect(named(KEY_A)).toEqual({ id: `${DID}#${KEY_A}`, method: vm(KEY_A) })
    expect(named(KEY_B)).toEqual({ id: `#${KEY_B}`, method: relative })
    expect(named(KEY_C)).toEqual({ id: `${DID}#${KEY_C}`, method: undefined })
    expect(named('zUnknown')).toBeUndefined()
  })

  it('resolves a relative id against the URL DID when the document has none, and against the document id otherwise', () => {
    const member = { id: `#${KEY_A}`, publicKeyMultibase: KEY_A }
    expect(
      relationMemberNamed({
        doc: { assertionMethod: [member] },
        relation: 'assertionMethod',
        did: DID,
        fragment: KEY_A
      })
    ).toEqual({ id: `#${KEY_A}`, method: member })
    expect(
      relationMemberNamed({
        doc: {
          id: 'did:webvh:QmOther:example.com:x',
          assertionMethod: [member]
        },
        relation: 'assertionMethod',
        did: DID,
        fragment: KEY_A
      })
    ).toBeUndefined()
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
  it("reads the resolved method's publicKeyMultibase as the key", () => {
    expect(
      memberKeyMultibase({ id: `${DID}#${KEY_A}`, method: vm(KEY_A) })
    ).toBe(KEY_A)
    expect(
      memberKeyMultibase({
        id: undefined,
        method: { publicKeyMultibase: KEY_A }
      })
    ).toBe(KEY_A)
  })

  it('reads the published key when the id fragment names another', () => {
    expect(
      memberKeyMultibase({ id: `${DID}#${KEY_A}`, method: vm(KEY_B) })
    ).toBe(KEY_B)
  })

  it('never reads an id fragment as the key', () => {
    expect(
      memberKeyMultibase({ id: `${DID}#${KEY_A}`, method: undefined })
    ).toBeUndefined()
    expect(
      memberKeyMultibase({
        id: `${DID}#${KEY_A}`,
        method: { id: `${DID}#${KEY_A}` }
      })
    ).toBeUndefined()
  })

  it('names no key when the method publishes none', () => {
    expect(memberKeyMultibase({ id: DID, method: undefined })).toBeUndefined()
    expect(memberKeyMultibase({ id: undefined, method: {} })).toBeUndefined()
  })
})

describe('relationKeyMultibases', () => {
  it('collects the published keys and omits a reference nothing backs', () => {
    const doc: ControllerDocument = {
      verificationMethod: [vm(KEY_A), { ...vm(KEY_B), id: `${DID}#${KEY_C}` }],
      capabilityInvocation: [
        `${DID}#${KEY_A}`,
        `${DID}#${KEY_C}`,
        { publicKeyMultibase: KEY_B },
        `${DID}#z6MkUnbacked`,
        { id: `${DID}#z6MkKeyless` }
      ]
    }
    expect(
      relationKeyMultibases({ doc, relation: 'capabilityInvocation' })
    ).toEqual(new Set([KEY_A, KEY_B]))
  })
})
