/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The controller-document reading conventions every consumer of this stack
 * shares: how a verification relation resolves (string references into
 * `verificationMethod`, embedded methods verbatim), and which key multibase a
 * relation member names. Both are generic DID-document rules with no profile
 * or wallet semantics, and both used to be re-implemented per consumer, where
 * two readings of one document could disagree on a malformed member. They
 * live here, dependency-free, beside the fragment reader in `vmFragment.ts`
 * for the same reason that reader does: this library is the lowest layer the
 * consuming wallet and storage packages all import.
 *
 * Deciding which methods belong to whom (an enrolled client, a standing
 * credential's ladder) is each consumer's own rule over the members these
 * readers return. Nothing here filters.
 */
import { vmFragmentOf } from './vmFragment.js'

/**
 * The least a verification method carries for these readers: its id, and the
 * key itself when the method publishes one. A consumer's richer method type
 * extends this and flows through the generic readers unchanged.
 */
export interface VerificationMethodShape {
  id?: string
  publicKeyMultibase?: string
}

/**
 * The verification relations a controller document may publish.
 */
export type VerificationRelation =
  | 'authentication'
  | 'assertionMethod'
  | 'keyAgreement'
  | 'capabilityInvocation'
  | 'capabilityDelegation'

/**
 * A locally verified controller document, read for the verification
 * relations it publishes and the methods they resolve to. Structural on
 * purpose: a resolved `DIDDoc` satisfies it, and so does any narrower
 * document shape a consumer already holds. The method type is a parameter so
 * a consumer reads its own method members back without a cast.
 */
export interface ControllerDocument<
  M extends VerificationMethodShape = VerificationMethodShape
> {
  verificationMethod?: M[]
  authentication?: Array<string | M>
  assertionMethod?: Array<string | M>
  keyAgreement?: Array<string | M>
  capabilityInvocation?: Array<string | M>
  capabilityDelegation?: Array<string | M>
}

/**
 * One member of a verification relation as the document states it: the
 * verification-method id it names (the string reference itself, or the
 * embedded method's own `id`), and the method it resolves to (the
 * `verificationMethod` entry a reference names, the embedded method itself),
 * `undefined` for a reference nothing backs.
 */
export interface RelationMember<
  M extends VerificationMethodShape = VerificationMethodShape
> {
  id: string | undefined
  method: M | undefined
}

/**
 * The relationship references of a resolved document as verification-method
 * ids, tolerating embedded objects beside string references. An embedded
 * method carrying no id contributes nothing.
 *
 * @param relation {Array}   the relationship array, when present
 * @returns {string[]}
 */
export function relationIds(
  relation: Array<string | { id?: string }> | undefined
): string[] {
  const ids: string[] = []
  for (const entry of relation ?? []) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (id) {
      ids.push(id)
    }
  }
  return ids
}

/**
 * The per-document `verificationMethod` index the relation readers resolve
 * string references through, memoized on the array itself. A verified
 * document is read many times over (a controller adapter resolves several
 * relations per log entry, and every ceremony re-reads the head), and no
 * reader mutates a `verificationMethod` array in place: a rebuilt document
 * carries a fresh array, so it keys a fresh index.
 *
 * @param doc {ControllerDocument}
 * @returns {Map<string, VerificationMethodShape>}
 */
function verificationMethodIndex<M extends VerificationMethodShape>(
  doc: ControllerDocument<M>
): Map<string, M> {
  const methods = doc.verificationMethod
  if (methods === undefined) {
    return new Map()
  }
  let byId = verificationMethodIndexes.get(methods) as
    Map<string, M> | undefined
  if (byId === undefined) {
    byId = new Map()
    for (const method of methods) {
      if (typeof method?.id === 'string') {
        byId.set(method.id, method)
      }
    }
    verificationMethodIndexes.set(methods, byId)
  }
  return byId
}

const verificationMethodIndexes = new WeakMap<
  VerificationMethodShape[],
  Map<string, VerificationMethodShape>
>()

/**
 * The members one relation publishes, each as the id it names and the method
 * it resolves to ({@link RelationMember}). Document order is preserved, and
 * nothing is dropped: a reference nothing backs is a member with an id and no
 * method, and an id-less embedded method is a member with a method and no id,
 * so a consumer that needs either reading of a malformed member still sees it.
 *
 * @param options {object}
 * @param options.doc {ControllerDocument}   a locally verified document
 * @param options.relation {VerificationRelation}   the relation to read
 * @returns {RelationMember[]}
 */
export function relationMembers<M extends VerificationMethodShape>({
  doc,
  relation
}: {
  doc: ControllerDocument<M>
  relation: VerificationRelation
}): Array<RelationMember<M>> {
  const byId = verificationMethodIndex(doc)
  const members: Array<RelationMember<M>> = []
  for (const entry of doc[relation] ?? []) {
    if (typeof entry === 'string') {
      members.push({ id: entry, method: byId.get(entry) })
    } else if (entry) {
      members.push({ id: entry.id, method: entry })
    }
  }
  return members
}

/**
 * The verification methods one relation publishes, materialized: string
 * references resolved against `verificationMethod` (a reference nothing backs
 * is dropped), embedded methods taken verbatim. Document order is preserved,
 * and nothing is filtered: deciding which of these methods belongs to whom is
 * each caller's own rule.
 *
 * @param options {object}
 * @param options.doc {ControllerDocument}   a locally verified document
 * @param options.relation {VerificationRelation}   the relation to resolve
 * @returns {VerificationMethodShape[]}
 */
export function resolvedRelationMethods<M extends VerificationMethodShape>({
  doc,
  relation
}: {
  doc: ControllerDocument<M>
  relation: VerificationRelation
}): M[] {
  const methods: M[] = []
  for (const { method } of relationMembers({ doc, relation })) {
    if (method) {
      methods.push(method)
    }
  }
  return methods
}

/**
 * The key multibase one relation member names, under the one rule every
 * reader of this stack applies. Every verification-method id this stack mints
 * is `${did}#${multibase}`, so a member names its key twice: by the fragment
 * of its id, and by the `publicKeyMultibase` of the method it resolves to.
 * When both are present they must agree, and a member whose two readings
 * disagree names no key: the document is malformed there, and a reader that
 * picked one would attribute a key the other reading denies. When only one is
 * present it is the key (a reference nothing backs names its key by fragment
 * alone, an id-less embedded method by its `publicKeyMultibase` alone). A
 * member with neither names no key.
 *
 * @param member {RelationMember}
 * @returns {string | undefined}
 */
export function memberKeyMultibase({
  id,
  method
}: RelationMember): string | undefined {
  const fragment = id === undefined ? undefined : vmFragmentOf(id)
  const published = method?.publicKeyMultibase
  if (fragment !== undefined && published !== undefined) {
    return fragment === published ? fragment : undefined
  }
  return fragment ?? published
}

/**
 * The key multibases one relation publishes, each member read through
 * {@link memberKeyMultibase}. Members naming no key are skipped, so the set
 * holds only keys both readings of the document agree on.
 *
 * @param options {object}
 * @param options.doc {ControllerDocument}   a locally verified document
 * @param options.relation {VerificationRelation}   the relation to read
 * @returns {Set<string>}
 */
export function relationKeyMultibases<M extends VerificationMethodShape>({
  doc,
  relation
}: {
  doc: ControllerDocument<M>
  relation: VerificationRelation
}): Set<string> {
  const keys = new Set<string>()
  for (const member of relationMembers({ doc, relation })) {
    const key = memberKeyMultibase(member)
    if (key !== undefined) {
      keys.add(key)
    }
  }
  return keys
}
