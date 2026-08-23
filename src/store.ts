/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The log-store seam: where a resource log lives and how it is extended --
 * read-with-etag of the full log, compare-and-swap append conditioned on that
 * etag, and the guarded create of a genesis entry. The seam is transport only:
 * chain verification (SCID, entry hashes, proofs, authorization, the
 * chain-head pin) lives in `verify.ts`, whose callers read through this seam,
 * verify the parsed entries, build the next entry against the verified head,
 * and append through it. The shipped WAS binding is was-client's
 * `resourceLogStore`.
 *
 * Both the append and the create ride the backend's `conditional-writes`
 * feature -- the profile requires it (without the precondition, concurrent
 * appends silently overwrite one another instead of failing into the caller's
 * rebase-and-retry loop). `confirmAppend` is the profile's "acknowledgement is
 * a promise" rule: after an acked append, read the log back and check the
 * entry is actually in the served history before treating the append -- or any
 * ceremony step gated on it -- as durable.
 */
import { canonicalizeStrict } from '@interop/did-method-webvh'
import type { ResourceLogEntry } from '@interop/storage-core'
import { versionIdOrdinal } from './entry.js'
import { LogNotConfirmedError, ResourceLogIntegrityError } from './errors.js'

/**
 * Where a resource log lives: a read-with-validator, a compare-and-swap
 * append, and a guarded genesis create. Implementations host the log anywhere
 * a versioned text resource can live; the shipped adapter is was-client's
 * `resourceLogStore`.
 */
export interface ResourceLogStore {
  /**
   * Reads the full log together with the opaque `etag` validator the next
   * {@link append} must be compare-and-swapped against. Resolves `null` when
   * the log resource does not exist yet (the pre-genesis state -- see
   * {@link create}); throws on a body that does not parse as strict JSON
   * Lines. `etag` is absent against a backend that does not version resources
   * -- a caller MUST NOT append without one (the profile forbids falling back
   * to an unconditional write). An empty string counts as absent on the append
   * path, so an adapter need not normalize a blank validator away, and gains
   * nothing by passing one.
   *
   * @returns {Promise<{ entries: ResourceLogEntry[]; etag?: string } | null>}
   */
  read(): Promise<{ entries: ResourceLogEntry[]; etag?: string } | null>

  /**
   * Appends one entry to the log read by the most recent {@link read} on this
   * store instance, compare-and-swapped against `ifMatch` (the validator that
   * read returned); a stale validator throws the library's
   * `ResourceLogConflictError` (the transport's own error as `cause`), and
   * the caller re-reads, re-verifies, rebases the entry on the new head, and
   * retries. The prior entries' bytes are carried forward verbatim from
   * the read, with the new entry's line appended -- an append never
   * re-serializes history.
   *
   * @param entry {ResourceLogEntry}   the entry extending the log
   * @param options {object}
   * @param options.ifMatch {string}   the validator from the prior read
   * @returns {Promise<void>}
   */
  append(entry: ResourceLogEntry, options: { ifMatch: string }): Promise<void>

  /**
   * Creates the log with its genesis entry where {@link read} resolved `null`,
   * guarded create-if-absent (`If-None-Match: *`); throws the library's
   * `ResourceLogConflictError` when a concurrent writer created the log
   * first.
   *
   * @param entry {ResourceLogEntry}   the genesis entry
   * @returns {Promise<void>}
   */
  create(entry: ResourceLogEntry): Promise<void>
}

/**
 * The profile's "acknowledgement is a promise" rule, mechanically: after an
 * acked {@link ResourceLogStore.append} (or `create`), reads the log back and
 * checks the served history actually contains the written entry at its
 * ordinal, throwing {@link LogNotConfirmedError} when it does not (the log is
 * missing, shorter than the entry's ordinal, or holds a different entry
 * there). Returns the read-back log so the caller can run full chain
 * verification over exactly what was confirmed -- containment here is a
 * byte-level check (JCS equality), not a verification.
 *
 * @param options {object}
 * @param options.store {ResourceLogStore}
 * @param options.entry {ResourceLogEntry}   the entry the append wrote
 * @returns {Promise<{ entries: ResourceLogEntry[]; etag?: string }>}   the
 *   read-back log containing the entry
 */
export async function confirmAppend({
  store,
  entry
}: {
  store: ResourceLogStore
  entry: ResourceLogEntry
}): Promise<{ entries: ResourceLogEntry[]; etag?: string }> {
  const ordinal = versionIdOrdinal(entry.versionId)
  if (ordinal === undefined) {
    throw new ResourceLogIntegrityError(
      `Cannot confirm append: the entry's versionId "${entry.versionId}" ` +
        'does not start with a 1-based ordinal.'
    )
  }
  const current = await store.read()
  if (current === null) {
    throw new LogNotConfirmedError(
      'Resource-log append not confirmed: the log resource is missing on ' +
        'read-back.'
    )
  }
  const served = current.entries[ordinal - 1]
  if (
    served === undefined ||
    canonicalizeStrict(served) !== canonicalizeStrict(entry)
  ) {
    throw new LogNotConfirmedError(
      `Resource-log append not confirmed: the served log does not contain ` +
        `the appended entry at ordinal ${ordinal}.`
    )
  }
  return current
}
