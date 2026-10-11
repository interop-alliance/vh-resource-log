/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The sealing sweep (App Connect spec `#log-authorization`): after a
 * controller-document edit removes a member's append authority, every
 * co-managed resource log must gain an entry carrying controller version at
 * (or past) the post-removal document version -- the "sealing append" that
 * proves the surviving writers extended the log under the new membership. An
 * ordinary post-edit write (a roster rotation) is that append by
 * construction; the gap this module closes is the run where no such write
 * happens -- a rotation that no-ops because the retiree held no
 * current-epoch wrap (an orphan client, or any re-run), leaving the log's
 * head still carrying a pre-removal controller version.
 *
 * Both halves are computed from durable state alone, keeping every cascade's
 * no-checkpoint convergence rule: the membership change is read off the
 * controller view (the latest version whose `assertionMethod` set lost a
 * member against its predecessor -- only assertion removals affect append
 * authority, so a spent recovery code's `keyAgreement`-only method never
 * registers here). Membership is read as the set of published keys, under
 * the same key rule the verifier applies. A member whose key changed under
 * an unchanged id is a removal. A reference nothing backs never held
 * authority, so dropping it is not one. The log's side is the verified
 * head's effective controller version
 * ({@link VerifiedResourceLog}`.headControllerVersionIndex`).
 * "Sealed" is simply "head controller version at or past the removal", so
 * the backstop append is idempotent and a
 * torn sweep is finished by a naive re-run by any surviving member (the
 * append path's pre-write pass refuses a sweep driven by the removed member
 * before anything is written).
 */
import type { ResourceLogStore } from './store.js'
import {
  appendResourceLog,
  readResourceLog,
  type ResourceLogRead
} from './append.js'
import type { ResourceLogController } from './controller.js'
import { relationKeyMultibases } from './document.js'
import type { ResourceLogSigner } from './entry.js'
import type { ResourceLogPinStore } from './pin.js'
import type { VerifiedResourceLog } from './verify.js'

/**
 * The controller's latest membership change: the largest index into
 * `controller.versionIds` whose set of published `assertionMethod` keys
 * LOST a member against its predecessor's, or `0` when no version ever
 * removed one (the
 * genesis version has no predecessor and can never register as a removal, so
 * `0` doubles as "nothing to seal against" -- every controller version
 * satisfies it). An
 * unversioned controller resolves `0` for the same reason: with no version
 * history there is no removal to locate.
 *
 * @param options {object}
 * @param options.controller {ResourceLogController}   the verified controller
 *   view
 * @returns {Promise<number>}
 */
export async function latestAssertionRemovalIndex({
  controller
}: {
  controller: ResourceLogController
}): Promise<number> {
  // Each version's key set resolves independently; only the pairwise
  // comparison below is ordered.
  const keySets = await Promise.all(
    controller.versionIds.map(async versionId =>
      relationKeyMultibases({
        doc: await controller.documentAt(versionId),
        relation: 'assertionMethod'
      })
    )
  )
  let removalIndex = 0
  keySets.forEach((keys, index) => {
    if (index === 0) {
      return
    }
    for (const key of keySets[index - 1]!) {
      if (!keys.has(key)) {
        removalIndex = index
        break
      }
    }
  })
  return removalIndex
}

/**
 * Whether a head carrying `headControllerVersionIndex` already covers the
 * removal at `removalIndex`.
 *
 * @param options {object}
 * @param options.headControllerVersionIndex {number | null}
 * @param options.removalIndex {number}
 * @returns {boolean}
 */
function isSealed({
  headControllerVersionIndex,
  removalIndex
}: {
  headControllerVersionIndex: number | null
  removalIndex: number
}): boolean {
  return (
    headControllerVersionIndex !== null &&
    headControllerVersionIndex >= removalIndex
  )
}

