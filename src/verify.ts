/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The Resource Log Profile's verification algorithm (App Connect spec,
 * `#log-verification`), end-to-end and fail-closed: entry-shape parse checks,
 * SCID recomputation, chain-hash recomputation (never a stated head), proof
 * verification through the did:webvh log kernel, the external-authorization
 * rule (anchor resolution against the independently verified controller
 * document, `assertionMethod` membership at the anchored version, anchor
 * monotonicity), the controller port's per-proof `admitAppend` admission
 * hook, terminal-entry recognition, and continuity against the chain-head
 * pin. Any failure rejects the LOG, not just the failing entry, and nothing
 * served -- a stated head, a digest, a count -- is ever accepted in place of
 * recomputation. The admission hook runs after the kernel call, once every
 * proof of the entry has verified, outside the integrity wrap: a forged
 * signature is refused as the integrity class whatever the hook would have
 * said, and a hook throw keeps its own class so callers can tell a refused
 * admission from a corrupt log. The per-entry checks are shared with
 * `verifyResourceLogAppend`, the write path's pre-write pass over a candidate
 * entry, so a writer refuses exactly what a reader would refuse.
 */
import {
  buildVersionId,
  canonicalizeStrict,
  defaultWebvhLogVerifier,
  deriveHash,
  parseAndValidateVersionId,
  SCID_PLACEHOLDER,
  verifyEntryProofs
} from '@interop/did-method-webvh'
import type {
  ResourceLogEntry,
  ResourceLogEntryProof
} from '@interop/storage-core'
import type { ResourceLogController } from './controller.js'
import { resourceLogStateFault } from './entry.js'
import {
  ResourceLogClosedError,
  ResourceLogContinuityError,
  ResourceLogIntegrityError
} from './errors.js'
import type { ResourceLogHeadPin } from './pin.js'
import { vmFragmentOf } from './vmFragment.js'

/**
 * The five members a log entry carries, exactly.
 */
const ENTRY_MEMBERS = [
  'versionId',
  'versionTime',
  'parameters',
  'state',
  'proof'
]

/**
 * What full verification resolves to. `state` is the profile's definition of
 * the resource's current state -- the verified head entry's `state` -- and
 * `pin` is the record the caller must store as its new chain-head pin.
 * `terminal` is the head's `nextLog` when the log is closed by a handover
 * entry (appends must be refused), `previousLog` the genesis back-reference
 * when this log is a handover successor. `headAnchorIndex` is the head's
 * effective anchor -- the verifier's anchor floor after the whole loop, which
 * monotonicity makes the head entry's own anchor -- as an index into the
 * controller's `versionIds` (`null` on an unversioned controller, whose
 * entries carry no anchors); the sealing sweep compares it against the
 * controller's latest membership change.
 *
 * Also an input: `verifyResourceLogAppend` takes the value as `head` and
 * reads `entries`, `head`, `headAnchorIndex`, and `terminal` as one
 * consistent record. Pass it as returned; a caller-built literal is out of
 * contract.
 */
export interface VerifiedResourceLog {
  entries: ResourceLogEntry[]
  method: string
  scid: string
  head: ResourceLogEntry
  state: ResourceLogEntry['state']
  pin: ResourceLogHeadPin
  headAnchorIndex: number | null
  terminal: { method: string; scid: string } | null
  previousLog: { scid: string; head: string } | null
}

/**
 * Whether an entry is a terminal handover entry: its `parameters` carry a
 * `nextLog` member. Position, exact member set, and state equality are the
 * verifier's checks; this is only the discriminant.
 *
 * @param entry {ResourceLogEntry}
 * @returns {boolean}
 */
export function isTerminalResourceLogEntry(entry: ResourceLogEntry): boolean {
  return (
    typeof entry.parameters === 'object' &&
    entry.parameters !== null &&
    'nextLog' in entry.parameters
  )
}

/**
 * Structural check of one member of an entry's `proof` array against the
 * profile's fixed shape, before any cryptography runs.
 *
 * @param proof {unknown}
 * @param ordinal {number}   the owning entry's 1-based position
 * @returns {ResourceLogEntryProof}
 */
