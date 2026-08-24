/**
 * Adversarial unit tests for the resource-log verifier
 * (`src/verify.ts`): the WC-1 provenance properties re-proven
 * against the log design. A fabricated log (attacker-signed, tampered state,
 * broken chain, forged SCID) is refused as integrity failure; a served log
 * that verifies but conflicts with the chain-head pin (rollback, fork with
 * evidence retention, SCID/method switch) is refused as continuity failure;
 * the external-authorization rule is checked at the controller version with
 * controller-version monotonicity (the revoked-signer-after-seal case); a
 * multi-proof entry carries one controller versionId by distinct signing keys
 * (proofs that disagree, or a repeated key, refuse the log before any
 * signature is checked, and every key's membership is checked at that one
 * version); terminal handover entries close the log; and handover links
 * verify from both sides.
 */
import { describe, expect, it } from 'vitest'
import { buildVersionId, deriveHash } from '@interop/did-method-webvh'
import type { ResourceLogEntry } from '@interop/storage-core'
import {
  buildResourceLogEntry,
  buildResourceLogGenesis,
  isTerminalResourceLogEntry,
  memoryResourceLogPinStore,
  readResourceLog,
  resourceLogPinId,
  ResourceLogContinuityError,
  ResourceLogIntegrityError,
  verifyResourceLog,
  verifyResourceLogAppend,
  verifyResourceLogHandover,
  type ResourceLogController
} from '../../src/index.js'
import {
  CONTROLLER_DID,
  fakeController,
  memoryLogStore
} from '../../src/testing.js'
import {
  buildTerminalEntry,
  coSignEntry,
  makeLogClient
} from './fixtures/log.js'

const METHOD = 'resource-log:0.1'

/**
 * A two-entry log written by one enrolled client against a single-version
 * controller -- the positive baseline most cases below start from.
 */
async function makeBaselineLog() {
  const alice = await makeLogClient()
  const controller = fakeController({
    versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }]
  })
  const genesis = await buildResourceLogGenesis({
    state: { type: 'TestState', value: 1 },
    method: METHOD,
    controller,
    signer: alice.logSigner
  })
  const second = await buildResourceLogEntry({
    head: genesis,
    state: { type: 'TestState', value: 2 },
    controller,
    signer: alice.logSigner
  })
  return { alice, controller, genesis, second, entries: [genesis, second] }
}

describe('verifyResourceLog (positive paths)', () => {
  it('verifies a genesis + append round-trip and resolves head state and pin', async () => {
    const { controller, entries, genesis, second } = await makeBaselineLog()
    const verified = await verifyResourceLog({
      entries,
      controller,
      expectedMethod: METHOD
    })
    expect(verified.method).toBe(METHOD)
    expect(verified.scid).toBe((genesis.parameters as { scid: string }).scid)
    expect(verified.head).toEqual(second)
    expect(verified.state).toEqual({ type: 'TestState', value: 2 })
    expect(verified.pin).toEqual({
      method: METHOD,
      scid: verified.scid,
      head: second.versionId
    })
    expect(verified.terminal).toBeNull()
    expect(verified.previousLog).toBeNull()
  })

  it('accepts a served log that extends the pinned history', async () => {
    const { controller, entries, genesis } = await makeBaselineLog()
    const afterGenesis = await verifyResourceLog({
      entries: [genesis],
      controller,
      expectedMethod: METHOD
    })
    const verified = await verifyResourceLog({
      entries,
      controller,
      expectedMethod: METHOD,
      pin: afterGenesis.pin
    })
    expect(verified.pin.head).toBe(entries[1]!.versionId)
  })

  it('verifies an unversioned-controller log with unversioned proofs', async () => {
    const alice = await makeLogClient()
    const controller = fakeController({
      versions: [],
      currentKeys: [alice.signingKeyMultibase]
    })
    const genesis = await buildResourceLogGenesis({
      state: { type: 'TestState', value: 1 },
      method: METHOD,
      controller,
      signer: alice.logSigner
    })
    expect(genesis.proof[0]!.verificationMethod).toBe(
      `${CONTROLLER_DID}#${alice.signingKeyMultibase}`
    )
    const verified = await verifyResourceLog({
      entries: [genesis],
      controller,
      expectedMethod: METHOD
    })
    expect(verified.state).toEqual({ type: 'TestState', value: 1 })
  })
})

