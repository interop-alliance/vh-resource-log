/**
 * Unit tests for the resource-log read/append/create path
 * (`src/append.ts`) over the in-memory store fixture: pin advance
 * on read, the guarded genesis create with lost-race adoption, the append's
 * CAS rebase-and-retry loop (`buildState` re-invoked on the new head), the
 * `null` convergence signal, the closed-log refusal, and the fail-closed
 * refusals of a missing validator and an absent log. Plus the keyed pin seam
 * itself: the `resourceLogPinId` slot key and the per-log independence one
 * store instance must keep across the several logs a wallet holds.
 *
 * The second half covers the pre-write pass: every built entry is verified as
 * a reader would verify it before `store.append` (`verifyResourceLogAppend`,
 * also exercised directly as the export a consumer's own write path calls),
 * the genesis as a one-entry log before `store.create` with the lost-race
 * adoption fallthrough, and the sealing sweep driven by a removed member. A
 * refusal throws the read path's class and nothing is written.
 */
import { canonicalizeStrict } from '@interop/did-method-webvh'
import { describe, expect, it } from 'vitest'
import {
  appendResourceLog,
  buildResourceLogEntry,
  buildResourceLogGenesis,
  createResourceLog,
  isResourceLogConflictError,
  memoryResourceLogPinStore,
  readResourceLog,
  resourceLogPinId,
  ResourceLogClosedError,
  ResourceLogIntegrityError,
  sealResourceLog,
  verifyResourceLog,
  verifyResourceLogAppend,
  type ResourceLogController,
  type ResourceLogStore,
  type VerifiedResourceLog
} from '../../src/index.js'
import { fakeController, memoryLogStore } from '../../src/testing.js'
import {
  buildTerminalEntry,
  coSignEntry,
  makeLogClient,
  type LogTestClient
} from './fixtures/log.js'

const METHOD = 'resource-log:0.1'
const LOG_ID = resourceLogPinId({
  spaceId: 'space-under-test',
  collectionId: 'key-map',
  resourceId: 'test-log.jsonl'
})

/**
 * One enrolled client, its single-version controller view, a fresh store and
 * pin store -- the writer setup every case below starts from.
 */
async function makeWriter() {
  const alice = await makeLogClient()
  const controller = fakeController({
    versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }]
  })
  const store = memoryLogStore()
  const pinStore = memoryResourceLogPinStore()
  return { alice, controller, store, pinStore }
}

describe('resourceLogPinId', () => {
  it('builds the documented space/collection/resource slot key', () => {
    expect(
      resourceLogPinId({
        spaceId: 'urn:uuid:space',
        collectionId: 'key-map',
        resourceId: 'user-key.jsonl'
      })
    ).toBe('space/urn:uuid:space/key-map/user-key.jsonl')
  })

  it('never collides across two accounts holding the same log resource', () => {
    const slot = (spaceId: string) =>
      resourceLogPinId({
        spaceId,
        collectionId: 'id',
        resourceId: 'did.jsonl'
      })
    expect(slot('space-one')).not.toBe(slot('space-two'))
  })
})

describe('memoryResourceLogPinStore', () => {
  it('keeps the pins of one store instance independent per logId', async () => {
    const { alice, controller, store, pinStore } = await makeWriter()
    const otherLogId = resourceLogPinId({
      spaceId: 'space-under-test',
      collectionId: 'id',
      resourceId: 'did.jsonl'
    })

    const { verified } = await createResourceLog({
      store,
      controller,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })

    // The written slot holds this log's pin; the sibling slot is untouched,
    // so a second log's first contact is still a first contact.
    expect(await pinStore.read({ logId: LOG_ID })).toEqual(verified.pin)
    expect(await pinStore.read({ logId: otherLogId })).toBeNull()

    // The second log, served through the SAME store, pins beside the first
    // rather than over it.
    const second = await makeWriter()
    const { verified: otherVerified } = await createResourceLog({
      store: second.store,
      controller: second.controller,
      method: METHOD,
      pinStore,
      logId: otherLogId,
      signer: second.alice.logSigner,
      state: { type: 'TestState', value: 2 }
    })
    expect(await pinStore.read({ logId: otherLogId })).toEqual(
      otherVerified.pin
    )
    expect(await pinStore.read({ logId: LOG_ID })).toEqual(verified.pin)
  })
})