function checkProofShape(
  proof: unknown,
  ordinal: number
): ResourceLogEntryProof {
  const candidate = proof as Partial<ResourceLogEntryProof> | null
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    candidate.type !== 'DataIntegrityProof' ||
    candidate.cryptosuite !== 'eddsa-jcs-2022' ||
    candidate.proofPurpose !== 'assertionMethod' ||
    typeof candidate.verificationMethod !== 'string' ||
    typeof candidate.proofValue !== 'string'
  ) {
    throw new ResourceLogIntegrityError(
      `Resource log entry ${ordinal} carries a proof outside the profile's ` +
        `fixed shape (DataIntegrityProof / eddsa-jcs-2022 / assertionMethod).`
    )
  }
  return candidate as ResourceLogEntryProof
}

/**
 * Shape-checks one entry (the profile's parse step): exactly the five
 * members, `versionId` ordinal at its 1-based position, an RFC3339 UTC
 * `versionTime` (format only -- temporal refusals are forbidden), the
 * per-position `parameters` rules fail-closed, a `state` carrying `type` and
 * no `history`, and a non-empty fixed-shape `proof` array.
 *
 * @param entry {ResourceLogEntry}
 * @param index {number}   the entry's 0-based position
 */
function checkEntryShape(entry: ResourceLogEntry, index: number): void {
  const ordinal = index + 1
  const members = Object.keys(entry)
  if (
    members.length !== ENTRY_MEMBERS.length ||
    ENTRY_MEMBERS.some(member => !(member in entry))
  ) {
    throw new ResourceLogIntegrityError(
      `Resource log entry ${ordinal} does not carry exactly the profile's ` +
        `five members (versionId, versionTime, parameters, state, proof).`
    )
  }
  try {
    parseAndValidateVersionId(entry.versionId, ordinal)
  } catch (err) {
    throw new ResourceLogIntegrityError(
      `Resource log entry ${ordinal} has a malformed or misplaced versionId.`,
      { cause: err }
    )
  }
  if (
    typeof entry.versionTime !== 'string' ||
    !entry.versionTime.endsWith('Z') ||
    Number.isNaN(Date.parse(entry.versionTime))
  ) {
    throw new ResourceLogIntegrityError(
      `Resource log entry ${ordinal} has a malformed versionTime (RFC3339 ` +
        `UTC required; the value itself is advisory).`
    )
  }
  const parameters = entry.parameters
  if (parameters === null || typeof parameters !== 'object') {
    throw new ResourceLogIntegrityError(
      `Resource log entry ${ordinal} has a non-object parameters member.`
    )
  }
  const parameterMembers = Object.keys(parameters)
  if (index === 0) {
    const genesis = parameters as {
      method?: unknown
      scid?: unknown
      previousLog?: { scid?: unknown; head?: unknown }
    }
    const allowed = parameterMembers.every(member =>
      ['method', 'scid', 'previousLog'].includes(member)
    )
    if (
      !allowed ||
      typeof genesis.method !== 'string' ||
      typeof genesis.scid !== 'string' ||
      (genesis.previousLog !== undefined &&
        (genesis.previousLog === null ||
          typeof genesis.previousLog !== 'object' ||
          typeof genesis.previousLog.scid !== 'string' ||
          typeof genesis.previousLog.head !== 'string' ||
          Object.keys(genesis.previousLog).length !== 2))
    ) {
      throw new ResourceLogIntegrityError(
        'The resource log genesis parameters must carry method and scid ' +
          '(plus, on a handover successor only, previousLog) and nothing else.'
      )
    }
  } else if (parameterMembers.length !== 0) {
    // The only non-genesis entry with parameters is a terminal handover
    // entry, exactly { nextLog: { method, scid } }. Anything else -- the
    // deleted did:webvh key-management parameters in particular -- is refused
    // fail-closed.
    const terminal = parameters as {
      nextLog?: { method?: unknown; scid?: unknown }
    }
    if (
      parameterMembers.length !== 1 ||
      terminal.nextLog === undefined ||
      terminal.nextLog === null ||
      typeof terminal.nextLog !== 'object' ||
      typeof terminal.nextLog.method !== 'string' ||
      typeof terminal.nextLog.scid !== 'string' ||
      Object.keys(terminal.nextLog).length !== 2
    ) {
      throw new ResourceLogIntegrityError(
        `Resource log entry ${ordinal} carries parameters this profile does ` +
          `not define for its position (only a terminal entry's nextLog is ` +
          `permitted past genesis).`
      )
    }
  }
  const stateFault = resourceLogStateFault(entry.state)
  if (stateFault === 'type') {
    throw new ResourceLogIntegrityError(
      `Resource log entry ${ordinal} has no state.type schema identifier.`
    )
  }
  if (stateFault === 'history') {
    throw new ResourceLogIntegrityError(
      `Resource log entry ${ordinal} carries a history member inside its ` +
        `state (the profile reserves that member name).`
    )
  }
  if (!Array.isArray(entry.proof) || entry.proof.length === 0) {
    throw new ResourceLogIntegrityError(
      `Resource log entry ${ordinal} carries no proof array.`
    )
  }
  for (const proof of entry.proof) {
    checkProofShape(proof, ordinal)
  }
}