describe('verifyResourceLog (fabrication refusals)', () => {
  it('refuses an empty log', async () => {
    const { controller } = await makeBaselineLog()
    await expect(
      verifyResourceLog({ entries: [], controller, expectedMethod: METHOD })
    ).rejects.toThrow(ResourceLogIntegrityError)
  })

  it('refuses a log declaring a different format identifier', async () => {
    const { controller, entries } = await makeBaselineLog()
    await expect(
      verifyResourceLog({
        entries,
        controller,
        expectedMethod: 'some-other-log:1.0'
      })
    ).rejects.toThrow(/declares format/)
  })

  it('refuses a genesis whose SCID does not recompute', async () => {
    const { controller, genesis } = await makeBaselineLog()
    const forged = structuredClone(genesis)
    ;(forged.parameters as { scid: string }).scid = 'QmForgedScid'
    await expect(
      verifyResourceLog({
        entries: [forged],
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/SCID does not verify/)
  })

  it('refuses a tampered entry state (the proof no longer verifies)', async () => {
    const { controller, entries, genesis } = await makeBaselineLog()
    const tampered = structuredClone(entries)
    // Re-chain the hash over the tampered state so the failure isolates to
    // the proof: the attacker can recompute hashes, never signatures.
    tampered[1]!.state = { type: 'TestState', value: 999 }
    const rehash = await deriveHash({
      versionId: genesis.versionId,
      versionTime: tampered[1]!.versionTime,
      parameters: tampered[1]!.parameters,
      state: tampered[1]!.state
    })
    tampered[1]!.versionId = buildVersionId(2, rehash)
    await expect(
      verifyResourceLog({
        entries: tampered,
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/failed proof verification/)
  })

  it('refuses a broken hash chain (a stated head is never accepted)', async () => {
    const { controller, entries } = await makeBaselineLog()
    const tampered = structuredClone(entries)
    tampered[1]!.versionId = '2-QmNotTheRealHash'
    await expect(
      verifyResourceLog({
        entries: tampered,
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/hash-chain/)
  })

  it('refuses a spliced entry forged atop a legitimate prefix', async () => {
    // The attacker holds a real key pair, correctly hash-chains its entry onto
    // the served log, and signs it -- but the controller document backs no
    // such key, so the external-authorization rule refuses the whole log.
    const { controller, genesis } = await makeBaselineLog()
    const attacker = await makeLogClient()
    const attackerView = fakeController({
      versions: [{ versionId: '1-v1', keys: [attacker.signingKeyMultibase] }]
    })
    const spliced = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 666 },
      controller: attackerView,
      signer: attacker.logSigner
    })
    await expect(
      verifyResourceLog({
        entries: [genesis, spliced],
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/does not list under assertionMethod/)
  })

  it('refuses an entry signed under a different controller DID', async () => {
    const { alice, genesis } = await makeBaselineLog()
    const otherController = fakeController({
      did: 'did:webvh:QmOther:example.com:space:xyz:id',
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }]
    })
    await expect(
      verifyResourceLog({
        entries: [genesis],
        controller: otherController,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/different controller/)
  })

  it('refuses an unversioned proof against a versioned controller', async () => {
    const alice = await makeLogClient()
    const unversioned = fakeController({
      versions: [],
      currentKeys: [alice.signingKeyMultibase]
    })
    const genesis = await buildResourceLogGenesis({
      state: { type: 'TestState', value: 1 },
      method: METHOD,
      controller: unversioned,
      signer: alice.logSigner
    })
    const versioned = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }]
    })
    await expect(
      verifyResourceLog({
        entries: [genesis],
        controller: versioned,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/no controller versionId/)
  })

  it('refuses a versioned proof against an unversioned controller', async () => {
    const { alice, genesis } = await makeBaselineLog()
    const unversioned = fakeController({
      versions: [],
      currentKeys: [alice.signingKeyMultibase]
    })
    await expect(
      verifyResourceLog({
        entries: [genesis],
        controller: unversioned,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/unversioned controller/)
  })

  it('refuses a controller versionId naming an unknown controller version', async () => {
    const { alice, genesis } = await makeBaselineLog()
    const otherVersions = fakeController({
      versions: [
        { versionId: '1-elsewhere', keys: [alice.signingKeyMultibase] }
      ]
    })
    await expect(
      verifyResourceLog({
        entries: [genesis],
        controller: otherVersions,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/unknown controller/)
  })

  it('refuses a revoked signer whose controller versionId is behind the seal (controller-version monotonicity)', async () => {
    // Controller v1 backs alice AND bob; v2 drops bob (the revocation edit).
    // Alice's sealing append carries controller version v2; bob then appends
    // carrying controller version v1, where his key still has membership --
    // monotonicity is what refuses it.
    const alice = await makeLogClient()
    const bob = await makeLogClient()
    const v1Only = fakeController({
      versions: [
        {
          versionId: '1-v1',
          keys: [alice.signingKeyMultibase, bob.signingKeyMultibase]
        }
      ]
    })
    const both = fakeController({
      versions: [
        {
          versionId: '1-v1',
          keys: [alice.signingKeyMultibase, bob.signingKeyMultibase]
        },
        { versionId: '2-v2', keys: [alice.signingKeyMultibase] }
      ]
    })
    const genesis = await buildResourceLogGenesis({
      state: { type: 'TestState', value: 1 },
      method: METHOD,
      controller: v1Only,
      signer: alice.logSigner
    })
    const seal = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller: both,
      signer: alice.logSigner
    })
    const behindSeal = await buildResourceLogEntry({
      head: seal,
      state: { type: 'TestState', value: 3 },
      controller: v1Only,
      signer: bob.logSigner
    })
    // The sealed prefix itself verifies...
    await expect(
      verifyResourceLog({
        entries: [genesis, seal],
        controller: both,
        expectedMethod: METHOD
      })
    ).resolves.toBeDefined()
    // ...and bob's v1-versioned continuation is refused.
    await expect(
      verifyResourceLog({
        entries: [genesis, seal, behindSeal],
        controller: both,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/monotone/)
  })
})

describe('verifyResourceLog (parse-shape refusals)', () => {
  it('refuses an entry with extra or missing members', async () => {
    const { controller, entries } = await makeBaselineLog()
    const extra = structuredClone(entries)
    ;(extra[1] as unknown as Record<string, unknown>).extra = true
    await expect(
      verifyResourceLog({ entries: extra, controller, expectedMethod: METHOD })
    ).rejects.toThrow(/five members/)

    const missing = structuredClone(entries) as unknown as Array<
      Record<string, unknown>
    >
    delete missing[1]!.versionTime
    await expect(
      verifyResourceLog({
        entries: missing as unknown as ResourceLogEntry[],
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/five members/)
  })

  it('refuses parameters the profile does not define for the position (fail-closed)', async () => {
    const { controller, entries } = await makeBaselineLog()
    const tampered = structuredClone(entries)
    // The deleted did:webvh key-management parameters in particular.
    tampered[1]!.parameters = { updateKeys: [] } as never
    await expect(
      verifyResourceLog({
        entries: tampered,
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/does not define for its position/)
  })

  it('refuses a state without a type schema identifier', async () => {
    const { controller, entries } = await makeBaselineLog()
    const tampered = structuredClone(entries)
    delete (tampered[1]!.state as { type?: string }).type
    await expect(
      verifyResourceLog({
        entries: tampered,
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/state.type/)
  })

  it('refuses a state carrying the projection-only history member', async () => {
    const { controller, entries } = await makeBaselineLog()
    const tampered = structuredClone(entries)
    ;(tampered[1]!.state as Record<string, unknown>).history = {
      method: METHOD,
      resource: 'https://example.com/log'
    }
    await expect(
      verifyResourceLog({
        entries: tampered,
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/history/)
  })

  it('refuses a malformed versionTime', async () => {
    const { controller, entries } = await makeBaselineLog()
    const tampered = structuredClone(entries)
    tampered[1]!.versionTime = 'not-a-timestamp'
    await expect(
      verifyResourceLog({
        entries: tampered,
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/versionTime/)
  })

  it('refuses an entry with no proof array', async () => {
    const { controller, entries } = await makeBaselineLog()
    const tampered = structuredClone(entries)
    tampered[1]!.proof = []
    await expect(
      verifyResourceLog({
        entries: tampered,
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/no proof array/)
  })

  it("refuses a proof outside the profile's fixed shape", async () => {
    const { controller, entries } = await makeBaselineLog()
    const tampered = structuredClone(entries)
    // The shape check runs before signature verification, so this refuses
    // on the shape message rather than a later hash or signature failure.
    tampered[1]!.proof[0]!.proofPurpose = 'authentication' as never
    await expect(
      verifyResourceLog({
        entries: tampered,
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/fixed shape/)
  })

  it('refuses a non-object parameters member', async () => {
    const { controller, entries } = await makeBaselineLog()
    const nullParameters = structuredClone(entries)
    nullParameters[1]!.parameters = null as never
    await expect(
      verifyResourceLog({
        entries: nullParameters,
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/non-object parameters member/)

    const stringParameters = structuredClone(entries)
    stringParameters[1]!.parameters = 'not-an-object' as never
    await expect(
      verifyResourceLog({
        entries: stringParameters,
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/non-object parameters member/)
  })

  it('refuses a proof verificationMethod that is not a versioned DID URL', async () => {
    const { controller, entries } = await makeBaselineLog()
    const tampered = structuredClone(entries)
    // No `#` fragment at all, so parseVersionedVm returns undefined; the
    // proof otherwise keeps its fixed shape, so this fires past the shape
    // check and inside the per-proof pre-pass.
    tampered[1]!.proof[0]!.verificationMethod = 'not-a-did-url'
    await expect(
      verifyResourceLog({
        entries: tampered,
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/not a versioned verification-method DID URL/)
  })
})

describe('verifyResourceLog (continuity against the chain-head pin)', () => {
  it('refuses a stale-head replay (rollback behind the pin)', async () => {
    const { controller, entries, genesis } = await makeBaselineLog()
    const full = await verifyResourceLog({
      entries,
      controller,
      expectedMethod: METHOD
    })
    await expect(
      verifyResourceLog({
        entries: [genesis],
        controller,
        expectedMethod: METHOD,
        pin: full.pin
      })
    ).rejects.toMatchObject({
      name: 'ResourceLogContinuityError',
      reason: 'rollback'
    })
  })

  it('refuses a fork off the pinned history and retains the served evidence', async () => {
    const { alice, controller, entries, genesis } = await makeBaselineLog()
    const full = await verifyResourceLog({
      entries,
      controller,
      expectedMethod: METHOD
    })
    // The host serves an alternate second entry: internally consistent,
    // legitimately signed, but not the history this client pinned.
    const forkedSecond = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 42 },
      controller,
      signer: alice.logSigner
    })
    const forked = [genesis, forkedSecond]
    let refusal: unknown
    try {
      await verifyResourceLog({
        entries: forked,
        controller,
        expectedMethod: METHOD,
        pin: full.pin
      })
    } catch (err) {
      refusal = err
    }
    expect(refusal).toBeInstanceOf(ResourceLogContinuityError)
    const continuity = refusal as ResourceLogContinuityError
    expect(continuity.reason).toBe('fork')
    expect(continuity.pinnedHead).toBe(full.pin.head)
    // Both logs are signed: the served entries ride along as transferable
    // evidence of equivocation.
    expect(continuity.servedEntries).toEqual(forked)
  })

  it('refuses a pinned head with no ordinal as a fork, retaining served evidence', async () => {
    const { controller, entries } = await makeBaselineLog()
    const full = await verifyResourceLog({
      entries,
      controller,
      expectedMethod: METHOD
    })
    // A pin whose head carries no leading 1-based ordinal cannot be located
    // in the served log at all, so it is refused the same way a genuine
    // fork is: as continuity 'fork', with the served entries retained.
    const unordinalPin = { ...full.pin, head: 'not-an-ordinal' }
    let refusal: unknown
    try {
      await verifyResourceLog({
        entries,
        controller,
        expectedMethod: METHOD,
        pin: unordinalPin
      })
    } catch (err) {
      refusal = err
    }
    expect(refusal).toBeInstanceOf(ResourceLogContinuityError)
    const continuity = refusal as ResourceLogContinuityError
    expect(continuity.reason).toBe('fork')
    expect(continuity.pinnedHead).toBe(unordinalPin.head)
    expect(continuity.servedEntries).toEqual(entries)
  })

  it('refuses an SCID switch under the pinned location', async () => {
    const { alice, controller, entries } = await makeBaselineLog()
    const full = await verifyResourceLog({
      entries,
      controller,
      expectedMethod: METHOD
    })
    const replacement = await buildResourceLogGenesis({
      state: { type: 'TestState', value: 1 },
      method: METHOD,
      controller,
      signer: alice.logSigner,
      versionTime: '2026-01-02T03:04:05Z'
    })
    await expect(
      verifyResourceLog({
        entries: [replacement],
        controller,
        expectedMethod: METHOD,
        pin: full.pin
      })
    ).rejects.toMatchObject({
      name: 'ResourceLogContinuityError',
      reason: 'scid-switch'
    })
  })

  it('refuses a method switch under the pinned location', async () => {
    const { controller, entries } = await makeBaselineLog()
    const full = await verifyResourceLog({
      entries,
      controller,
      expectedMethod: METHOD
    })
    await expect(
      verifyResourceLog({
        entries,
        controller,
        expectedMethod: METHOD,
        pin: { ...full.pin, method: 'some-other-log:1.0' }
      })
    ).rejects.toMatchObject({
      name: 'ResourceLogContinuityError',
      reason: 'method-switch'
    })
  })
})

describe('terminal handover entries', () => {
  it('recognizes and verifies a well-formed terminal entry', async () => {
    const { alice, controller, entries, second } = await makeBaselineLog()
    const terminal = await buildTerminalEntry({
      head: second,
      nextLog: { method: METHOD, scid: 'QmSuccessorScid' },
      controller,
      signer: alice.logSigner
    })
    expect(isTerminalResourceLogEntry(terminal)).toBe(true)
    const verified = await verifyResourceLog({
      entries: [...entries, terminal],
      controller,
      expectedMethod: METHOD
    })
    expect(verified.terminal).toEqual({
      method: METHOD,
      scid: 'QmSuccessorScid'
    })
    // The closed log's state is still the (unchanged) head state.
    expect(verified.state).toEqual(second.state)
  })

  it('refuses a log continuing past a terminal entry', async () => {
    const { alice, controller, entries, second } = await makeBaselineLog()
    const terminal = await buildTerminalEntry({
      head: second,
      nextLog: { method: METHOD, scid: 'QmSuccessorScid' },
      controller,
      signer: alice.logSigner
    })
    const past = await buildResourceLogEntry({
      head: terminal,
      state: { type: 'TestState', value: 3 },
      controller,
      signer: alice.logSigner
    })
    await expect(
      verifyResourceLog({
        entries: [...entries, terminal, past],
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/continues past a terminal/)
  })

  it('refuses a terminal entry that changes the resource state', async () => {
    const { alice, controller, entries, second } = await makeBaselineLog()
    // Correctly hash-chained and signed over a differing state, so only the
    // state-equality rule can refuse it.
    const differing = await buildTerminalEntryWithState({
      head: second,
      state: { type: 'TestState', value: 777 },
      nextLog: { method: METHOD, scid: 'QmSuccessorScid' },
      controller,
      signer: alice.logSigner
    })
    await expect(
      verifyResourceLog({
        entries: [...entries, differing],
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/changes no resource state/)
  })
})

/**
 * A terminal entry whose state deliberately differs from its predecessor's --
 * hash-chained and signed correctly so the state-equality rule alone refuses
 * it.
 */
async function buildTerminalEntryWithState({
  head,
  state,
  nextLog,
  controller,
  signer
}: {
  head: ResourceLogEntry
  state: ResourceLogEntry['state']
  nextLog: { method: string; scid: string }
  controller: ResourceLogController
  signer: Parameters<typeof buildTerminalEntry>[0]['signer']
}): Promise<ResourceLogEntry> {
  const entry = await buildTerminalEntry({
    head: { ...head, state },
    nextLog,
    controller,
    signer
  })
  return entry
}

describe('verifyResourceLogHandover', () => {
  /**
   * A closed prior log and its verified successor, linked per the profile:
   * the terminal entry names the successor's SCID/method, the successor's
   * genesis carries `previousLog` naming the prior SCID and the terminal
   * entry's immediate predecessor.
   */
  async function makeHandover() {
    const { alice, controller, entries, second, genesis } =
      await makeBaselineLog()
    const successorGenesisOf = async (previousLog: {
      scid: string
      head: string
    }) =>
      buildResourceLogGenesis({
        state: { type: 'TestState', value: 2 },
        method: METHOD,
        controller,
        signer: alice.logSigner,
        previousLog
      })
    const priorScid = (genesis.parameters as { scid: string }).scid
    const successorGenesis = await successorGenesisOf({
      scid: priorScid,
      head: second.versionId
    })
    const successorScid = (successorGenesis.parameters as { scid: string }).scid
    // The prior log closes NAMING the successor, then one more entry lands on
    // the successor -- the terminal chains off `second`, and `previousLog.head`
    // must equal the terminal's immediate predecessor (`second`).
    const terminal = await buildTerminalEntry({
      head: second,
      nextLog: { method: METHOD, scid: successorScid },
      controller,
      signer: alice.logSigner
    })
    const prior = await verifyResourceLog({
      entries: [...entries, terminal],
      controller,
      expectedMethod: METHOD
    })
    const successor = await verifyResourceLog({
      entries: [successorGenesis],
      controller,
      expectedMethod: METHOD
    })
    return { alice, controller, prior, successor, successorGenesisOf }
  }

  it('verifies a well-linked handover', async () => {
    const { prior, successor } = await makeHandover()
    expect(() => verifyResourceLogHandover({ prior, successor })).not.toThrow()
    expect(successor.previousLog).toEqual({
      scid: prior.scid,
      head: prior.entries[prior.entries.length - 2]!.versionId
    })
  })

  it('refuses a handover from a log that is not closed', async () => {
    const { controller, entries } = await makeBaselineLog()
    const open = await verifyResourceLog({
      entries,
      controller,
      expectedMethod: METHOD
    })
    const { successor } = await makeHandover()
    expect(() => verifyResourceLogHandover({ prior: open, successor })).toThrow(
      ResourceLogContinuityError
    )
  })

  it('refuses a successor the terminal entry does not name', async () => {
    const { prior } = await makeHandover()
    const { successor: unrelated } = await makeHandover()
    expect(() =>
      verifyResourceLogHandover({ prior, successor: unrelated })
    ).toThrow(ResourceLogContinuityError)
  })

  it('refuses a successor whose previousLog.head is not the terminal predecessor', async () => {
    const { controller, prior, successorGenesisOf } = await makeHandover()
    const wrongHead = await successorGenesisOf({
      scid: prior.scid,
      head: prior.entries[0]!.versionId
    })
    const successor = await verifyResourceLog({
      entries: [wrongHead],
      controller,
      expectedMethod: METHOD
    })
    expect(() => verifyResourceLogHandover({ prior, successor })).toThrow(
      ResourceLogContinuityError
    )
  })
})

/**
 * Two members and the controller views the per-entry cases sign against.
 * Six controller versions: alice and bob are both listed at 1-v1 through
 * 4-v4, alice is removed at 5-v5, and 6-v6 lists bob alone. `viewAt(n)` is
 * the verifier's view cut to its first n versions, which is how a signer is
 * made to carry controller version n (the builders and `coSignEntry` sign at
 * the view's last version), and `full` is the six-version view the cases
 * verify against. The genesis is alice's, at 1-v1.
 */
async function makeMembers() {
  const alice = await makeLogClient()
  const bob = await makeLogClient()
  const both = [alice.signingKeyMultibase, bob.signingKeyMultibase]
  const versions = [
    { versionId: '1-v1', keys: both },
    { versionId: '2-v2', keys: both },
    { versionId: '3-v3', keys: both },
    { versionId: '4-v4', keys: both },
    { versionId: '5-v5', keys: [bob.signingKeyMultibase] },
    { versionId: '6-v6', keys: [bob.signingKeyMultibase] }
  ]
  const viewAt = (
    count: number,
    admitAppend?: ResourceLogController['admitAppend']
  ) => fakeController({ versions: versions.slice(0, count), admitAppend })
  const full = viewAt(versions.length)
  const genesis = await buildResourceLogGenesis({
    state: { type: 'TestState', value: 1 },
    method: METHOD,
    controller: viewAt(1),
    signer: alice.logSigner
  })
  /**
   * The second entry, signed by alice at `aliceAt` and co-signed by bob at
   * `bobAt`.
   */
  async function coSignedSecond({
    aliceAt,
    bobAt
  }: {
    aliceAt: number
    bobAt: number
  }) {
    const second = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller: viewAt(aliceAt),
      signer: alice.logSigner
    })
    return coSignEntry({
      entry: second,
      controller: viewAt(bobAt),
      signer: bob.logSigner
    })
  }
  return { alice, bob, both, versions, viewAt, full, genesis, coSignedSecond }
}

/**
 * The hook input as recorded by the cases below.
 */
type AdmissionInput = Parameters<
  NonNullable<ResourceLogController['admitAppend']>
>[0]

describe('verifyResourceLog (one controller versionId per entry)', () => {
  it('refuses co-signed proofs that disagree on the controller versionId, hook never called', async () => {
    // Each key is a member at its own controller version; only the
    // disagreement refuses the entry.
    const { viewAt, genesis, coSignedSecond } = await makeMembers()
    const divergent = await coSignedSecond({ aliceAt: 2, bobAt: 3 })
    let calls = 0
    const watching = viewAt(6, async () => {
      calls++
    })
    await expect(
      verifyResourceLog({
        entries: [genesis, divergent],
        controller: watching,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(
      new ResourceLogIntegrityError(
        "Resource log entry 2 carries proofs that disagree on the entry's " +
          'controller versionId (all proofs of an entry must carry the same ' +
          'controller version).'
      )
    )
    expect(calls).toBe(0)
  })

  it('refuses the removed co-signer riding on a later controller versionId (alice removed at 5, bob at 6, alice at 4)', async () => {
    const { full, genesis, coSignedSecond } = await makeMembers()
    const ridden = await coSignedSecond({ aliceAt: 4, bobAt: 6 })
    let verified: unknown
    let refusal: unknown
    try {
      verified = await verifyResourceLog({
        entries: [genesis, ridden],
        controller: full,
        expectedMethod: METHOD
      })
    } catch (err) {
      refusal = err
    }
    // No head controller version is produced for the sealing sweep to read:
    // the log is refused outright.
    expect(verified).toBeUndefined()
    expect(refusal).toBeInstanceOf(ResourceLogIntegrityError)
    expect((refusal as Error).message).toMatch(/disagree/)
  })

  it('verifies a co-signed entry at one controller versionId and advances the head to it', async () => {
    const { full, genesis, coSignedSecond } = await makeMembers()
    const coSigned = await coSignedSecond({ aliceAt: 3, bobAt: 3 })
    const verified = await verifyResourceLog({
      entries: [genesis, coSigned],
      controller: full,
      expectedMethod: METHOD
    })
    expect(verified.headControllerVersionIndex).toBe(2)
  })

  it('refuses a co-signer removed at the controller versionId the entry carries', async () => {
    const { full, genesis, coSignedSecond } = await makeMembers()
    // Alice is removed at 5-v5; both proofs carry 5-v5.
    const atRemoval = await coSignedSecond({ aliceAt: 5, bobAt: 5 })
    await expect(
      verifyResourceLog({
        entries: [genesis, atRemoval],
        controller: full,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/does not list under assertionMethod/)
  })

  it('reports disagreement, not monotonicity, when the lower controller versionId is behind the head', async () => {
    const { alice, bob, viewAt, full, genesis } = await makeMembers()
    // Entry 2 carries 3-v3, so the head controller version is index 2.
    const second = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller: viewAt(3),
      signer: alice.logSigner
    })
    const third = await buildResourceLogEntry({
      head: second,
      state: { type: 'TestState', value: 3 },
      controller: viewAt(4),
      signer: bob.logSigner
    })
    const divergentBehind = await coSignEntry({
      entry: third,
      controller: viewAt(2),
      signer: alice.logSigner
    })
    let refusal: unknown
    try {
      await verifyResourceLog({
        entries: [genesis, second, divergentBehind],
        controller: full,
        expectedMethod: METHOD
      })
    } catch (err) {
      refusal = err
    }
    expect(refusal).toBeInstanceOf(ResourceLogIntegrityError)
    expect((refusal as Error).message).toMatch(
      /entry 3 carries proofs that disagree/
    )
    expect((refusal as Error).message).not.toMatch(/monotone/)
  })

  it('refuses both proofs at one controller versionId behind the head (monotonicity, once per entry)', async () => {
    const { alice, bob, viewAt, full, genesis } = await makeMembers()
    const second = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller: viewAt(3),
      signer: alice.logSigner
    })
    const third = await buildResourceLogEntry({
      head: second,
      state: { type: 'TestState', value: 3 },
      controller: viewAt(2),
      signer: alice.logSigner
    })
    const bothBehind = await coSignEntry({
      entry: third,
      controller: viewAt(2),
      signer: bob.logSigner
    })
    await expect(
      verifyResourceLog({
        entries: [genesis, second, bothBehind],
        controller: full,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(
      /entry 3 carries a controller versionId behind its predecessor/
    )
  })

  it('refuses both proofs at one unknown controller version', async () => {
    const { both, versions, full, genesis, alice, bob } = await makeMembers()
    const elsewhere = fakeController({
      versions: [...versions, { versionId: '7-elsewhere', keys: both }]
    })
    const second = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller: elsewhere,
      signer: alice.logSigner
    })
    const unknown = await coSignEntry({
      entry: second,
      controller: elsewhere,
      signer: bob.logSigner
    })
    await expect(
      verifyResourceLog({
        entries: [genesis, unknown],
        controller: full,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/unknown controller/)
  })

  it('refuses a proof the host duplicated in the array, hook never called', async () => {
    const { viewAt, genesis, coSignedSecond } = await makeMembers()
    const coSigned = await coSignedSecond({ aliceAt: 3, bobAt: 3 })
    const duplicated = {
      ...coSigned,
      proof: [coSigned.proof[0]!, coSigned.proof[0]!]
    }
    let calls = 0
    const watching = viewAt(6, async () => {
      calls++
    })
    await expect(
      verifyResourceLog({
        entries: [genesis, duplicated],
        controller: watching,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(
      new ResourceLogIntegrityError(
        'Resource log entry 2 carries two proofs by one signing key.'
      )
    )
    expect(calls).toBe(0)
  })

  it('refuses a second proof by the same key at another controller versionId as a repeated key', async () => {
    // The per-proof distinct-keys check runs before the once-per-entry
    // equality check, so the repeated key is what the refusal names.
    const { alice, viewAt, full, genesis } = await makeMembers()
    const second = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller: viewAt(2),
      signer: alice.logSigner
    })
    const twice = await coSignEntry({
      entry: second,
      controller: viewAt(3),
      signer: alice.logSigner
    })
    await expect(
      verifyResourceLog({
        entries: [genesis, twice],
        controller: full,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/two proofs by one signing key/)
  })

  it('gives the reversed proof array the same verdict and the same hook inputs up to proofKeys order', async () => {
    const { viewAt, genesis, coSignedSecond } = await makeMembers()
    const coSigned = await coSignedSecond({ aliceAt: 3, bobAt: 3 })
    const reversed = { ...coSigned, proof: [...coSigned.proof].reverse() }
    const record = async (entry: typeof coSigned) => {
      const seen: AdmissionInput[] = []
      const watching = viewAt(6, async input => {
        seen.push(input)
      })
      const verified = await verifyResourceLog({
        entries: [genesis, entry],
        controller: watching,
        expectedMethod: METHOD
      })
      return { verified, seen }
    }
    const forward = await record(coSigned)
    const backward = await record(reversed)
    expect(backward.verified.headControllerVersionIndex).toBe(
      forward.verified.headControllerVersionIndex
    )
    const byKey = (inputs: AdmissionInput[]) =>
      [...inputs]
        .sort((left, right) =>
          left.keyMultibase.localeCompare(right.keyMultibase)
        )
        .map(({ proofKeys, ...rest }) => ({
          ...rest,
          proofKeys: [...proofKeys].sort()
        }))
    expect(byKey(backward.seen)).toEqual(byKey(forward.seen))
    // The only difference between the two runs is the array order itself.
    expect(backward.seen[0]!.proofKeys).toEqual(
      [...forward.seen[0]!.proofKeys].reverse()
    )
  })

  it('verifies a co-signed entry carrying no controller versionId under an unversioned controller', async () => {
    const { alice, bob, both } = await makeMembers()
    const unversioned = fakeController({ versions: [], currentKeys: both })
    const genesis = await buildResourceLogGenesis({
      state: { type: 'TestState', value: 1 },
      method: METHOD,
      controller: unversioned,
      signer: alice.logSigner
    })
    const second = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller: unversioned,
      signer: alice.logSigner
    })
    const coSigned = await coSignEntry({
      entry: second,
      controller: unversioned,
      signer: bob.logSigner
    })
    const seen: AdmissionInput[] = []
    const watching = fakeController({
      versions: [],
      currentKeys: both,
      admitAppend: async input => {
        seen.push(input)
      }
    })
    const verified = await verifyResourceLog({
      entries: [genesis, coSigned],
      controller: watching,
      expectedMethod: METHOD
    })
    expect(verified.headControllerVersionIndex).toBeNull()
    expect(seen.map(input => input.controllerVersionIndex)).toEqual([
      null,
      null
    ])
  })

  it('refuses a co-signed entry where one proof carries a controller versionId and one none (versioned controller)', async () => {
    const { alice, bob, both, viewAt, full, genesis } = await makeMembers()
    const second = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller: viewAt(3),
      signer: alice.logSigner
    })
    const mixed = await coSignEntry({
      entry: second,
      controller: fakeController({ versions: [], currentKeys: both }),
      signer: bob.logSigner
    })
    await expect(
      verifyResourceLog({
        entries: [genesis, mixed],
        controller: full,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/no controller versionId/)
  })

  it('refuses a co-signed entry where one proof carries a controller versionId (unversioned controller)', async () => {
    const { alice, bob, both, viewAt } = await makeMembers()
    const unversioned = fakeController({ versions: [], currentKeys: both })
    const genesis = await buildResourceLogGenesis({
      state: { type: 'TestState', value: 1 },
      method: METHOD,
      controller: unversioned,
      signer: alice.logSigner
    })
    const second = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller: unversioned,
      signer: alice.logSigner
    })
    const mixed = await coSignEntry({
      entry: second,
      controller: viewAt(1),
      signer: bob.logSigner
    })
    await expect(
      verifyResourceLog({
        entries: [genesis, mixed],
        controller: unversioned,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/unversioned controller/)
  })

  it('refuses a co-signer under a different controller DID from the pre-pass', async () => {
    const { alice, bob, both, viewAt, full, genesis } = await makeMembers()
    const second = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller: viewAt(3),
      signer: alice.logSigner
    })
    const elsewhere = await coSignEntry({
      entry: second,
      controller: fakeController({
        did: 'did:webvh:QmOther:example.com:space:xyz:id',
        versions: [{ versionId: '3-v3', keys: both }]
      }),
      signer: bob.logSigner
    })
    await expect(
      verifyResourceLog({
        entries: [genesis, elsewhere],
        controller: full,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/different controller/)
  })

  it("hands the hook the entry's controller versionId and every proof's key in array order on every call", async () => {
    const { alice, bob, viewAt, genesis, coSignedSecond } = await makeMembers()
    const coSigned = await coSignedSecond({ aliceAt: 3, bobAt: 3 })
    const seen: AdmissionInput[] = []
    const watching = viewAt(6, async input => {
      seen.push(input)
    })
    await verifyResourceLog({
      entries: [genesis, coSigned],
      controller: watching,
      expectedMethod: METHOD
    })
    const proofKeys = [alice.signingKeyMultibase, bob.signingKeyMultibase]
    expect(seen).toEqual([
      {
        ordinal: 2,
        keyMultibase: alice.signingKeyMultibase,
        controllerVersionId: '3-v3',
        controllerVersionIndex: 2,
        headControllerVersionIndex: 0,
        proofKeys
      },
      {
        ordinal: 2,
        keyMultibase: bob.signingKeyMultibase,
        controllerVersionId: '3-v3',
        controllerVersionIndex: 2,
        headControllerVersionIndex: 0,
        proofKeys
      }
    ])
  })

  it('resolves assertionKeysAt once per entry, co-signed or not', async () => {
    const { full, genesis, coSignedSecond } = await makeMembers()
    const coSigned = await coSignedSecond({ aliceAt: 3, bobAt: 3 })
    const resolved: Array<string | undefined> = []
    const counting: ResourceLogController = {
      ...full,
      async assertionKeysAt(versionId) {
        resolved.push(versionId)
        return full.assertionKeysAt(versionId)
      }
    }
    await verifyResourceLog({
      entries: [genesis, coSigned],
      controller: counting,
      expectedMethod: METHOD
    })
    // One call for the single-proof genesis, one for the two-proof entry.
    expect(resolved).toEqual(['1-v1', '3-v3'])
  })

  it('wraps a rejecting assertionKeysAt as the integrity class, once per entry', async () => {
    const { full, genesis, coSignedSecond } = await makeMembers()
    const coSigned = await coSignedSecond({ aliceAt: 3, bobAt: 3 })
    let calls = 0
    const rejecting: ResourceLogController = {
      ...full,
      async assertionKeysAt(versionId) {
        calls++
        if (versionId === '3-v3') {
          throw new Error('port unavailable')
        }
        return full.assertionKeysAt(versionId)
      }
    }
    await expect(
      verifyResourceLog({
        entries: [genesis, coSigned],
        controller: rejecting,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(
      new ResourceLogIntegrityError(
        'Resource log entry 2 failed proof verification.'
      )
    )
    expect(calls).toBe(2)
  })

  it('refuses a divergent entry whose second signature is also forged as disagreement (pre-pass before any signature)', async () => {
    const { full, genesis, coSignedSecond } = await makeMembers()
    const divergent = await coSignedSecond({ aliceAt: 2, bobAt: 3 })
    divergent.proof[1]!.proofValue = 'z3BadSignatureValueBadSignatureValue'
    await expect(
      verifyResourceLog({
        entries: [genesis, divergent],
        controller: full,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/disagree/)
  })

  it('refuses a non-member first proof on membership before reaching a forged second signature', async () => {
    const { bob, viewAt, full, genesis } = await makeMembers()
    const outsider = await makeLogClient()
    const outsiderView = fakeController({
      versions: [
        { versionId: '1-v1', keys: [outsider.signingKeyMultibase] },
        { versionId: '2-v2', keys: [outsider.signingKeyMultibase] },
        { versionId: '3-v3', keys: [outsider.signingKeyMultibase] }
      ]
    })
    const second = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller: outsiderView,
      signer: outsider.logSigner
    })
    const coSigned = await coSignEntry({
      entry: second,
      controller: viewAt(3),
      signer: bob.logSigner
    })
    coSigned.proof[1]!.proofValue = 'z3BadSignatureValueBadSignatureValue'
    await expect(
      verifyResourceLog({
        entries: [genesis, coSigned],
        controller: full,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/does not list under assertionMethod/)
  })

  it('applies the pre-pass to a co-signed genesis', async () => {
    const { alice, bob, viewAt, full } = await makeMembers()
    const genesis = await buildResourceLogGenesis({
      state: { type: 'TestState', value: 1 },
      method: METHOD,
      controller: viewAt(2),
      signer: alice.logSigner
    })
    const agreeing = await coSignEntry({
      entry: genesis,
      controller: viewAt(2),
      signer: bob.logSigner
    })
    const verified = await verifyResourceLog({
      entries: [agreeing],
      controller: full,
      expectedMethod: METHOD
    })
    expect(verified.headControllerVersionIndex).toBe(1)
    const divergent = await coSignEntry({
      entry: genesis,
      controller: viewAt(3),
      signer: bob.logSigner
    })
    await expect(
      verifyResourceLog({
        entries: [divergent],
        controller: full,
        expectedMethod: METHOD
      })
    ).rejects.toThrow(/entry 1 carries proofs that disagree/)
  })

  it('refuses a durable log carrying a divergent entry from genesis and keeps the held pin', async () => {
    const { full, genesis, coSignedSecond } = await makeMembers()
    const store = memoryLogStore()
    const pinStore = memoryResourceLogPinStore()
    const logId = resourceLogPinId({
      spaceId: 'space-under-test',
      collectionId: 'key-map',
      resourceId: 'divergent.jsonl'
    })
    store._setEntries([genesis])
    const first = await readResourceLog({
      store,
      controller: full,
      expectedMethod: METHOD,
      pinStore,
      logId
    })
    const pinnedBefore = await pinStore.read({ logId })
    expect(pinnedBefore).toEqual(first?.verified.pin)
    const divergent = await coSignedSecond({ aliceAt: 2, bobAt: 3 })
    store._setEntries([genesis, divergent])
    await expect(
      readResourceLog({
        store,
        controller: full,
        expectedMethod: METHOD,
        pinStore,
        logId
      })
    ).rejects.toThrow(/disagree/)
    expect(await pinStore.read({ logId })).toEqual(pinnedBefore)
  })

  it('refuses a divergent co-signed candidate before the write (verifyResourceLogAppend)', async () => {
    const { full, genesis, coSignedSecond } = await makeMembers()
    const head = await verifyResourceLog({
      entries: [genesis],
      controller: full,
      expectedMethod: METHOD
    })
    const divergent = await coSignedSecond({ aliceAt: 2, bobAt: 3 })
    await expect(
      verifyResourceLogAppend({ entry: divergent, controller: full, head })
    ).rejects.toThrow(/entry 2 carries proofs that disagree/)
    const agreeing = await coSignedSecond({ aliceAt: 3, bobAt: 3 })
    await expect(
      verifyResourceLogAppend({ entry: agreeing, controller: full, head })
    ).resolves.toBeUndefined()
  })
})
