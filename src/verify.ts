/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The Resource Log Profile's verification algorithm (App Connect spec,
 * `#log-verification`), end-to-end and fail-closed: entry-shape parse checks,
 * SCID recomputation, chain-hash recomputation (never a stated head), proof
 * verification through the did:webvh log kernel, the external-authorization
 * rule (one controller versionId per entry by distinct signing keys, resolved
 * against the independently verified controller document; every proof's
 * verification method dereferenced to an `assertionMethod` member at that
 * version and verified under the key that member publishes;
 * controller-version monotonicity), the controller port's per-proof `admitAppend` admission
 * hook, terminal-entry recognition, and continuity against the chain-head
 * pin. Any failure rejects the LOG, not just the
 * failing entry, and nothing served -- a stated head, a digest, a count --
 * is ever accepted in place of recomputation. The admission hook runs after
 * the kernel call, once every proof of the entry has verified, outside the
 * integrity wrap: a forged signature is refused as the integrity class
 * whatever the hook would have said, and a hook throw keeps its own class so
 * callers can tell a refused admission from a corrupt log. The per-entry
 * checks are shared with `verifyResourceLogAppend`, the write path's
 * pre-write pass over a candidate entry, so a writer refuses exactly what a
 * reader would refuse.
 *
 * A caller that holds the verifier's own result for an earlier read of the
 * same log may pass it back as `previous`. The served log is then checked to
 * extend that record, every prefix `versionId` equal. The hash chain commits
 * the prefix content to the head already verified, so only the entries past
 * the record go through the per-entry checks. They are chained to the
 * record's head and carried from its controller version. A served log that
 * does not extend the record falls back to the full pass, so every refusal
 * keeps the class and message it has without a record.
 */
import {
  buildVersionId,
  canonicalizeStrict,
  defaultWebvhLogVerifier,
  deriveHash,
  parseAndValidateVersionId,
  replaceValueInObject,
  SCID_PLACEHOLDER,
  verifyEntryProofs
} from '@interop/did-method-webvh'
import type {
  ResourceLogEntry,
  ResourceLogEntryProof
} from '@interop/storage-core'
import type { ResourceLogController } from './controller.js'
import { memberKeyMultibase, relationMemberNamed } from './document.js'
import { resourceLogStateFault, versionIdOrdinal } from './entry.js'
import {
  ResourceLogClosedError,
  ResourceLogContinuityError,
  ResourceLogIntegrityError
} from './errors.js'
import type { ResourceLogHeadPin } from './pin.js'
import { parseVersionedVm } from './vmFragment.js'

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
 * What verification resolves to. `state` is the profile's definition of
 * the resource's current state -- the verified head entry's `state` -- and
 * `pin` is the record the caller must store as its new chain-head pin.
 * `terminal` is the head's `nextLog` when the log is closed by a handover
 * entry (appends must be refused), `previousLog` the genesis back-reference
 * when this log is a handover successor. `headControllerVersionIndex` is the
 * head's effective controller versionId -- the verifier's head controller
 * version after the whole loop, which monotonicity makes the head entry's
 * own controller versionId -- as an index into the controller's `versionIds`
 * (`null` on an unversioned controller, whose entries carry no controller
 * versionId); the sealing sweep compares it against the controller's latest
 * membership change.
 *
 * Also an input: `verifyResourceLogAppend` takes the value as `head` and
 * reads `entries`, `head`, `headControllerVersionIndex`, and `terminal` as
 * one consistent record. Pass it as returned; a caller-built literal is out
 * of contract.
 */