/**
 * Deep-clones a JSON value, replacing every string equal to the SCID with the
 * `{SCID}` placeholder -- the inverse of genesis construction, used to
 * recompute the SCID from a served genesis entry.
 *
 * @param value {unknown}
 * @param scid {string}
 * @returns {unknown}
 */
function substituteScid(value: unknown, scid: string): unknown {
  if (typeof value === 'string') {
    return value === scid ? SCID_PLACEHOLDER : value
  }
  if (Array.isArray(value)) {
    return value.map(item => substituteScid(item, scid))
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, member] of Object.entries(value)) {
      result[key] = substituteScid(member, scid)
    }
    return result
  }
  return value
}

/**
 * The hash input of entry `n`: the entry with `proof` removed and `versionId`
 * replaced by the predecessor's `versionId` (the SCID for the genesis entry).
 *
 * @param entry {ResourceLogEntry}
 * @param predecessorVersionId {string}
 * @returns {object}
 */
function hashInputOf(
  entry: ResourceLogEntry,
  predecessorVersionId: string
): object {
  return {
    versionId: predecessorVersionId,
    versionTime: entry.versionTime,
    parameters: entry.parameters,
    state: entry.state
  }
}

/**
 * Splits a proof's `verificationMethod` DID URL into its base DID, its
 * `versionId` DID parameter (the entry anchor), and its fragment (the signing
 * key's multibase).
 *
 * @param verificationMethod {string}
 * @param ordinal {number}   the owning entry's 1-based position
 * @returns {object}
 */
function parseAnchoredVm(
  verificationMethod: string,
  ordinal: number
): { did: string; anchor?: string; keyMultibase: string } {
  const keyMultibase = vmFragmentOf(verificationMethod)
  if (keyMultibase === undefined) {
    throw new ResourceLogIntegrityError(
      `Resource log entry ${ordinal} has a proof verificationMethod without ` +
        `a key fragment.`
    )
  }
  const didUrl = verificationMethod.slice(
    0,
    verificationMethod.length - keyMultibase.length - 1
  )
  const queryIndex = didUrl.indexOf('?')
  if (queryIndex === -1) {
    return { did: didUrl, keyMultibase }
  }
  const did = didUrl.slice(0, queryIndex)
  const params = new URLSearchParams(didUrl.slice(queryIndex + 1))
  const anchor = params.get('versionId') ?? undefined
  return { did, anchor, keyMultibase }
}

/**
 * Recomputes one entry's hash from its predecessor-substituted input and
 * checks the entry's `versionId` against it (the chain step; never a stated
 * head).
 *
 * @param options {object}
 * @param options.entry {ResourceLogEntry}
 * @param options.index {number}   the entry's 0-based position
 * @param options.predecessorVersionId {string}   the predecessor's
 *   `versionId` (the SCID for the genesis entry)
 * @returns {Promise<void>}
 */
async function checkEntryChain({
  entry,
  index,
  predecessorVersionId
}: {
  entry: ResourceLogEntry
  index: number
  predecessorVersionId: string
}): Promise<void> {
  const entryHash = await deriveHash(hashInputOf(entry, predecessorVersionId))
  if (entry.versionId !== buildVersionId(index + 1, entryHash)) {
    throw new ResourceLogIntegrityError(
      `Resource log entry ${index + 1} does not hash-chain to its ` +
        `predecessor.`
    )
  }
}

/**
 * The controller's `versionId` list as an anchor-to-index map. First index
 * wins on a repeated `versionId`; the port requires the list to be distinct,
 * so the rule only matters for a view that breaks its precondition.
 *
 * @param controller {ResourceLogController}
 * @returns {Map<string, number>}
 */
