/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The chain-head pin: the client-local durable record of a resource log's
 * verified identity and latest verified head, kept per log beside the app's
 * other continuity pins (the account pointer, the roster epoch pin). The pin
 * is what turns one-shot verification into continuity: a served log whose
 * SCID or method differs from the pin outside a verified handover, or whose
 * history is not a descendant of the pinned head, is refused instead of
 * adopted. Storage is the app's concern (freewallet: beside its other pins in
 * localStorage; DCW: a table row), so only the seam lives here, plus an
 * in-memory implementation for tests and single-session use.
 *
 * The seam is keyed: every read and write names the log it concerns with a
 * `logId`, so one store instance serves every log a wallet holds. The
 * consuming package supplies the key at every call, built by
 * {@link resourceLogPinId} for a log stored as a Resource, or by
 * {@link collectionLogPinId} for a Collection's governing history log (or by
 * a named builder over either), so an app implements one keyed store and
 * never chooses keys itself.
 */

/**
 * One log's pin: the format identifier from the genesis `parameters.method`,
 * the SCID, and the `versionId` of the latest verified head. Established at
 * first contact (trust-on-first-use of the log's identity), advanced only
 * after a full verification whose head is the pinned head or a descendant,
 * and replaced wholesale only across a verified handover.
 */
export interface ResourceLogHeadPin {
  method: string
  scid: string
  head: string
}

/**
 * Where a client keeps its chain-head pins, one record per log, keyed by
 * `logId`. `read` resolves `null` before first contact with that log. Writes
 * happen only on the two legal transitions (advance after full verification,
 * replace across a verified handover) -- the verifier never regresses a pin.
 *
 * The `logId` uniquely names one log among all the logs this store instance
 * serves: one store may serve every log a wallet holds, keyed per log, and two
 * different logs must never share a `logId`. The consuming package supplies
 * the key at every read and write, built by {@link resourceLogPinId} or
 * {@link collectionLogPinId} (or a named builder over either), so an
 * implementation never chooses keys of its own.
 */
export interface ResourceLogPinStore {
  read(options: { logId: string }): Promise<ResourceLogHeadPin | null>
  write(options: { logId: string; pin: ResourceLogHeadPin }): Promise<void>
}

/**
 * The pin-slot key for one log: an opaque per-log identity key for pin
 * storage, not a fetchable path or URL.
 *
 * It is deliberately host-free. The `spaceId` is the account's stable random
 * id, so a log served from a claimed new host lands in the SAME pin slot and
 * is checked against the pin already held, rather than opening a fresh
 * trust-on-first-use slate (the mirror-fork concern).
 *
 * The key relies on the WAS rule that Space, Collection, and Resource ids are
 * URL-safe, so `/` never appears inside a segment and the three-part key is
 * unambiguous. The function refuses an empty or slash-bearing segment with a
 * `TypeError` rather than silently producing an ambiguous key.
 *
 * @param options {object}
 * @param options.spaceId {string}   the Space the log lives in
 * @param options.collectionId {string}   the collection holding the log
 * @param options.resourceId {string}   the log resource's id
 * @returns {string}
 * @throws {TypeError}
 */
export function resourceLogPinId({
  spaceId,
  collectionId,
  resourceId
}: {
  spaceId: string
  collectionId: string
  resourceId: string
}): string {
  assertUrlSafeSegment('resourceId', resourceId)
  return `${collectionPrefix({ spaceId, collectionId })}/${resourceId}`
}

/**
 * The pin-slot key for a Collection's governing history log: the log kept at
 * the Collection's `meta/log` sub-resource, which governs the Collection's
 * own state rather than one Resource in it.
 *
 * It gets its own builder because that sub-resource sits under the reserved
 * `meta` segment rather than under a Resource id. `resourceLogPinId` refuses
 * a `/` inside a segment, correctly, since Resource ids are URL-safe, so it
 * cannot name this two-segment tail.
 *
 * In every other respect it follows `resourceLogPinId`, as documented there:
 * an opaque host-free identity key for pin storage, with `spaceId` and
 * `collectionId` guarded by the same `TypeError`.
 *
 * @param options {object}
 * @param options.spaceId {string}   the Space the Collection lives in
 * @param options.collectionId {string}   the Collection whose log this is
 * @returns {string}
 * @throws {TypeError}
 */
export function collectionLogPinId({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  return `${collectionPrefix({ spaceId, collectionId })}/meta/log`
}

/**
 * The host-free `space/<spaceId>/<collectionId>` prefix both builders share,
 * with its two segments guarded.
 *
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {string}
 * @throws {TypeError}
 */
function collectionPrefix({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  assertUrlSafeSegment('spaceId', spaceId)
  assertUrlSafeSegment('collectionId', collectionId)
  return `space/${spaceId}/${collectionId}`
}

/**
 * Guards one pin-slot key segment: it must be non-empty and must not contain
 * `/`, per the WAS rule that Space, Collection, and Resource ids are
 * URL-safe.
 *
 * @param name {string}
 * @param value {string}
 * @throws {TypeError}
 */
function assertUrlSafeSegment(name: string, value: string): void {
  if (value.length === 0 || value.includes('/')) {
    throw new TypeError(
      `${name} must be a non-empty id without "/" (WAS ids are URL-safe); got ${JSON.stringify(value)}`
    )
  }
}

/**
 * An in-memory pin store: continuity within one session only, keyed by
 * `logId` like any other implementation, so one instance serves several logs.
 * Tests use it as the seam's reference implementation; apps persist for real.
 *
 * @returns {ResourceLogPinStore}
 */
export function memoryResourceLogPinStore(): ResourceLogPinStore {
  const pins = new Map<string, ResourceLogHeadPin>()
  return {
    async read({ logId }) {
      return pins.get(logId) ?? null
    },
    async write({ logId, pin }) {
      pins.set(logId, pin)
    }
  }
}
