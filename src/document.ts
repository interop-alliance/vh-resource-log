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
 * live here, dependency-free, beside the DID URL codec in `vmFragment.ts`
 * for the same reason that codec does: this library is the lowest layer the
 * consuming wallet and storage packages all import.
 *
 * The key rule is DID Core's: a member's key is the `publicKeyMultibase` of
 * the method it resolves to, and the fragment of its id is an opaque
 * selector that names no key. This stack still mints every method id as
 * `${did}#${publicKeyMultibase}`, but no reader depends on it.
 *
 * Ids are compared in absolute form. A relative DID URL (`#fragment`, DID
 * Core section 3.2.2) resolves against the document's own `id`, so a
 * reference, an embedded method, and a `verificationMethod` entry name the
 * same method whether each is written absolute or relative.
 *
 * Deciding which methods belong to whom (an enrolled client, a standing
 * credential's ladder) is each consumer's own rule over the members these
 * readers return. Nothing here filters.
 */

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
  id?: string
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
 * A verification-method id in absolute form: a relative DID URL
 * (`#fragment`) prefixed with the DID it is relative to, any other id
 * verbatim. With no DID to resolve against, a relative id stays relative and
 * matches only another relative id.
 *
 * @param options {object}
 * @param options.id {string}
 * @param [options.did] {string}   the document's own DID
 * @returns {string}
 */
function absoluteMethodId({
  id,
  did
}: {
  id: string
  did: string | undefined
}): string {
  return id.startsWith('#') && did !== undefined ? `${did}${id}` : id
}

/**
 * The per-document `verificationMethod` index the relation readers resolve
 * string references through, keyed by absolute id and memoized on the array
 * itself. A verified document is read many times over (a controller adapter
 * resolves several relations per log entry, and every ceremony re-reads the
 * head), and no reader mutates a `verificationMethod` array in place: a
 * rebuilt document carries a fresh array, so it keys a fresh index.
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
        byId.set(absoluteMethodId({ id: method.id, did: doc.id }), method)
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
      members.push({
        id: entry,
        method: byId.get(absoluteMethodId({ id: entry, did: doc.id }))
      })
    } else if (entry) {
      members.push({ id: entry.id, method: entry })
    }
  }
  return members
}

/**
 * The member of one relation that a DID URL names (the dereference every
 * proof reader of this stack performs): the member whose id, in absolute
 * form, is `${did}#${fragment}`. A relative member id resolves against the
 * document's own `id`, or against `did` when the document carries none.
 * `undefined` when the relation lists no such member; a member found with no
 * method is returned as is, so the caller refuses it under the key rule.
 *
 * @param options {object}
 * @param options.doc {ControllerDocument}   a locally verified document
 * @param options.relation {VerificationRelation}   the relation to read
 * @param options.did {string}   the DID URL's DID
 * @param options.fragment {string}   the DID URL's fragment
 * @returns {RelationMember | undefined}
 */
export function relationMemberNamed<M extends VerificationMethodShape>({
  doc,
  relation,
  did,
  fragment
}: {
  doc: ControllerDocument<M>
  relation: VerificationRelation
  did: string
  fragment: string
}): RelationMember<M> | undefined {
  const wanted = `${did}#${fragment}`
  const base = doc.id ?? did
  return relationMembers({ doc, relation }).find(
    member =>
      member.id !== undefined &&
      absoluteMethodId({ id: member.id, did: base }) === wanted
  )
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
 * reader of this stack applies: the `publicKeyMultibase` of the method the
 * member resolves to, and `undefined` when there is none. A reference nothing
 * backs names no key, a method that publishes no key names none, and the
 * fragment of the member's id is never read as a key: it is an opaque
 * selector (DID Core), even though this stack mints it equal to the key.
 *
 * @param member {RelationMember}
 * @returns {string | undefined}
 */
export function memberKeyMultibase({
  method
}: RelationMember): string | undefined {
  return method?.publicKeyMultibase
}

/**
 * The key multibases one relation publishes, each member read through
 * {@link memberKeyMultibase}. Members naming no key (a reference nothing
 * backs, a method without a key) are skipped.
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