function anchorIndexesOf(
  controller: ResourceLogController
): Map<string, number> {
  const anchorIndexes = new Map<string, number>()
  for (const [index, versionId] of controller.versionIds.entries()) {
    if (!anchorIndexes.has(versionId)) {
      anchorIndexes.set(versionId, index)
    }
  }
  return anchorIndexes
}

/**
 * Checks the terminal-entry state rule: a handover changes no resource
 * state, so the terminal entry's `state` canonicalizes equal to its
 * predecessor's.
 *
 * @param options {object}
 * @param options.entry {ResourceLogEntry}   the terminal entry
 * @param options.predecessorState {ResourceLogEntry['state']}
 */
function checkTerminalState({
  entry,
  predecessorState
}: {
  entry: ResourceLogEntry
  predecessorState: ResourceLogEntry['state']
}): void {
  if (
    canonicalizeStrict(entry.state) !== canonicalizeStrict(predecessorState)
  ) {
    throw new ResourceLogIntegrityError(
      "The terminal handover entry's state differs from its " +
        "predecessor's (a handover changes no resource state)."
    )
  }
}

/**
 * Verifies one entry's proofs and authorization against the anchor floor its
 * predecessors established (the per-entry body of verification steps 4 and
 * 5): every proof through the kernel, the external-authorization rule per
 * proof (controller DID, anchor presence, anchor monotonicity against the
 * floor, `assertionMethod` membership at the anchored version), then the
 * controller's `admitAppend` hook per proof for every entry past genesis.
 * Resolves the entry's effective anchor index, the floor for the next entry.
 * Reads `entry` without mutating it.
 *
 * @param options {object}
 * @param options.entry {ResourceLogEntry}
 * @param options.index {number}   the entry's 0-based position
 * @param options.controller {ResourceLogController}
 * @param options.anchorFloor {number}   the predecessors' effective anchor
 * @param options.anchorIndexes {Map<string, number>}   from
 *   {@link anchorIndexesOf}
 * @param options.versioned {boolean}   whether the controller is versioned
 * @returns {Promise<number>}
 */