/**
 * Seals one resource log against the controller's latest membership change,
 * idempotently: when the verified head already carries a controller version
 * at or past the latest `assertionMethod` removal (or the controller never
 * removed one, or the log does not exist yet, or the controller is
 * unversioned) nothing is written; otherwise the head state is re-appended
 * VERBATIM as a no-op entry whose only job is its post-removal controller
 * version -- ordinary entries may repeat state
 * (only terminal entries are state-constrained), so the resource itself is
 * untouched. A closed log that needs sealing propagates the append path's
 * `ResourceLogClosedError`.
 *
 * `sealed` reports whether THIS call wrote the sealing append. It is `false`
 * whenever nothing was written, including the run that found the log already
 * sealed through a stale `current` hint and converged on the append path's
 * own read (the rebase hook returns `null` rather than duplicating), so the
 * same log state reports the same result with or without a hint. `verified`
 * is the log as last verified: the supplied hint when nothing was read, the
 * read or read-back view otherwise, and `null` when neither exists (an absent
 * log, or no hint and nothing to seal against).
 *
 * @param options {object}
 * @param options.store {ResourceLogStore}   the log's transport seam
 * @param options.controller {ResourceLogController}   the verified controller
 *   view
 * @param options.expectedMethod {string}   the format identifier expected
 * @param options.pinStore {ResourceLogPinStore}   this client's chain-head
 *   pin for this log
 * @param options.logId {string}   the pin-slot key for this log, from
 *   `resourceLogPinId`
 * @param options.signer {ResourceLogSigner}   this client's enrolled signing
 *   key
 * @param [options.versionTime] {string}   RFC3339 UTC; defaults to now
 * @param [options.current] {ResourceLogRead}   a log view the caller
 *   verified moments ago (the most recent read or confirmed append on the same
 *   store and `logId`), letting the sweep skip its own read. It is handed to
 *   the append path as its `current` seed, so one carrying the read's
 *   validator also seeds the first attempt there; a confirmed append carries
 *   none, and that route reads before writing. The hint is caller-attested,
 *   as the append path's seed is.
 *   Staleness is safe in both directions: entry controller versionIds are
 *   verifier-enforced monotone, so a stale head carrying a controller version
 *   at or past the removal means the true head does too, and an unsealed
 *   verdict is re-checked by the append path's read, or loses the race on the
 *   stale validator and is re-read, before anything is written
 * @returns {Promise<{ sealed: boolean, verified: VerifiedResourceLog | null }>}
 */
export async function sealResourceLog({
  store,
  controller,
  expectedMethod,
  pinStore,
  logId,
  signer,
  versionTime,
  current: hint
}: {
  store: ResourceLogStore
  controller: ResourceLogController
  expectedMethod: string
  pinStore: ResourceLogPinStore
  logId: string
  signer: ResourceLogSigner
  versionTime?: string
  current?: ResourceLogRead
}): Promise<{ sealed: boolean; verified: VerifiedResourceLog | null }> {
  if (controller.versionIds.length === 0) {
    return { sealed: false, verified: hint?.verified ?? null }
  }
  const removalIndex = await latestAssertionRemovalIndex({ controller })
  if (removalIndex === 0) {
    return { sealed: false, verified: hint?.verified ?? null }
  }
  // The caller's hint, else the sweep's own read. Either one seeds the append
  // path's first attempt; the append path reads for itself when the seed
  // carries no validator.
  let current: ResourceLogRead | null = hint ?? null
  if (current === null) {
    current = await readResourceLog({
      store,
      controller,
      expectedMethod,
      pinStore,
      logId
    })
    if (current === null) {
      return { sealed: false, verified: null }
    }
  }
  const { verified } = current
  if (isSealed({ ...verified, removalIndex })) {
    return { sealed: false, verified }
  }
  // Whether the attempt that returned wrote the entry. The hook runs once per
  // CAS attempt, so the last assignment describes the view the append path
  // settled on, not the hint that routed this call here.
  let sealed = false
  const confirmed = await appendResourceLog({
    store,
    controller,
    expectedMethod,
    pinStore,
    logId,
    signer,
    // The rebase hook doubles as the convergence check: a concurrent writer
    // whose entry already carries a controller version past the removal
    // sealed the log for us.
    buildState: rebased => {
      sealed = !isSealed({ ...rebased, removalIndex })
      return sealed ? rebased.head.state : null
    },
    ...(versionTime === undefined ? {} : { versionTime }),
    current
  })
  return { sealed, verified: confirmed }
}
