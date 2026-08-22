/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The resource-log refusal taxonomy, carried over from the roster's WC-1
 * detached-signature design onto the log design. Two adversarial classes plus
 * an admission refusal, a confirmation refusal, and the store port's conflict
 * signal:
 *
 * - {@link ResourceLogIntegrityError} -- fabrication: the served log fails
 *   verification on its own terms (JSON Lines parse, entry shape, SCID, chain
 *   hashes, proofs, or the external-authorization rule). Whoever produced it
 *   could not make a log the account's clients would have made. The same
 *   class is thrown about the writer's own candidate entry when the
 *   pre-write pass refuses it (never served, never written); its messages
 *   stay reader-phrased, naming the candidate's would-be ordinal.
 * - {@link ResourceLogContinuityError} -- a served log that verifies but
 *   conflicts with what this client has already accepted: a rollback behind
 *   the chain-head pin, a fork off the pinned history, or an SCID/method
 *   switch outside a verified handover. The log may be internally consistent;
 *   it is not the continuation of the history this client pinned.
 * - {@link ResourceLogClosedError} -- an append refused because the verified
 *   head is a terminal handover entry, thrown by `appendResourceLog` before
 *   building and by `verifyResourceLogAppend` for a consumer's own write
 *   path. Not an attack: the log's own authors closed it, and a verifier of
 *   this profile must refuse to extend a closed log even though nothing
 *   currently emits terminal entries.
 * - {@link LogNotConfirmedError} -- an acknowledged append that the read-back
 *   could not find in the served history. An acknowledgement is a promise,
 *   not a fact; until the read-back confirms, the append is not durable.
 * - {@link ResourceLogConflictError} -- the store port's compare-and-swap
 *   conflict: a stale validator on an append, or a lost guarded-create race.
 *   Not a failure class at all from the caller's side -- the append path
 *   catches it and rebases -- but it crosses the store-adapter package
 *   boundary, so it is matched by `name`, never by `instanceof`.
 *
 * Ratified conventions (design sign-off 2026-08-22, restated here as the
 * classes' contract):
 *
 * 1. The store port's conflict signal is the library-owned
 *    {@link ResourceLogConflictError}, thrown by a store's `append` and
 *    `create` on a stale validator or a lost create race, with the
 *    transport's own error as `cause`. It is matched by `err.name`
 *    everywhere it crosses a package boundary (the
 *    {@link isResourceLogConflictError} predicate), so two resolved copies
 *    of this library cannot turn a benign lost race into a hard failure.
 * 2. A body that does not parse as the profile's JSON Lines format, and a
 *    read-back entry whose `versionId` carries no ordinal, refuse with
 *    {@link ResourceLogIntegrityError}: a log that does not parse is a
 *    doctored or truncated log, the fabrication class.
 * 3. {@link LogNotConfirmedError} keeps its historical name and extends
 *    `Error` directly (it is not a transport error).
 * 6. Name preservation: every class here assigns its `name` explicitly and
 *    keeps that string verbatim across releases. Cross-package catchers
 *    dispatch on `err.name` (minified class names do not survive bundling,
 *    and duplicated package copies break `instanceof`); a drifted name fails
 *    open in those catchers, so the string IS the contract.
 *
 * (Items 4 and 5 of the same sign-off -- the controller port's `admitAppend`
 * hook and the `./testing` subpath -- live in `controller.ts` and
 * `testing.ts`.)
 */

/**
 * A served log failed verification: an unparseable body, malformed entries, a
 * non-verifying SCID, a broken hash chain, a failing proof, or a signer the
 * controller document does not back at the entry's anchored version.
 * Fabrication-class: refused as something no enrolled client produced. Also
 * thrown about the writer's own candidate entry when the pre-write pass
 * (`verifyResourceLogAppend`, or the genesis pass in `createResourceLog`)
 * refuses it: the entry was never served and is never written, and the
 * message's ordinal is the candidate's would-be position.
 */
export class ResourceLogIntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ResourceLogIntegrityError'
  }
}

/**
 * A served log conflicts with this client's chain-head pin: `rollback` (the
 * served head is behind the pinned head -- possibly replication lag; the pin
 * is never regressed and the caller may retry), `fork` (the served log
 * diverges from the pinned history -- both logs are transferable evidence of
 * equivocation, so the served entries ride along), `scid-switch` /
 * `method-switch` (a different log identity or format under the pinned
 * location, outside a verified handover).
 */
export class ResourceLogContinuityError extends Error {
  reason: 'rollback' | 'fork' | 'scid-switch' | 'method-switch'
  pinnedHead: string
  /**
   * On a `fork`, the full served log retained as evidence: every entry is
   * signed, so a conflicting pair of logs under one SCID is transferable,
   * independently verifiable proof of equivocation.
   */
  servedEntries?: unknown[]
  constructor({
    reason,
    pinnedHead,
    servedEntries
  }: {
    reason: 'rollback' | 'fork' | 'scid-switch' | 'method-switch'
    pinnedHead: string
    servedEntries?: unknown[]
  }) {
    super(
      `The served resource log is not a continuation of the pinned history ` +
        `(${reason}; pinned head ${pinnedHead}).`
    )
    this.name = 'ResourceLogContinuityError'
    this.reason = reason
    this.pinnedHead = pinnedHead
    this.servedEntries = servedEntries
  }
}

/**
 * An append was refused because the log's verified head is a terminal
 * handover entry: the log is closed and names a successor, and this profile
 * forbids extending a history its authors have closed. Thrown by
 * `appendResourceLog` and by `verifyResourceLogAppend`.
 */
export class ResourceLogClosedError extends Error {
  nextLog: { method: string; scid: string }
  constructor({ nextLog }: { nextLog: { method: string; scid: string } }) {
    super(
      'The resource log is closed by a terminal handover entry; appends must ' +
        'go to its successor log.'
    )
    this.name = 'ResourceLogClosedError'
    this.nextLog = nextLog
  }
}

/**
 * An acknowledged append (or create) that the read-back could not confirm:
 * the log is missing, shorter than the entry's ordinal, or holds a different
 * entry there. The append -- and any ceremony step gated on it -- must not be
 * treated as durable.
 */
export class LogNotConfirmedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LogNotConfirmedError'
  }
}

/**
 * The store port's compare-and-swap conflict: an append against a stale
 * validator, or a guarded create that lost its race. Store adapters mint it
 * (with the transport's own error as `cause`); the append and create paths
 * catch it -- by `name`, through {@link isResourceLogConflictError} -- and
 * fail into the rebase-and-retry loop rather than treating it as an error.
 */
export class ResourceLogConflictError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ResourceLogConflictError'
  }
}

/**
 * Whether an error is the store port's CAS conflict signal, matched by `name`
 * (the cross-package rule above: `instanceof` breaks the moment two copies of
 * this library resolve in one tree, and a missed match here would turn every
 * benign lost race into a hard failure).
 *
 * @param err {unknown}
 * @returns {boolean}
 */
export function isResourceLogConflictError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ResourceLogConflictError'
}