async function verifyEntryAgainstFloor({
  entry,
  index,
  controller,
  anchorFloor,
  anchorIndexes,
  versioned
}: {
  entry: ResourceLogEntry
  index: number
  controller: ResourceLogController
  anchorFloor: number
  anchorIndexes: Map<string, number>
  versioned: boolean
}): Promise<number> {
  const ordinal = index + 1
  let entryAnchorIndex = anchorFloor
  // The admission hook's per-proof inputs, recorded during authorization
  // and drained only after every proof of the entry has verified (below).
  const admissions: Array<
    Parameters<NonNullable<ResourceLogController['admitAppend']>>[0]
  > = []
  // The kernel calls `authorize` before `resolveVM` for the same proof, so
  // the parse throws from `authorize` exactly as it did when both parsed.
  const parsed = new Map<string, ReturnType<typeof parseAnchoredVm>>()
  const parseOnce = (
    verificationMethod: string
  ): ReturnType<typeof parseAnchoredVm> => {
    let result = parsed.get(verificationMethod)
    if (result === undefined) {
      result = parseAnchoredVm(verificationMethod, ordinal)
      parsed.set(verificationMethod, result)
    }
    return result
  }
  const authorize = async (proof: {
    verificationMethod?: string
  }): Promise<void> => {
    const { did, anchor, keyMultibase } = parseOnce(
      proof.verificationMethod ?? ''
    )
    if (did !== controller.did) {
      throw new ResourceLogIntegrityError(
        `Resource log entry ${ordinal} is signed under a different ` +
          `controller than this log's account.`
      )
    }
    if (versioned && anchor === undefined) {
      throw new ResourceLogIntegrityError(
        `Resource log entry ${ordinal} carries no entry anchor against a ` +
          `version-resolvable controller.`
      )
    }
    if (!versioned && anchor !== undefined) {
      throw new ResourceLogIntegrityError(
        `Resource log entry ${ordinal} anchors a version on an unversioned ` +
          `controller.`
      )
    }
    let anchorIndex = 0
    if (anchor !== undefined) {
      const known = anchorIndexes.get(anchor)
      if (known === undefined) {
        throw new ResourceLogIntegrityError(
          `Resource log entry ${ordinal} anchors an unknown controller ` +
            `document version.`
        )
      }
      anchorIndex = known
      if (anchorIndex < anchorFloor) {
        throw new ResourceLogIntegrityError(
          `Resource log entry ${ordinal} anchors behind its predecessor ` +
            `(anchors must be monotone along the log).`
        )
      }
    }
    const assertionKeys = await controller.assertionKeysAt(anchor)
    if (!assertionKeys.has(keyMultibase)) {
      throw new ResourceLogIntegrityError(
        `Resource log entry ${ordinal} is signed by a key the controller ` +
          `document does not list under assertionMethod at the anchored ` +
          `version.`
      )
    }
    // Record the admission input for every entry past genesis; the hook
    // itself runs after the kernel call. The floor at this point is still
    // the previous entries' effective anchor -- the verified head this
    // append extended -- and nothing assigns it before the drain.
    if (index > 0 && controller.admitAppend !== undefined) {
      admissions.push({
        ordinal,
        keyMultibase,
        ...(anchor === undefined ? {} : { anchor }),
        anchorIndex: versioned ? anchorIndex : null,
        headAnchorIndex: anchorFloor
      })
    }
    entryAnchorIndex = Math.max(entryAnchorIndex, anchorIndex)
  }
  try {
    // The wire proof type narrows the kernel's (fixed purpose, optional
    // created); the shape check already enforced the profile form.
    await verifyEntryProofs(entry as Parameters<typeof verifyEntryProofs>[0], {
      verifier: defaultWebvhLogVerifier,
      authorize,
      resolveVM: async verificationMethod => ({
        publicKeyMultibase: parseOnce(verificationMethod).keyMultibase
      })
    })
  } catch (err) {
    if (err instanceof ResourceLogIntegrityError) {
      throw err
    }
    throw new ResourceLogIntegrityError(
      `Resource log entry ${ordinal} failed proof verification.`,
      { cause: err }
    )
  }
  // The admission hook: controller-domain append policy (wallet-core's
  // ceremony-tail license on ladder-signed appends), consulted per proof
  // in array order, after membership passed and every proof of the entry
  // verified, and before the anchor floor advances. Signature first, so
  // the hook never sees input from an unverified proof and a forged entry
  // is refused as the integrity class even where the hook would also
  // refuse it. The call sits outside the wrap above: a hook throw keeps
  // its class -- an admission refusal is not evidence of a doctored log,
  // and neither is a hook-internal bug.
  for (const admission of admissions) {
    await controller.admitAppend?.(admission)
  }
  return entryAnchorIndex
}

/**
 * Runs the profile's full verification over a parsed log, in order: parse
 * shape, genesis (SCID recomputation, format identifier), chain-hash
 * recomputation, per-entry proofs, the external-authorization rule with
 * anchor monotonicity, termination, and continuity against the chain-head
 * pin. Throws {@link ResourceLogIntegrityError} on fabrication-class
 * failures, {@link ResourceLogContinuityError} on pin conflicts, and
 * propagates a throw from the controller's `admitAppend` hook with its class
 * intact; any failure rejects the whole log.
 *
 * The controller view is the independently verified controller document --
 * never material served beside the log. An unversioned controller (empty
 * `versionIds`) degrades every anchor rule to current-document verification
 * and requires anchorless proofs.
 *
 * @param options {object}
 * @param options.entries {ResourceLogEntry[]}   the parsed served log
 * @param options.controller {ResourceLogController}   the verified controller
 *   view ({@link webvhResourceLogController})
 * @param options.expectedMethod {string}   the format identifier this caller
 *   expects (`RESOURCE_LOG_METHOD`; also confirmed against any `history`
 *   dispatch hint the caller followed)
 * @param [options.pin] {ResourceLogHeadPin}   the held chain-head pin, when
 *   this client has verified the log before
 * @returns {Promise<VerifiedResourceLog>}
 */
