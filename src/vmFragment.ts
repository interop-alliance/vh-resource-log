/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The one fragment reader for verification-method ids, and the one codec for
 * the profile's versioned verification-method DID URL. The reader serves the
 * did:key kid, where the fragment is the key by that method's spec, and the
 * ids this stack mints (every method id is `${did}#${multibase}`). It is not
 * a key rule for a controller document: there a verification method's key is
 * the `publicKeyMultibase` the document publishes, the verifier dereferences
 * a proof's DID URL to that method (`document.ts`, `verify.ts`), and the
 * fragment is an opaque selector, as in DID Core. The extraction used to
 * exist in four copies that disagreed on the degenerate inputs; it lives
 * here instead, dependency-free, because this library is the lowest layer
 * the consuming wallet and storage packages all import. The versioned DID
 * URL (`${did}?versionId=${id}#${fragment}`) is built and parsed here for
 * the same reason: the writer and the verifier read one definition, so
 * neither can drift from the other.
 */

/**
 * The fragment after the LAST `#` of a DID URL or verification-method id, or
 * `undefined` when the id carries no `#` at all or its fragment is empty (a
 * trailing `#`).
 *
 * The last `#` wins on a degenerate double-`#` id: ids are minted as
 * `${did}#${multibase}`, so the final segment is the minted fragment either
 * way, and reading it from the end also survives a DID whose method-specific
 * id ever grows a `#`.
 *
 * `undefined` is the only absent-fragment convention here. A caller that needs a
 * different one -- throwing on a fragmentless id, or falling back to the whole
 * string -- wraps this helper explicitly at its own call site, so the choice
 * stays visible where it is made.
 *
 * @param id {string}
 * @returns {string | undefined}
 */
export function vmFragmentOf(id: string): string | undefined {
  const hashIndex = id.lastIndexOf('#')
  if (hashIndex === -1 || hashIndex === id.length - 1) {
    return undefined
  }
  return id.slice(hashIndex + 1)
}

/**
 * Builds a proof's versioned verification-method DID URL: the controller DID,
 * the entry's controller versionId as the lone `versionId` DID parameter
 * (omitted for an unversioned controller), and the verification method's
 * fragment (the appender passes its signing key's multibase, the id this
 * stack mints the method under). `parseVersionedVm` reads exactly this shape
 * back.
 *
 * @param options {object}
 * @param options.did {string}
 * @param [options.controllerVersionId] {string}
 * @param options.fragment {string}
 * @returns {string}
 */
export function buildVersionedVm({
  did,
  controllerVersionId,
  fragment
}: {
  did: string
  controllerVersionId?: string | undefined
  fragment: string
}): string {
  const query =
    controllerVersionId === undefined ? '' : `?versionId=${controllerVersionId}`
  return `${did}${query}#${fragment}`
}

/**
 * Parses a versioned verification-method DID URL into its controller DID, its
 * controller versionId, and its fragment, or `undefined` when the string is
 * not one `buildVersionedVm` could have produced: no fragment, an empty DID,
 * or a query that is anything other than a single non-empty `versionId`
 * parameter (no other parameters, no percent-encoding games). The fragment
 * selects a verification method in the controller document at that version;
 * it is not the key (the verifier dereferences it).
 *
 * @param id {string}
 * @returns {{ did: string; controllerVersionId?: string; fragment: string } | undefined}
 */
export function parseVersionedVm(
  id: string
): { did: string; controllerVersionId?: string; fragment: string } | undefined {
  const fragment = vmFragmentOf(id)
  if (fragment === undefined) {
    return undefined
  }
  const didUrl = id.slice(0, id.length - fragment.length - 1)
  const queryIndex = didUrl.indexOf('?')
  const did = queryIndex === -1 ? didUrl : didUrl.slice(0, queryIndex)
  if (did === '') {
    return undefined
  }
  if (queryIndex === -1) {
    return { did, fragment }
  }
  const match = /^versionId=([^?&=%#]+)$/.exec(didUrl.slice(queryIndex + 1))
  if (match === null) {
    return undefined
  }
  return { did, controllerVersionId: match[1]!, fragment }
}