describe('readResourceLog', () => {
  it('resolves null on an absent log (the pre-genesis state)', async () => {
    const { controller, store, pinStore } = await makeWriter()
    expect(
      await readResourceLog({
        store,
        controller,
        expectedMethod: METHOD,
        pinStore,
        logId: LOG_ID
      })
    ).toBeNull()
    expect(await pinStore.read({ logId: LOG_ID })).toBeNull()
  })

  it('verifies, returns the etag, and advances the pin', async () => {
    const { alice, controller, store, pinStore } = await makeWriter()
    const { verified: created } = await createResourceLog({
      store,
      controller,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    const read = await readResourceLog({
      store,
      controller,
      expectedMethod: METHOD,
      pinStore,
      logId: LOG_ID
    })
    expect(read).not.toBeNull()
    expect(read!.verified.state).toEqual({ type: 'TestState', value: 1 })
    expect(read!.etag).toBeDefined()
    expect(await pinStore.read({ logId: LOG_ID })).toEqual(created.pin)
  })

  it('refuses a rollback on a later read (the pin never regresses)', async () => {
    const { alice, controller, store, pinStore } = await makeWriter()
    await createResourceLog({
      store,
      controller,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    await appendResourceLog({
      store,
      controller,
      expectedMethod: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      buildState: () => ({ type: 'TestState', value: 2 })
    })
    // The host replays the one-entry log from before the append.
    const genesisOnly = store._getEntries()!.slice(0, 1)
    store._setEntries(genesisOnly)
    await expect(
      readResourceLog({
        store,
        controller,
        expectedMethod: METHOD,
        pinStore,
        logId: LOG_ID
      })
    ).rejects.toMatchObject({
      name: 'ResourceLogContinuityError',
      reason: 'rollback'
    })
  })
})

describe('createResourceLog', () => {
  it('creates the genesis, confirms by read-back, and establishes the pin', async () => {
    const { alice, controller, store, pinStore } = await makeWriter()
    const { verified, created } = await createResourceLog({
      store,
      controller,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    expect(created).toBe(true)
    expect(verified.entries).toHaveLength(1)
    expect(store._getEntries()).toEqual(verified.entries)
    expect(await pinStore.read({ logId: LOG_ID })).toEqual(verified.pin)
  })

  it('adopts the winner on a lost guarded-create race', async () => {
    const { controller, store, pinStore } = await makeWriter()
    const bob = await makeLogClient()
    const bothController = fakeController({
      versions: [
        {
          versionId: '1-v1',
          keys: [
            ...(await controller.assertionKeysAt('1-v1')),
            bob.signingKeyMultibase
          ]
        }
      ]
    })
    // The winner (bob) creates first...
    const winner = await createResourceLog({
      store,
      controller: bothController,
      method: METHOD,
      pinStore: memoryResourceLogPinStore(),
      logId: LOG_ID,
      signer: bob.logSigner,
      state: { type: 'TestState', value: 42 }
    })
    // ...and the loser's create adopts the served log instead of clobbering.
    const alice = await makeLogClient()
    const aliceController = fakeController({
      versions: [
        {
          versionId: '1-v1',
          keys: [alice.signingKeyMultibase, bob.signingKeyMultibase]
        }
      ]
    })
    const { verified, created } = await createResourceLog({
      store,
      controller: aliceController,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    expect(created).toBe(false)
    expect(verified.scid).toBe(winner.verified.scid)
    expect(verified.state).toEqual({ type: 'TestState', value: 42 })
    expect(await pinStore.read({ logId: LOG_ID })).toEqual(verified.pin)
  })
})

describe('appendResourceLog', () => {
  it('appends against the verified head and confirms by read-back', async () => {
    const { alice, controller, store, pinStore } = await makeWriter()
    await createResourceLog({
      store,
      controller,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    const heads: unknown[] = []
    const confirmed = await appendResourceLog({
      store,
      controller,
      expectedMethod: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      buildState: verified => {
        heads.push(verified.state)
        return { type: 'TestState', value: 2 }
      }
    })
    expect(heads).toEqual([{ type: 'TestState', value: 1 }])
    expect(confirmed.entries).toHaveLength(2)
    expect(confirmed.state).toEqual({ type: 'TestState', value: 2 })
    expect(await pinStore.read({ logId: LOG_ID })).toEqual(confirmed.pin)
  })

  it('converges without a write when buildState resolves null', async () => {
    const { alice, controller, store, pinStore } = await makeWriter()
    await createResourceLog({
      store,
      controller,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    const before = store._getEntries()
    const verified = await appendResourceLog({
      store,
      controller,
      expectedMethod: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      buildState: () => null
    })
    expect(verified.entries).toHaveLength(1)
    expect(store._getEntries()).toEqual(before)
  })

  it('rebases and retries when a concurrent append wins the CAS', async () => {
    const { alice, store, pinStore } = await makeWriter()
    const bob = await makeLogClient()
    const bothController = fakeController({
      versions: [
        {
          versionId: '1-v1',
          keys: [alice.signingKeyMultibase, bob.signingKeyMultibase]
        }
      ]
    })
    await createResourceLog({
      store,
      controller: bothController,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    // Between alice's read and her append, bob lands an entry: her CAS loses
    // and the loop re-reads, rebases on bob's head, and retries.
    let raced = false
    const racingStore = {
      ...store,
      async append(
        entry: Parameters<typeof store.append>[0],
        options: Parameters<typeof store.append>[1]
      ) {
        if (!raced) {
          raced = true
          await appendResourceLog({
            store,
            controller: bothController,
            expectedMethod: METHOD,
            pinStore: memoryResourceLogPinStore(),
            logId: LOG_ID,
            signer: bob.logSigner,
            buildState: () => ({ type: 'TestState', value: 100 })
          })
        }
        return store.append(entry, options)
      }
    }
    const rebasedOn: unknown[] = []
    const confirmed = await appendResourceLog({
      store: racingStore,
      controller: bothController,
      expectedMethod: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      buildState: (verified: VerifiedResourceLog) => {
        rebasedOn.push(verified.state)
        return {
          type: 'TestState',
          value: (verified.state.value as number) + 1
        }
      }
    })
    // First attempt built on value 1; the retry rebased on bob's value 100.
    expect(rebasedOn).toEqual([
      { type: 'TestState', value: 1 },
      { type: 'TestState', value: 100 }
    ])
    expect(confirmed.entries).toHaveLength(3)
    expect(confirmed.state).toEqual({ type: 'TestState', value: 101 })
  })

  it('gives up after maxAttempts lost races, with the conflict as cause', async () => {
    const { alice, controller, store, pinStore } = await makeWriter()
    await createResourceLog({
      store,
      controller,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    // Every append attempt loses: another writer bumps the store version
    // between the read and the CAS, forever.
    const contestedStore = {
      ...store,
      async append() {
        const entries = store._getEntries()!
        store._setEntries(entries)
        return store.append(entries[0]!, { ifMatch: 'stale' })
      }
    }
    let exhausted: unknown
    try {
      await appendResourceLog({
        store: contestedStore,
        controller,
        expectedMethod: METHOD,
        pinStore,
        logId: LOG_ID,
        signer: alice.logSigner,
        buildState: () => ({ type: 'TestState', value: 2 }),
        maxAttempts: 2
      })
    } catch (err) {
      exhausted = err
    }
    expect(exhausted).toBeInstanceOf(Error)
    expect((exhausted as Error).message).toMatch(
      /lost the compare-and-swap race 2 times/
    )
    // The last conflict rides as cause, and it is the library's conflict
    // error (the store fixture mints it exactly as a real adapter must).
    expect(isResourceLogConflictError((exhausted as Error).cause)).toBe(true)
  })

  it('propagates a store error that is NOT the named conflict, without retrying', async () => {
    // The conflict contract is matched by name (`ResourceLogConflictError`).
    // A store surfacing an untranslated transport error -- was-client's
    // `PreconditionFailedError` from an adapter that skipped the rethrow,
    // say -- must escape the rebase loop as a hard failure, not be silently
    // retried as a benign lost race.
    const { alice, controller, store, pinStore } = await makeWriter()
    await createResourceLog({
      store,
      controller,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    const foreign = Object.assign(new Error('stale'), {
      name: 'PreconditionFailedError'
    })
    let attempts = 0
    const untranslatedStore = {
      ...store,
      async append() {
        attempts++
        throw foreign
      }
    }
    await expect(
      appendResourceLog({
        store: untranslatedStore,
        controller,
        expectedMethod: METHOD,
        pinStore,
        logId: LOG_ID,
        signer: alice.logSigner,
        buildState: () => ({ type: 'TestState', value: 2 })
      })
    ).rejects.toBe(foreign)
    expect(attempts).toBe(1)
  })

  it('refuses to append to an absent log', async () => {
    const { alice, controller, store, pinStore } = await makeWriter()
    await expect(
      appendResourceLog({
        store,
        controller,
        expectedMethod: METHOD,
        pinStore,
        logId: LOG_ID,
        signer: alice.logSigner,
        buildState: () => ({ type: 'TestState', value: 1 })
      })
    ).rejects.toThrow(/does not exist yet/)
  })

  it('refuses to append without a validator (no unconditional writes)', async () => {
    const { alice, controller, store, pinStore } = await makeWriter()
    await createResourceLog({
      store,
      controller,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    store._withholdEtag(true)
    await expect(
      appendResourceLog({
        store,
        controller,
        expectedMethod: METHOD,
        pinStore,
        logId: LOG_ID,
        signer: alice.logSigner,
        buildState: () => ({ type: 'TestState', value: 2 })
      })
    ).rejects.toThrow(/no validator/)
  })

  it('refuses to append on a blank validator (no unconditional writes)', async () => {
    const { alice, controller, store, pinStore } = await makeWriter()
    await createResourceLog({
      store,
      controller,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    let appends = 0
    const blankEtagStore: ResourceLogStore = {
      ...store,
      async read() {
        const current = await store.read()
        return current === null ? null : { entries: current.entries, etag: '' }
      },
      async append(entry, options) {
        appends++
        return store.append(entry, options)
      }
    }
    await expect(
      appendResourceLog({
        store: blankEtagStore,
        controller,
        expectedMethod: METHOD,
        pinStore,
        logId: LOG_ID,
        signer: alice.logSigner,
        buildState: () => ({ type: 'TestState', value: 2 })
      })
    ).rejects.toThrow(/no validator/)
    expect(appends).toBe(0)
  })

  it('refuses to extend a log closed by a terminal handover entry', async () => {
    const { alice, controller, store, pinStore } = await makeWriter()
    await createResourceLog({
      store,
      controller,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    const entries = store._getEntries()!
    const terminal = await buildTerminalEntry({
      head: entries[entries.length - 1]!,
      nextLog: { method: METHOD, scid: 'QmSuccessorScid' },
      controller,
      signer: alice.logSigner
    })
    store._setEntries([...entries, terminal])
    let refusal: unknown
    try {
      await appendResourceLog({
        store,
        controller,
        expectedMethod: METHOD,
        pinStore,
        logId: LOG_ID,
        signer: alice.logSigner,
        buildState: () => ({ type: 'TestState', value: 2 })
      })
    } catch (err) {
      refusal = err
    }
    expect(refusal).toBeInstanceOf(ResourceLogClosedError)
    expect((refusal as ResourceLogClosedError).nextLog).toEqual({
      method: METHOD,
      scid: 'QmSuccessorScid'
    })
  })
})

/**
 * A refusal class standing in for a consumer's admission policy error: its
 * identity must survive the pre-write pass untouched.
 */
class FakeAdmissionRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FakeAdmissionRefusal'
  }
}

/**
 * Wraps a store so the test can see which write calls reached it, in order,
 * interleaved with whatever else the test records into `events`.
 */
function recordingStore(
  store: ReturnType<typeof memoryLogStore>,
  events: string[]
): ResourceLogStore {
  return {
    read: () => store.read(),
    async append(entry, options) {
      events.push('append')
      return store.append(entry, options)
    },
    async create(entry) {
      events.push('create')
      return store.create(entry)
    }
  }
}

/**
 * Two enrolled clients; a one-version controller listing both (the view the
 * log is created under) and a two-version controller whose second version
 * drops alice (the view a writer holds after her removal). Both views share
 * the first version, so the second extends the first as the port requires.
 */
async function makeRemovalViews() {
  const alice = await makeLogClient()
  const bob = await makeLogClient()
  const both = [alice.signingKeyMultibase, bob.signingKeyMultibase]
  const before = fakeController({
    versions: [{ versionId: '1-v1', keys: both }]
  })
  const afterRemoval = (admitAppend?: ResourceLogController['admitAppend']) =>
    fakeController({
      versions: [
        { versionId: '1-v1', keys: both },
        { versionId: '2-v2', keys: [bob.signingKeyMultibase] }
      ],
      ...(admitAppend === undefined ? {} : { admitAppend })
    })
  const store = memoryLogStore()
  const pinStore = memoryResourceLogPinStore()
  await createResourceLog({
    store,
    controller: before,
    method: METHOD,
    pinStore,
    logId: LOG_ID,
    signer: alice.logSigner,
    state: { type: 'TestState', value: 1 }
  })
  return { alice, bob, before, afterRemoval, store, pinStore }
}

/**
 * Verifies a caller-built entry list into the `head` the pre-write export
 * takes, without a pin.
 */
async function verifiedHead(
  entries: Parameters<typeof verifyResourceLog>[0]['entries'],
  controller: ResourceLogController
): Promise<VerifiedResourceLog> {
  return verifyResourceLog({ entries, controller, expectedMethod: METHOD })
}

/**
 * A one-entry log under `controller`, signed by `client`, as a verified head
 * plus its genesis.
 */
async function genesisHead(
  controller: ResourceLogController,
  client: LogTestClient
) {
  const genesis = await buildResourceLogGenesis({
    state: { type: 'TestState', value: 1 },
    method: METHOD,
    controller,
    signer: client.logSigner
  })
  const head = await verifiedHead([genesis], controller)
  return { genesis, head }
}

describe('appendResourceLog pre-write pass', () => {
  it('refuses an append by a signer removed at the controller head, writing nothing', async () => {
    const { alice, afterRemoval, store, pinStore } = await makeRemovalViews()
    const before = store._getEntries()
    await expect(
      appendResourceLog({
        store,
        controller: afterRemoval(),
        expectedMethod: METHOD,
        pinStore,
        logId: LOG_ID,
        signer: alice.logSigner,
        buildState: () => ({ type: 'TestState', value: 2 })
      })
    ).rejects.toThrow(
      new ResourceLogIntegrityError(
        'Resource log entry 2 is signed by a key the controller document ' +
          'does not list under assertionMethod at the anchored version.'
      )
    )
    expect(store._getEntries()).toEqual(before)
  })

  it('refuses an append the hook refuses, with the hook class and the reader input', async () => {
    const { alice, controller: view, store, pinStore } = await makeWriter()
    await createResourceLog({
      store,
      controller: view,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    const seen: unknown[] = []
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }],
      admitAppend: async input => {
        seen.push(input)
        throw new FakeAdmissionRefusal('not licensed')
      }
    })
    const before = store._getEntries()
    await expect(
      appendResourceLog({
        store,
        controller,
        expectedMethod: METHOD,
        pinStore,
        logId: LOG_ID,
        signer: alice.logSigner,
        buildState: () => ({ type: 'TestState', value: 2 })
      })
    ).rejects.toBeInstanceOf(FakeAdmissionRefusal)
    expect(store._getEntries()).toEqual(before)
    expect(seen).toEqual([
      {
        ordinal: 2,
        keyMultibase: alice.signingKeyMultibase,
        anchor: '1-v1',
        anchorIndex: 0,
        headAnchorIndex: 0
      }
    ])
  })

  it('consults the hook before store.append and again on read-back, with identical input', async () => {
    const { alice, controller: view, store, pinStore } = await makeWriter()
    await createResourceLog({
      store,
      controller: view,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    const events: string[] = []
    const inputs: unknown[] = []
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }],
      admitAppend: async input => {
        events.push('hook')
        inputs.push(input)
      }
    })
    await appendResourceLog({
      store: recordingStore(store, events),
      controller,
      expectedMethod: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      buildState: () => ({ type: 'TestState', value: 2 })
    })
    expect(events).toEqual(['hook', 'append', 'hook'])
    expect(inputs[0]).toEqual(inputs[1])
  })

  it('refuses a caller versionTime outside RFC3339 Z form before the write', async () => {
    const { alice, controller, store, pinStore } = await makeWriter()
    await createResourceLog({
      store,
      controller,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    const before = store._getEntries()
    await expect(
      appendResourceLog({
        store,
        controller,
        expectedMethod: METHOD,
        pinStore,
        logId: LOG_ID,
        signer: alice.logSigner,
        buildState: () => ({ type: 'TestState', value: 2 }),
        versionTime: '2026-08-22T00:00:00+00:00'
      })
    ).rejects.toThrow(/entry 2 has a malformed versionTime/)
    expect(store._getEntries()).toEqual(before)
  })

  it('re-verifies the retry against the rebased head after a lost CAS', async () => {
    const { alice, bob, store, pinStore } = await makeRemovalViews()
    // Both clients stay listed at the second version here; what changes is
    // the head's anchor once bob's entry lands.
    const both = [alice.signingKeyMultibase, bob.signingKeyMultibase]
    const versions = [
      { versionId: '1-v1', keys: both },
      { versionId: '2-v2', keys: both }
    ]
    const inputs: Array<{ ordinal: number; headAnchorIndex: number }> = []
    const controller = fakeController({
      versions,
      admitAppend: async ({ ordinal, headAnchorIndex }) => {
        inputs.push({ ordinal, headAnchorIndex })
      }
    })
    let raced = false
    const racingStore: ResourceLogStore = {
      ...store,
      async append(entry, options) {
        if (!raced) {
          raced = true
          await appendResourceLog({
            store,
            controller: fakeController({ versions }),
            expectedMethod: METHOD,
            pinStore: memoryResourceLogPinStore(),
            logId: LOG_ID,
            signer: bob.logSigner,
            buildState: () => ({ type: 'TestState', value: 100 })
          })
        }
        return store.append(entry, options)
      }
    }
    const confirmed = await appendResourceLog({
      store: racingStore,
      controller,
      expectedMethod: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      buildState: () => ({ type: 'TestState', value: 2 })
    })
    expect(confirmed.entries).toHaveLength(3)
    // Attempt 1 verified its candidate (ordinal 2) at the genesis floor;
    // attempt 2 verified a new candidate (ordinal 3) at bob's anchor.
    expect(inputs.find(input => input.ordinal === 2)).toEqual({
      ordinal: 2,
      headAnchorIndex: 0
    })
    expect(inputs.find(input => input.ordinal === 3)).toEqual({
      ordinal: 3,
      headAnchorIndex: 1
    })
  })
})

describe('createResourceLog pre-write pass', () => {
  it('refuses a genesis by a non-member when no log exists, creating nothing', async () => {
    const alice = await makeLogClient()
    const bob = await makeLogClient()
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [bob.signingKeyMultibase] }]
    })
    const store = memoryLogStore()
    const pinStore = memoryResourceLogPinStore()
    await expect(
      createResourceLog({
        store,
        controller,
        method: METHOD,
        pinStore,
        logId: LOG_ID,
        signer: alice.logSigner,
        state: { type: 'TestState', value: 1 }
      })
    ).rejects.toBeInstanceOf(ResourceLogIntegrityError)
    expect(await store.read()).toBeNull()
    expect(await pinStore.read({ logId: LOG_ID })).toBeNull()
  })

  it('adopts the existing log when a non-member genesis is refused (lost race)', async () => {
    const alice = await makeLogClient()
    const bob = await makeLogClient()
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [bob.signingKeyMultibase] }]
    })
    const store = memoryLogStore()
    const winner = await createResourceLog({
      store,
      controller,
      method: METHOD,
      pinStore: memoryResourceLogPinStore(),
      logId: LOG_ID,
      signer: bob.logSigner,
      state: { type: 'TestState', value: 42 }
    })
    const events: string[] = []
    const pinStore = memoryResourceLogPinStore()
    const { verified, created } = await createResourceLog({
      store: recordingStore(store, events),
      controller,
      method: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    expect(created).toBe(false)
    expect(events).toEqual([])
    expect(verified.scid).toBe(winner.verified.scid)
    expect(verified.state).toEqual({ type: 'TestState', value: 42 })
    expect(await pinStore.read({ logId: LOG_ID })).toEqual(verified.pin)
  })

  it('never consults the hook for the genesis', async () => {
    const alice = await makeLogClient()
    let calls = 0
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }],
      admitAppend: async () => {
        calls++
      }
    })
    const { created } = await createResourceLog({
      store: memoryLogStore(),
      controller,
      method: METHOD,
      pinStore: memoryResourceLogPinStore(),
      logId: LOG_ID,
      signer: alice.logSigner,
      state: { type: 'TestState', value: 1 }
    })
    expect(created).toBe(true)
    expect(calls).toBe(0)
  })

  it('propagates a non-Integrity throw from the pass without adopting anything', async () => {
    const alice = await makeLogClient()
    const bob = await makeLogClient()
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [bob.signingKeyMultibase] }]
    })
    const store = memoryLogStore()
    await createResourceLog({
      store,
      controller,
      method: METHOD,
      pinStore: memoryResourceLogPinStore(),
      logId: LOG_ID,
      signer: bob.logSigner,
      state: { type: 'TestState', value: 42 }
    })
    // A port bug: the view throws from outside the kernel's authorize
    // callback (inside it, a throw is wrapped as the Integrity class).
    const bug = new TypeError('controller port bug')
    const broken: ResourceLogController = {
      did: controller.did,
      get versionIds(): string[] {
        throw bug
      },
      assertionKeysAt: controller.assertionKeysAt
    }
    const events: string[] = []
    const pinStore = memoryResourceLogPinStore()
    await expect(
      createResourceLog({
        store: recordingStore(store, events),
        controller: broken,
        method: METHOD,
        pinStore,
        logId: LOG_ID,
        signer: alice.logSigner,
        state: { type: 'TestState', value: 1 }
      })
    ).rejects.toBe(bug)
    expect(events).toEqual([])
    expect(await pinStore.read({ logId: LOG_ID })).toBeNull()
  })
})

describe('sealResourceLog pre-write pass', () => {
  it('refuses a sweep driven by the removed member; a surviving member seals', async () => {
    const { alice, bob, afterRemoval, store, pinStore } =
      await makeRemovalViews()
    const before = store._getEntries()
    await expect(
      sealResourceLog({
        store,
        controller: afterRemoval(),
        expectedMethod: METHOD,
        pinStore,
        logId: LOG_ID,
        signer: alice.logSigner
      })
    ).rejects.toBeInstanceOf(ResourceLogIntegrityError)
    expect(store._getEntries()).toEqual(before)

    const { sealed, verified } = await sealResourceLog({
      store,
      controller: afterRemoval(),
      expectedMethod: METHOD,
      pinStore,
      logId: LOG_ID,
      signer: bob.logSigner
    })
    expect(sealed).toBe(true)
    expect(verified?.entries).toHaveLength(2)
    expect(verified?.headAnchorIndex).toBe(1)
  })
})

describe('verifyResourceLogAppend', () => {
  it('refuses a co-signed entry whose second proof is forged, without consulting the hook', async () => {
    const alice = await makeLogClient()
    const bob = await makeLogClient()
    let calls = 0
    const controller = fakeController({
      versions: [
        {
          versionId: '1-v1',
          keys: [alice.signingKeyMultibase, bob.signingKeyMultibase]
        }
      ],
      admitAppend: async () => {
        calls++
      }
    })
    const { genesis, head } = await genesisHead(controller, alice)
    const second = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller,
      signer: alice.logSigner
    })
    const coSigned = await coSignEntry({
      entry: second,
      controller,
      signer: bob.logSigner
    })
    const forged = {
      ...coSigned,
      proof: [
        coSigned.proof[0]!,
        { ...coSigned.proof[1]!, proofValue: 'z3garbage' }
      ]
    }
    await expect(
      verifyResourceLogAppend({ entry: forged, controller, head })
    ).rejects.toBeInstanceOf(ResourceLogIntegrityError)
    expect(calls).toBe(0)
  })

  it('refuses an empty proof array, without consulting the hook', async () => {
    const alice = await makeLogClient()
    let calls = 0
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }],
      admitAppend: async () => {
        calls++
      }
    })
    const { genesis, head } = await genesisHead(controller, alice)
    const second = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller,
      signer: alice.logSigner
    })
    await expect(
      verifyResourceLogAppend({
        entry: { ...second, proof: [] },
        controller,
        head
      })
    ).rejects.toThrow(/entry 2 carries no proof array/)
    expect(calls).toBe(0)
  })

  it('refuses an entry anchored behind the head floor', async () => {
    const alice = await makeLogClient()
    const keys = [alice.signingKeyMultibase]
    const twoVersions = fakeController({
      versions: [
        { versionId: '1-v1', keys },
        { versionId: '2-v2', keys }
      ]
    })
    const oneVersion = fakeController({
      versions: [{ versionId: '1-v1', keys }]
    })
    // The head anchors at the second version; the candidate was built by a
    // writer still holding the one-version view, so it anchors at the first.
    const { genesis, head } = await genesisHead(twoVersions, alice)
    expect(head.headAnchorIndex).toBe(1)
    const behind = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller: oneVersion,
      signer: alice.logSigner
    })
    await expect(
      verifyResourceLogAppend({
        entry: behind,
        controller: twoVersions,
        head
      })
    ).rejects.toThrow(/entry 2 anchors behind its predecessor/)
  })

  it('refuses an entry whose ordinal is not head + 1', async () => {
    const { alice, controller } = await makeWriter()
    const { genesis } = await genesisHead(controller, alice)
    const second = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller,
      signer: alice.logSigner
    })
    const head = await verifiedHead([genesis, second], controller)
    // An entry built on the genesis (ordinal 2) offered against a two-entry
    // head (next ordinal 3).
    const stale = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 3 },
      controller,
      signer: alice.logSigner
    })
    await expect(
      verifyResourceLogAppend({ entry: stale, controller, head })
    ).rejects.toThrow(/entry 3 has a malformed or misplaced versionId/)
  })

  it('refuses a view flip in either direction', async () => {
    const alice = await makeLogClient()
    const keys = [alice.signingKeyMultibase]
    const unversioned = fakeController({ versions: [], currentKeys: keys })
    const versioned = fakeController({
      versions: [{ versionId: '1-v1', keys }]
    })

    const anchorless = await genesisHead(unversioned, alice)
    expect(anchorless.head.headAnchorIndex).toBeNull()
    const anchorlessNext = await buildResourceLogEntry({
      head: anchorless.genesis,
      state: { type: 'TestState', value: 2 },
      controller: unversioned,
      signer: alice.logSigner
    })
    await expect(
      verifyResourceLogAppend({
        entry: anchorlessNext,
        controller: versioned,
        head: anchorless.head
      })
    ).rejects.toThrow(/verified against an unversioned controller/)

    const anchored = await genesisHead(versioned, alice)
    const anchoredNext = await buildResourceLogEntry({
      head: anchored.genesis,
      state: { type: 'TestState', value: 2 },
      controller: versioned,
      signer: alice.logSigner
    })
    await expect(
      verifyResourceLogAppend({
        entry: anchoredNext,
        controller: unversioned,
        head: anchored.head
      })
    ).rejects.toThrow(/verified against a versioned controller/)
  })

  it('refuses a closed head with ResourceLogClosedError', async () => {
    const { alice, controller } = await makeWriter()
    const { genesis } = await genesisHead(controller, alice)
    const terminal = await buildTerminalEntry({
      head: genesis,
      nextLog: { method: METHOD, scid: 'QmSuccessorScid' },
      controller,
      signer: alice.logSigner
    })
    const head = await verifiedHead([genesis, terminal], controller)
    const next = await buildResourceLogEntry({
      head: terminal,
      state: { type: 'TestState', value: 2 },
      controller,
      signer: alice.logSigner
    })
    let refusal: unknown
    try {
      await verifyResourceLogAppend({ entry: next, controller, head })
    } catch (err) {
      refusal = err
    }
    expect(refusal).toBeInstanceOf(ResourceLogClosedError)
    expect((refusal as ResourceLogClosedError).nextLog).toEqual({
      method: METHOD,
      scid: 'QmSuccessorScid'
    })
  })

  it('admits a terminal entry carrying the head state and refuses one that changes it', async () => {
    const { alice, controller } = await makeWriter()
    const { genesis, head } = await genesisHead(controller, alice)
    const nextLog = { method: METHOD, scid: 'QmSuccessorScid' }
    const terminal = await buildTerminalEntry({
      head: genesis,
      nextLog,
      controller,
      signer: alice.logSigner
    })
    await expect(
      verifyResourceLogAppend({ entry: terminal, controller, head })
    ).resolves.toBeUndefined()
    // Same chain position, but the state the terminal entry repeats is not
    // the head's.
    const changed = await buildTerminalEntry({
      head: { ...genesis, state: { type: 'TestState', value: 99 } },
      nextLog,
      controller,
      signer: alice.logSigner
    })
    await expect(
      verifyResourceLogAppend({ entry: changed, controller, head })
    ).rejects.toThrow(/terminal handover entry's state differs/)
  })

  it('admits an anchorless entry against an unversioned controller', async () => {
    const alice = await makeLogClient()
    const controller = fakeController({
      versions: [],
      currentKeys: [alice.signingKeyMultibase]
    })
    const { genesis, head } = await genesisHead(controller, alice)
    const next = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller,
      signer: alice.logSigner
    })
    await expect(
      verifyResourceLogAppend({ entry: next, controller, head })
    ).resolves.toBeUndefined()
  })

  it('admits a valid co-signed entry proof by proof in array order, without mutating it', async () => {
    const alice = await makeLogClient()
    const bob = await makeLogClient()
    const admitted: string[] = []
    const controller = fakeController({
      versions: [
        {
          versionId: '1-v1',
          keys: [alice.signingKeyMultibase, bob.signingKeyMultibase]
        }
      ],
      admitAppend: async ({ keyMultibase }) => {
        admitted.push(keyMultibase)
      }
    })
    const { genesis, head } = await genesisHead(controller, alice)
    const second = await buildResourceLogEntry({
      head: genesis,
      state: { type: 'TestState', value: 2 },
      controller,
      signer: alice.logSigner
    })
    const coSigned = await coSignEntry({
      entry: second,
      controller,
      signer: bob.logSigner
    })
    const before = canonicalizeStrict(coSigned)
    await verifyResourceLogAppend({ entry: coSigned, controller, head })
    expect(admitted).toEqual([
      alice.signingKeyMultibase,
      bob.signingKeyMultibase
    ])
    expect(canonicalizeStrict(coSigned)).toBe(before)
  })
})

describe('entry builders refuse a state that is not a state document', () => {
  it('refuses null and undefined with the misuse Error, not a TypeError', async () => {
    const alice = await makeLogClient()
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }]
    })
    const { genesis } = await genesisHead(controller, alice)
    for (const state of [null, undefined]) {
      await expect(
        buildResourceLogEntry({
          head: genesis,
          state: state as never,
          controller,
          signer: alice.logSigner
        })
      ).rejects.toThrow(/must carry a type schema identifier/)
      await expect(
        buildResourceLogGenesis({
          state: state as never,
          method: METHOD,
          controller,
          signer: alice.logSigner
        })
      ).rejects.toThrow(/must carry a type schema identifier/)
    }
  })
})