export async function verifyResourceLog({
  entries,
  controller,
  expectedMethod,
  pin
}: {
  entries: ResourceLogEntry[]
  controller: ResourceLogController
  expectedMethod: string
  pin?: ResourceLogHeadPin | null
}): Promise<VerifiedResourceLog> {
  if (entries.length === 0) {
    throw new ResourceLogIntegrityError(
      'The resource log is empty (a log carries at least its genesis entry).'
    )
  }

  // 1. Parse: per-entry shape, parameters rules, ordinal positions.
  entries.forEach((entry, index) => {
    checkEntryShape(entry, index)
  })

  // 2. Genesis: format identifier, then SCID recomputation.
  const genesisParameters = entries[0]!.parameters as {
    method: string
    scid: string
    previousLog?: { scid: string; head: string }
  }
  const { method, scid } = genesisParameters
  if (method !== expectedMethod) {
    throw new ResourceLogIntegrityError(
      `The resource log declares format "${method}", not the expected ` +
        `"${expectedMethod}".`
    )
  }
  const preliminary = substituteScid(
    hashInputOf(entries[0]!, SCID_PLACEHOLDER),
    scid
  )
  if ((await deriveHash(preliminary)) !== scid) {
    throw new ResourceLogIntegrityError(
      'The resource log SCID does not verify against its genesis content.'
    )
  }

  // 3. Chain: recompute every entry hash from the predecessor-substituted
  // input; never accept a stated head.
  let predecessorVersionId = scid
  for (const [index, entry] of entries.entries()) {
    await checkEntryChain({ entry, index, predecessorVersionId })
    predecessorVersionId = entry.versionId
  }

  // 4 + 5. Proofs and authorization, entry by entry, with anchor
  // monotonicity carried along the log.
  const versioned = controller.versionIds.length > 0
  const anchorIndexes = anchorIndexesOf(controller)
  let anchorFloor = 0
  for (const [index, entry] of entries.entries()) {
    anchorFloor = await verifyEntryAgainstFloor({
      entry,
      index,
      controller,
      anchorFloor,
      anchorIndexes,
      versioned
    })
  }

  // 6. Termination: a terminal entry closes the log -- it must be last, must
  // not be the genesis, and must change no state.
  let terminal: { method: string; scid: string } | null = null
  for (const [index, entry] of entries.entries()) {
    if (!isTerminalResourceLogEntry(entry) || index === 0) {
      continue
    }
    if (index !== entries.length - 1) {
      throw new ResourceLogIntegrityError(
        'The resource log continues past a terminal handover entry.'
      )
    }
    checkTerminalState({
      entry,
      predecessorState: entries[index - 1]!.state
    })
    terminal = (
      entry.parameters as { nextLog: { method: string; scid: string } }
    ).nextLog
  }

  // 7. Continuity against the chain-head pin, where one is held.
  const head = entries[entries.length - 1]!
  if (pin) {
    if (pin.method !== method) {
      throw new ResourceLogContinuityError({
        reason: 'method-switch',
        pinnedHead: pin.head
      })
    }
    if (pin.scid !== scid) {
      throw new ResourceLogContinuityError({
        reason: 'scid-switch',
        pinnedHead: pin.head
      })
    }
    const pinnedOrdinal = Number.parseInt(pin.head, 10)
    if (!Number.isInteger(pinnedOrdinal) || pinnedOrdinal < 1) {
      throw new ResourceLogContinuityError({
        reason: 'fork',
        pinnedHead: pin.head,
        servedEntries: entries
      })
    }
    if (entries.length < pinnedOrdinal) {
      throw new ResourceLogContinuityError({
        reason: 'rollback',
        pinnedHead: pin.head
      })
    }
    if (entries[pinnedOrdinal - 1]!.versionId !== pin.head) {
      throw new ResourceLogContinuityError({
        reason: 'fork',
        pinnedHead: pin.head,
        servedEntries: entries
      })
    }
  }

  return {
    entries,
    method,
    scid,
    head,
    state: head.state,
    pin: { method, scid, head: head.versionId },
    headAnchorIndex: versioned ? anchorFloor : null,
    terminal,
    previousLog: genesisParameters.previousLog ?? null
  }
}