export interface VerifiedResourceLog {
  entries: ResourceLogEntry[]
  method: string
  scid: string
  head: ResourceLogEntry
  state: ResourceLogEntry['state']
  pin: ResourceLogHeadPin
  headControllerVersionIndex: number | null
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
      genesis.scid.length === 0 ||
      (genesis.previousLog !== undefined &&
        (genesis.previousLog === null ||
          typeof genesis.previousLog !== 'object' ||
          typeof genesis.previousLog.scid !== 'string' ||
          typeof genesis.previousLog.head !== 'string' ||
          Object.keys(genesis.previousLog).length !== 2))
    ) {
      throw new ResourceLogIntegrityError(
        'The resource log genesis parameters must carry method and a ' +
          'non-empty scid (plus, on a handover successor only, previousLog) ' +
          'and nothing else.'
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
 * Splits a proof's `verificationMethod` DID URL with the shared codec,
 * refusing the entry when the URL is not the profile's versioned shape.
 *
 * @param verificationMethod {string}
 * @param ordinal {number}   the owning entry's 1-based position
 * @returns {object}
 */
function parseProofVm(
  verificationMethod: string,
  ordinal: number
): NonNullable<ReturnType<typeof parseVersionedVm>> {
  const parsed = parseVersionedVm(verificationMethod)
  if (parsed === undefined) {
    throw new ResourceLogIntegrityError(
      `Resource log entry ${ordinal} has a proof verificationMethod that is ` +
        `not a versioned verification-method DID URL.`
    )
  }
  return parsed
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
 * The controller's `versionId` list as a controller-versionId-to-index map.
 * First index wins on a repeated `versionId`; the port requires the list to
 * be distinct, so the rule only matters for a view that breaks its
 * precondition.
 *
 * @param controller {ResourceLogController}
 * @returns {Map<string, number>}
 */
function versionIndexesOf(
  controller: ResourceLogController
): Map<string, number> {
  const versionIndexes = new Map<string, number>()
  for (const [index, versionId] of controller.versionIds.entries()) {
    if (!versionIndexes.has(versionId)) {
      versionIndexes.set(versionId, index)
    }
  }
  return versionIndexes
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
 * Verifies one entry's proofs and authorization against the head controller
 * version its predecessors established (the per-entry body of verification
 * steps 4 and 5). A pre-pass over the proof array first reduces the entry to
 * one controller versionId by distinct signing keys: per proof the
 * controller DID matches and the versionId is present exactly when the
 * controller is versioned; once per entry every versionId equals the first
 * proof's and names a known controller version at or past the head
 * (controller-version monotonicity); then, against the controller document
 * at that version, each proof's DID URL is dereferenced to an
 * `assertionMethod` member whose published key becomes the proof's signing
 * key, distinct from every earlier proof's. Every proof then goes through
 * the kernel under its key, and the
 * controller's `admitAppend` hook runs per proof for every entry past
 * genesis. Resolves the entry's controller version index, the head
 * controller version for the next entry. Reads `entry` without mutating it.
 *
 * @param options {object}
 * @param options.entry {ResourceLogEntry}
 * @param options.index {number}   the entry's 0-based position
 * @param options.controller {ResourceLogController}
 * @param options.headVersionIndex {number}   the head controller version:
 *   the predecessors' effective controller version as an index
 * @param options.versionIndexes {Map<string, number>}   from
 *   {@link versionIndexesOf}
 * @param options.versioned {boolean}   whether the controller is versioned
 * @returns {Promise<number>}
 */
async function verifyEntryAgainstHead({
  entry,
  index,
  controller,
  headVersionIndex,
  versionIndexes,
  versioned
}: {
  entry: ResourceLogEntry
  index: number
  controller: ResourceLogController
  headVersionIndex: number
  versionIndexes: Map<string, number>
  versioned: boolean
}): Promise<number> {
  const ordinal = index + 1
  // The admission hook's per-proof inputs, recorded during authorization
  // and drained only after every proof of the entry has verified (below).
  const admissions: Array<
    Parameters<NonNullable<ResourceLogController['admitAppend']>>[0]
  > = []
  // Every proof's `verificationMethod` is parsed exactly once, by the
  // pre-pass below; the kernel's `authorize` and `resolveVM` read the same
  // map. A malformed DID URL therefore throws from the pre-pass, before any
  // signature check. The map is keyed on the string and is only a cache:
  // `proofKeys` is built from the array itself, one element per proof.
  const parsed = new Map<string, ReturnType<typeof parseProofVm>>()
  const parseOnce = (
    verificationMethod: string
  ): ReturnType<typeof parseProofVm> => {
    let result = parsed.get(verificationMethod)
    if (result === undefined) {
      result = parseProofVm(verificationMethod, ordinal)
      parsed.set(verificationMethod, result)
    }
    return result
  }
  // The entry's controller versionId (undefined on an unversioned
  // controller), its index (0 when unversioned), and every proof's signing
  // key by verification-method URL in array order -- all settled by the
  // pre-pass before the kernel runs, which reads only settled URLs.
  let entryVersionId: string | undefined
  let entryVersionIndex = 0
  const keysByVm = new Map<string, string>()
  const authorize = async (proof: {
    verificationMethod?: string
  }): Promise<void> => {
    // Membership passed in the pre-pass: the key is the dereferenced
    // member's own, so there is no set to check it against here.
    const keyMultibase = keysByVm.get(proof.verificationMethod ?? '')!
    // Record the admission input for every entry past genesis; the hook
    // itself runs after the kernel call. The head controller version at this
    // point is still the previous entries' effective controller version --
    // the verified head this append extended -- and nothing assigns it before
    // the drain.
    if (index > 0 && controller.admitAppend !== undefined) {
      admissions.push({
        ordinal,
        keyMultibase,
        ...(entryVersionId === undefined
          ? {}
          : { controllerVersionId: entryVersionId }),
        controllerVersionIndex: versioned ? entryVersionIndex : null,
        headControllerVersionIndex: headVersionIndex,
        proofKeys: [...keysByVm.values()]
      })
    }
  }
  try {
    // The pre-pass: the whole-entry view the kernel's per-proof loop never
    // has. It reads parsed DID URLs and the controller document only, so a
    // proof array a host has reordered, duplicated, or deleted from (the
    // array is outside the hash and every signature, and a strict non-empty
    // subset of an entry's proofs still verifies) is refused or accepted on
    // its key set before any signature is checked.
    for (const proof of entry.proof) {
      const { did, controllerVersionId } = parseOnce(proof.verificationMethod)
      if (did !== controller.did) {
        throw new ResourceLogIntegrityError(
          `Resource log entry ${ordinal} is signed under a different ` +
            `controller than this log's account.`
        )
      }
      if (versioned && controllerVersionId === undefined) {
        throw new ResourceLogIntegrityError(
          `Resource log entry ${ordinal} carries no controller versionId ` +
            `against a version-resolvable controller.`
        )
      }
      if (!versioned && controllerVersionId !== undefined) {
        throw new ResourceLogIntegrityError(
          `Resource log entry ${ordinal} carries a controller versionId on ` +
            `an unversioned controller.`
        )
      }
    }
    entryVersionId = parseOnce(
      entry.proof[0]!.verificationMethod
    ).controllerVersionId
    if (
      entry.proof.some(
        proof =>
          parseOnce(proof.verificationMethod).controllerVersionId !==
          entryVersionId
      )
    ) {
      throw new ResourceLogIntegrityError(
        `Resource log entry ${ordinal} carries proofs that disagree on the ` +
          `entry's controller versionId (all proofs of an entry must carry ` +
          `the same controller version).`
      )
    }
    if (entryVersionId !== undefined) {
      const known = versionIndexes.get(entryVersionId)
      if (known === undefined) {
        throw new ResourceLogIntegrityError(
          `Resource log entry ${ordinal} carries an unknown controller ` +
            `document version.`
        )
      }
      entryVersionIndex = known
      if (entryVersionIndex < headVersionIndex) {
        throw new ResourceLogIntegrityError(
          `Resource log entry ${ordinal} carries a controller versionId ` +
            `behind its predecessor (controller versionIds must be monotone ` +
            `along the log).`
        )
      }
    }
    // Dereference each proof's DID URL to the `assertionMethod` member
    // `${did}#${fragment}` of the document at the entry's controller
    // version. The fragment is an opaque selector; the member's published
    // key is what the proof is verified under. A URL naming no member with
    // a key refuses, as does a key repeated across proofs under any
    // fragments.
    const doc = await controller.documentAt(entryVersionId)
    for (const proof of entry.proof) {
      const { did, fragment } = parseOnce(proof.verificationMethod)
      const member = relationMemberNamed({
        doc,
        relation: 'assertionMethod',
        did,
        fragment
      })
      const keyMultibase = member && memberKeyMultibase(member)
      if (keyMultibase === undefined) {
        throw new ResourceLogIntegrityError(
          `Resource log entry ${ordinal} carries a proof whose verification ` +
            `method the controller document does not list under ` +
            `assertionMethod at the controller version.`
        )
      }
      if ([...keysByVm.values()].includes(keyMultibase)) {
        throw new ResourceLogIntegrityError(
          `Resource log entry ${ordinal} carries two proofs by one signing ` +
            `key.`
        )
      }
      keysByVm.set(proof.verificationMethod, keyMultibase)
    }
    // The wire proof type narrows the kernel's (fixed purpose, optional
    // created); the shape check already enforced the profile form.
    await verifyEntryProofs(entry as Parameters<typeof verifyEntryProofs>[0], {
      verifier: defaultWebvhLogVerifier,
      authorize,
      resolveVM: async verificationMethod => ({
        publicKeyMultibase: keysByVm.get(verificationMethod)!
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
  // verified, and before the head controller version advances. Signature
  // first, so the hook never sees input from an unverified proof and a
  // forged entry is refused as the integrity class even where the hook
  // would also refuse it; the same holds per entry, since every key in
  // `proofKeys` belongs to a proof of this entry that verified through the
  // kernel and passed membership. That property depends on the drain
  // sitting here, after `verifyEntryProofs` returns and the kernel has
  // thrown on any failing proof; moving it inside the wrap above would
  // break it. The call sits outside the wrap: a hook throw keeps its class
  // -- an admission refusal is not evidence of a doctored log, and neither
  // is a hook-internal bug.
  for (const admission of admissions) {
    await controller.admitAppend?.(admission)
  }
  return entryVersionIndex
}

/**
 * Runs the profile's verification over a parsed log, in order: parse shape,
 * genesis (SCID recomputation, format identifier), chain-hash recomputation,
 * per-entry proofs, the external-authorization rule with controller-version
 * monotonicity, termination, and continuity against the chain-head pin.
 * Throws {@link ResourceLogIntegrityError} on fabrication-class failures,
 * {@link ResourceLogContinuityError} on pin conflicts, and propagates a throw
 * from the controller's `admitAppend` hook with its class intact; any failure
 * rejects the whole log.
 *
 * With `previous`, the caller's own earlier result for the same log, a served
 * log that extends the record is verified from the record's head on. The
 * steps above then run over the entries added since the record only, and the
 * genesis step is the record's own. A served log that does not extend the
 * record is verified in full.
 *
 * The controller view is the independently verified controller document --
 * never material served beside the log. An unversioned controller (empty
 * `versionIds`) degrades every controller-version rule to current-document
 * verification and requires proofs that carry no controller versionId.
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
 * @param [options.previous] {VerifiedResourceLog}   this caller's own
 *   result from an earlier verification of the same log, passed as returned.
 *   A served log extending it is verified from its head on; one that does
 *   not is verified in full, as is a record whose head controller version
 *   is not at its index of `controller.versionIds`
 * @returns {Promise<VerifiedResourceLog>}
 */
export async function verifyResourceLog({
  entries,
  controller,
  expectedMethod,
  pin,
  previous
}: {
  entries: ResourceLogEntry[]
  controller: ResourceLogController
  expectedMethod: string
  pin?: ResourceLogHeadPin | null
  previous?: VerifiedResourceLog | null
}): Promise<VerifiedResourceLog> {
  if (entries.length === 0) {
    throw new ResourceLogIntegrityError(
      'The resource log is empty (a log carries at least its genesis entry).'
    )
  }
  // The record to resume from, when the served log extends it, else `null`
  // for the full pass. The served prefix is matched by `versionId` alone.
  // Each `versionId` commits its entry's content and its predecessor's
  // `versionId`, so equal `versionId`s mean the content verified before. The
  // result is built from the record's own entries, so no served prefix bytes
  // are handed out unverified. The proofs of a prefix entry are outside its
  // hash and are not re-checked: they verified when the record was built.
  const resumed = resumeFrom({ previous, entries, controller, expectedMethod })
  const start = resumed?.entries.length ?? 0

  // 1. Parse: per-entry shape, parameters rules, ordinal positions.
  for (let index = start; index < entries.length; index++) {
    checkEntryShape(entries[index]!, index)
  }

  // 2. Genesis: format identifier, then SCID recomputation. A resumed pass
  // takes the genesis facts from the record.
  const genesisParameters = entries[0]!.parameters as {
    method: string
    scid: string
    previousLog?: { scid: string; head: string }
  }
  const genesis = resumed ?? {
    method: genesisParameters.method,
    scid: genesisParameters.scid,
    previousLog: genesisParameters.previousLog ?? null
  }
  const { method, scid } = genesis
  if (method !== expectedMethod) {
    throw new ResourceLogIntegrityError(
      `The resource log declares format "${method}", not the expected ` +
        `"${expectedMethod}".`
    )
  }
  if (resumed === null) {
    // The inverse of genesis construction: every occurrence of the SCID in
    // every string of the hash input (the kernel's substitution, so a SCID
    // embedded in a longer value substitutes the same way it was placed).
    const preliminary = replaceValueInObject(
      hashInputOf(entries[0]!, SCID_PLACEHOLDER),
      scid,
      SCID_PLACEHOLDER
    )
    if ((await deriveHash(preliminary)) !== scid) {
      throw new ResourceLogIntegrityError(
        'The resource log SCID does not verify against its genesis content.'
      )
    }
  }

  // 3 to 6. Chain, proofs, authorization, and termination over the entries
  // past the resume point, from the SCID or from the record's verified head.
  const tailEntries = entries.slice(start)
  const tail = await verifyTail({
    entries: tailEntries,
    previous: resumed,
    scid,
    controller
  })

  // The verified log: the record's entries, when resumed, then the entries
  // verified above.
  const verifiedEntries = [...(resumed?.entries ?? []), ...tailEntries]

  // 7. Continuity against the chain-head pin, where one is held.
  const head = verifiedEntries[verifiedEntries.length - 1]!
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
    const pinnedOrdinal = versionIdOrdinal(pin.head)
    if (pinnedOrdinal !== undefined && entries.length < pinnedOrdinal) {
      throw new ResourceLogContinuityError({
        reason: 'rollback',
        pinnedHead: pin.head
      })
    }
    // A pinned head that carries no ordinal cannot be located in the served
    // log at all, so it is refused as the served log having forked away from
    // it, the same way a head that is not at its ordinal is.
    if (
      pinnedOrdinal === undefined ||
      entries[pinnedOrdinal - 1]!.versionId !== pin.head
    ) {
      throw new ResourceLogContinuityError({
        reason: 'fork',
        pinnedHead: pin.head,
        servedEntries: entries
      })
    }
  }

  return {
    entries: verifiedEntries,
    method,
    scid,
    head,
    state: head.state,
    pin: { method, scid, head: head.versionId },
    headControllerVersionIndex: tail.headControllerVersionIndex,
    terminal: tail.terminal,
    previousLog: genesis.previousLog
  }
}

/**
 * The record to resume a pass from: `previous` when the served log extends
 * it, else `null`. The record must declare the expected format and must have
 * been verified under the same versioned-or-not kind of controller view (its
 * head controller version index means nothing under the other kind). Under a
 * versioned view, the record's head controller version (the controller
 * versionId its head proof carries) must sit at that index of this view's
 * `versionIds`, so the index the tail is carried from names the same version
 * here. The served log must be at least as long as the record with every
 * prefix `versionId` equal. Anything else is a log the record does not
 * describe, verified in full, so a fork, rollback, or fabrication against the
 * record refuses exactly as it would without one.
 *
 * @param options {object}
 * @param [options.previous] {VerifiedResourceLog}
 * @param options.entries {ResourceLogEntry[]}   the served log
 * @param options.controller {ResourceLogController}
 * @param options.expectedMethod {string}
 * @returns {VerifiedResourceLog | null}
 */
function resumeFrom({
  previous,
  entries,
  controller,
  expectedMethod
}: {
  previous?: VerifiedResourceLog | null
  entries: ResourceLogEntry[]
  controller: ResourceLogController
  expectedMethod: string
}): VerifiedResourceLog | null {
  if (!previous || previous.method !== expectedMethod) {
    return null
  }
  const headIndex = previous.headControllerVersionIndex
  if ((headIndex !== null) !== controller.versionIds.length > 0) {
    return null
  }
  if (headIndex !== null) {
    const headVersionId = parseVersionedVm(
      previous.head.proof[0]?.verificationMethod ?? ''
    )?.controllerVersionId
    // An index past this view's list reads `undefined`, so a missing head
    // version must not match it.
    if (
      headVersionId === undefined ||
      controller.versionIds[headIndex] !== headVersionId
    ) {
      return null
    }
  }
  const extended =
    entries.length >= previous.entries.length &&
    previous.entries.every(
      (entry, index) => entries[index]!.versionId === entry.versionId
    )
  return extended ? previous : null
}

/**
 * Verifies the entries past a verified point of a log, as the read path
 * verifies them: every entry's hash chain to its predecessor, then every
 * entry's proofs and the authorization rule with controller-version
 * monotonicity carried from the predecessor, then the termination rule (a
 * terminal entry must be last, must not be the genesis, and must change no
 * state). A terminal predecessor admits no entry. Shape is checked by the
 * caller first, since the read path's genesis step sits between shape and
 * chain.
 *
 * @param options {object}
 * @param options.entries {ResourceLogEntry[]}   the entries to verify, in
 *   log order
 * @param options.previous {VerifiedResourceLog | null}   the verified log the
 *   entries extend; `null` when they start at the genesis
 * @param options.scid {string}   the log's SCID (the genesis predecessor)
 * @param options.controller {ResourceLogController}
 * @returns {Promise<object>}   the controller version at the last entry as an
 *   index into `controller.versionIds` (`null` when unversioned), and the
 *   `nextLog` of a terminal head (`null` otherwise)
 */
async function verifyTail({
  entries,
  previous,
  scid,
  controller
}: {
  entries: ResourceLogEntry[]
  previous: VerifiedResourceLog | null
  scid: string
  controller: ResourceLogController
}): Promise<{
  headControllerVersionIndex: number | null
  terminal: { method: string; scid: string } | null
}> {
  if (previous?.terminal && entries.length > 0) {
    throw new ResourceLogIntegrityError(
      'The resource log continues past a terminal handover entry.'
    )
  }
  const start = previous?.entries.length ?? 0
  const versioned = controller.versionIds.length > 0

  // 3. Chain: recompute every entry hash from the predecessor-substituted
  // input; never accept a stated head.
  let predecessorVersionId = previous?.head.versionId ?? scid
  for (const [offset, entry] of entries.entries()) {
    await checkEntryChain({
      entry,
      index: start + offset,
      predecessorVersionId
    })
    predecessorVersionId = entry.versionId
  }

  // 4 + 5. Proofs and authorization, entry by entry, with controller-version
  // monotonicity carried along the log.
  const versionIndexes = versionIndexesOf(controller)
  let headVersionIndex = previous?.headControllerVersionIndex ?? 0
  for (const [offset, entry] of entries.entries()) {
    headVersionIndex = await verifyEntryAgainstHead({
      entry,
      index: start + offset,
      controller,
      headVersionIndex,
      versionIndexes,
      versioned
    })
  }

  // 6. Termination: a terminal entry closes the log -- it must be last, must
  // not be the genesis, and must change no state.
  let terminal = previous?.terminal ?? null
  let predecessorState = previous?.head.state
  for (const [offset, entry] of entries.entries()) {
    if (isTerminalResourceLogEntry(entry) && start + offset > 0) {
      if (offset !== entries.length - 1) {
        throw new ResourceLogIntegrityError(
          'The resource log continues past a terminal handover entry.'
        )
      }
      checkTerminalState({ entry, predecessorState: predecessorState! })
      terminal = (
        entry.parameters as { nextLog: { method: string; scid: string } }
      ).nextLog
    }
    predecessorState = entry.state
  }
  return {
    headControllerVersionIndex: versioned ? headVersionIndex : null,
    terminal
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
 * controller-versionId-presence rule on read-back); then the entry's shape at
 * its would-be ordinal, its hash chain to the head, its proofs, the
 * authorization rule at the head controller version, the `admitAppend` hook per
 * proof, and, for a terminal candidate, the state-equality rule. Every
 * refusal is the class and message the read path throws, from the same code;
 * a hook refusal keeps the hook's own class. The pass does not mutate `entry`
 * (it is the object the store will serialize).
 *
 * Preconditions: `head` is the value {@link verifyResourceLog} (or
 * `readResourceLog`) returned for the log the CAS validator came from, passed
 * as returned; and the view it was verified against has a `versionIds` list
 * that is a prefix of `controller.versionIds` (an append-only controller log
 * and a resolver that does not regress), since `head.headControllerVersionIndex`
 * indexes that list. A staler `head` weakens the pass to best effort in both
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
  if (versioned !== (head.headControllerVersionIndex !== null)) {
    throw new ResourceLogIntegrityError(
      versioned
        ? 'The verified head was verified against an unversioned controller; ' +
            'its entries carrying no controller versionId would fail against ' +
            'this versioned view.'
        : 'The verified head was verified against a versioned controller; ' +
            'its versioned entries would fail against this unversioned view.'
    )
  }
  checkEntryShape(entry, head.entries.length)
  await verifyTail({
    entries: [entry],
    previous: head,
    scid: head.scid,
    controller
  })
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