/**
 * The write path's pre-write pass: verifies `entry` exactly as a reader would
 * verify it as the next entry of `head`, before anything is written, so an
 * honest writer never sends an entry it would itself refuse on read-back (one
 * refused entry poisons the whole log for every reader, and an appended entry
 * cannot be removed). In order: a closed head is refused with
 * {@link ResourceLogClosedError}; a head verified under an unversioned view
 * handed a versioned `controller`, or the reverse, is refused as
 * {@link ResourceLogIntegrityError} (the head's own entries would fail the
 * anchor-presence rule on read-back); then the entry's shape at its would-be
 * ordinal, its hash chain to the head, its proofs, the authorization rule at
 * the head's anchor floor, the `admitAppend` hook per proof, and, for a
 * terminal candidate, the state-equality rule. Every refusal is the class
 * and message the read path throws, from the same code; a hook refusal keeps
 * the hook's own class. The pass does not mutate `entry` (it is the object
 * the store will serialize).
 *
 * Preconditions: `head` is the value {@link verifyResourceLog} (or
 * `readResourceLog`) returned for the log the CAS validator came from, passed
 * as returned; and the view it was verified against has a `versionIds` list
 * that is a prefix of `controller.versionIds` (an append-only controller log
 * and a resolver that does not regress), since `head.headAnchorIndex` indexes
 * that list. A staler `head` weakens the pass to best effort in both
 * directions; read-back still decides. This is self-protection for the
 * writer, not an authorization boundary, and it does not replace read-back
 * confirmation.
 *
 * @param options {object}
 * @param options.entry {ResourceLogEntry}   the candidate next entry
 * @param options.controller {ResourceLogController}   the writer's verified
 *   controller view, at or past the one `head` was verified with
 * @param options.head {VerifiedResourceLog}   the verified log the candidate
 *   extends
 * @returns {Promise<void>}
 */
export async function verifyResourceLogAppend({
  entry,
  controller,
  head
}: {
  entry: ResourceLogEntry
  controller: ResourceLogController
  head: VerifiedResourceLog
}): Promise<void> {
  if (head.terminal !== null) {
    throw new ResourceLogClosedError({ nextLog: head.terminal })
  }
  const versioned = controller.versionIds.length > 0
  if (versioned !== (head.headAnchorIndex !== null)) {
    throw new ResourceLogIntegrityError(
      versioned
        ? 'The verified head was verified against an unversioned controller; ' +
            'its anchorless entries would fail against this versioned view.'
        : 'The verified head was verified against a versioned controller; ' +
            'its anchored entries would fail against this unversioned view.'
    )
  }
  const index = head.entries.length
  checkEntryShape(entry, index)
  await checkEntryChain({
    entry,
    index,
    predecessorVersionId: head.head.versionId
  })
  await verifyEntryAgainstFloor({
    entry,
    index,
    controller,
    anchorFloor: head.headAnchorIndex ?? 0,
    anchorIndexes: anchorIndexesOf(controller),
    versioned
  })
  if (isTerminalResourceLogEntry(entry)) {
    checkTerminalState({ entry, predecessorState: head.head.state })
  }
}

/**
 * Verifies a handover link from both sides: the prior log's terminal entry
 * and the successor log's genesis back-reference. Both logs must already have
 * passed {@link verifyResourceLog}. Checks: the terminal `nextLog` names the
 * successor's SCID and method; the successor's `previousLog` names the prior
 * log's SCID; and the successor's `previousLog.head` is the `versionId` of
 * the terminal entry's immediate predecessor -- the terminal entry chains
 * directly off the head the successor references. A verified handover is the
 * one transition that replaces a chain-head pin wholesale (the caller stores
 * `successor.pin`).
 *
 * @param options {object}
 * @param options.prior {VerifiedResourceLog}   the closed log
 * @param options.successor {VerifiedResourceLog}   the log its terminal entry
 *   names
 * @returns {void}
 */
export function verifyResourceLogHandover({
  prior,
  successor
}: {
  prior: VerifiedResourceLog
  successor: VerifiedResourceLog
}): void {
  if (!prior.terminal) {
    throw new ResourceLogContinuityError({
      reason: 'scid-switch',
      pinnedHead: prior.pin.head
    })
  }
  const predecessor = prior.entries[prior.entries.length - 2]
  if (
    prior.terminal.scid !== successor.scid ||
    prior.terminal.method !== successor.method ||
    successor.previousLog?.scid !== prior.scid ||
    predecessor === undefined ||
    successor.previousLog.head !== predecessor.versionId
  ) {
    throw new ResourceLogContinuityError({
      reason: 'scid-switch',
      pinnedHead: prior.pin.head,
      servedEntries: successor.entries
    })
  }
}
