/**
 * Unit tests for the verifier's resumed pass (`verifyResourceLog`'s
 * `previous`) and for the read and append paths that thread the record.
 */
import { describe, expect, it } from 'vitest'
import type { ResourceLogEntry } from '@interop/storage-core'
import {
  appendResourceLog,
  buildResourceLogEntry,
  buildResourceLogGenesis,
  createResourceLog,
  memoryResourceLogPinStore,
  readResourceLog,
  verifyResourceLog,
  type ResourceLogController,
  type VerifiedResourceLog
} from '../../src/index.js'
import { fakeController, memoryLogStore } from '../../src/testing.js'
import { buildTerminalEntry, makeLogClient } from './fixtures/log.js'

const METHOD = 'resource-log:0.1'
const LOG_ID = 'space/s1/c1/log'

function state(value: number): { type: string; value: number } {
  return { type: 'TestState', value }
}

/**
 * Wraps a controller view so each `documentAt` call is counted: the verifier
 * dereferences the controller document once per entry it checks proofs on,
 * so the count is the number of entries verified.
 */
function counting(controller: ResourceLogController): ResourceLogController & {
  calls: () => number
} {
  let calls = 0
  return {
    ...controller,
    async documentAt(versionId?: string) {
      calls++
      return controller.documentAt(versionId)
    },
    calls: () => calls
  }
}

/**
 * A three-entry log by one client, plus the full verification of its first
 * two entries as the record to resume.
 */
async function makeResumableLog() {
  const alice = await makeLogClient()
  const controller = counting(
    fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }]
    })
  )
  const genesis = await buildResourceLogGenesis({
    state: state(1),
    method: METHOD,
    controller,
    signer: alice.logSigner
  })
  const second = await buildResourceLogEntry({
    head: genesis,
    state: state(2),
    controller,
    signer: alice.logSigner
  })
  const third = await buildResourceLogEntry({
    head: second,
    state: state(3),
    controller,
    signer: alice.logSigner
  })
  const previous = await verifyResourceLog({
    entries: [genesis, second],
    controller,
    expectedMethod: METHOD
  })
  expect(controller.calls()).toBe(2)
  return { alice, controller, genesis, second, third, previous }
}

describe('verifyResourceLog (resumed from a previous verification)', () => {
  it('verifies only the entries past the record and resolves the same result', async () => {
    const { controller, genesis, second, third, previous } =
      await makeResumableLog()
    const full = await verifyResourceLog({
      entries: [genesis, second, third],
      controller,
      expectedMethod: METHOD,
      pin: previous.pin
    })
    const callsAfterFull = controller.calls()
    expect(callsAfterFull).toBe(5)
    const resumed = await verifyResourceLog({
      entries: [genesis, second, third],
      controller,
      expectedMethod: METHOD,
      pin: previous.pin,
      previous
    })
    expect(controller.calls() - callsAfterFull).toBe(1)
    expect(resumed).toEqual(full)
    expect(resumed.entries).toEqual([genesis, second, third])
  })

  it('verifies nothing when the served log is the record', async () => {
    const { controller, genesis, second, previous } = await makeResumableLog()
    const before = controller.calls()
    const resumed = await verifyResourceLog({
      entries: [genesis, second],
      controller,
      expectedMethod: METHOD,
      pin: previous.pin,
      previous
    })
    expect(controller.calls()).toBe(before)
    expect(resumed).toEqual(previous)
  })

  it('hands out the record entries, not the served prefix bytes', async () => {
    const { controller, genesis, second, third, previous } =
      await makeResumableLog()
    // A host serving the prefix with its proofs stripped: the hash chain
    // still matches, so the pass resumes, and the result carries the
    // record's own entries.
    const stripped = { ...genesis, proof: [] } as ResourceLogEntry
    const resumed = await verifyResourceLog({
      entries: [stripped, second, third],
      controller,
      expectedMethod: METHOD,
      previous
    })
    expect(resumed.entries[0]).toEqual(genesis)
    expect(resumed.entries[0]).not.toBe(stripped)
  })

  it('refuses a tail that does not chain to the record head', async () => {
    const { alice, controller, genesis, second, previous } =
      await makeResumableLog()
    const detached = await buildResourceLogEntry({
      head: genesis,
      state: state(3),
      controller,
      signer: alice.logSigner
    })
    // Placed third, it hashes to the genesis, not to the second entry.
    const forged = {
      ...detached,
      versionId: `3-${detached.versionId.slice(2)}`
    }
    await expect(
      verifyResourceLog({
        entries: [genesis, second, forged],
        controller,
        expectedMethod: METHOD,
        previous
      })
    ).rejects.toMatchObject({ name: 'ResourceLogIntegrityError' })
  })

  it('refuses a tail signed by a key outside the controller', async () => {
    const { controller, genesis, second, previous } = await makeResumableLog()
    const mallory = await makeLogClient()
    const forged = await buildResourceLogEntry({
      head: second,
      state: state(3),
      controller,
      signer: mallory.logSigner
    })
    await expect(
      verifyResourceLog({
        entries: [genesis, second, forged],
        controller,
        expectedMethod: METHOD,
        previous
      })
    ).rejects.toMatchObject({ name: 'ResourceLogIntegrityError' })
  })

  it('verifies a served log that does not extend the record in full', async () => {
    const { alice, controller, genesis, previous } = await makeResumableLog()
    // A sibling second entry: the served log forks from the record.
    const sibling = await buildResourceLogEntry({
      head: genesis,
      state: state(22),
      controller,
      signer: alice.logSigner
    })
    const before = controller.calls()
    // Without a pin the fork is a valid log in its own right, verified in
    // full (two entries).
    const verified = await verifyResourceLog({
      entries: [genesis, sibling],
      controller,
      expectedMethod: METHOD,
      previous
    })
    expect(controller.calls() - before).toBe(2)
    expect(verified.state).toEqual(state(22))
    // Under the record's pin it is the fork refusal, as without a record.
    await expect(
      verifyResourceLog({
        entries: [genesis, sibling],
        controller,
        expectedMethod: METHOD,
        pin: previous.pin,
        previous
      })
    ).rejects.toMatchObject({
      name: 'ResourceLogContinuityError',
      reason: 'fork'
    })
  })

  it('verifies a served log shorter than the record in full', async () => {
    const { controller, genesis, previous } = await makeResumableLog()
    await expect(
      verifyResourceLog({
        entries: [genesis],
        controller,
        expectedMethod: METHOD,
        pin: previous.pin,
        previous
      })
    ).rejects.toMatchObject({
      name: 'ResourceLogContinuityError',
      reason: 'rollback'
    })
    const verified = await verifyResourceLog({
      entries: [genesis],
      controller,
      expectedMethod: METHOD,
      previous
    })
    expect(verified.entries).toEqual([genesis])
  })

  it('refuses a continuation past a record whose head is terminal', async () => {
    const { alice, controller, genesis, second } = await makeResumableLog()
    const terminal = await buildTerminalEntry({
      head: second,
      nextLog: { method: METHOD, scid: 'next' },
      controller,
      signer: alice.logSigner
    })
    const closed = await verifyResourceLog({
      entries: [genesis, second, terminal],
      controller,
      expectedMethod: METHOD
    })
    expect(closed.terminal).toEqual({ method: METHOD, scid: 'next' })
    const continued = await buildResourceLogEntry({
      head: terminal,
      state: state(4),
      controller,
      signer: alice.logSigner
    })
    await expect(
      verifyResourceLog({
        entries: [genesis, second, terminal, continued],
        controller,
        expectedMethod: METHOD,
        previous: closed
      })
    ).rejects.toThrow(/continues past a terminal/)
  })

  it('carries the record head controller version into monotonicity', async () => {
    const alice = await makeLogClient()
    const bob = await makeLogClient()
    const v1 = fakeController({
      versions: [
        { versionId: '1-v1', keys: [alice.signingKeyMultibase] },
        {
          versionId: '2-v2',
          keys: [alice.signingKeyMultibase, bob.signingKeyMultibase]
        }
      ]
    })
    const genesis = await buildResourceLogGenesis({
      state: state(1),
      method: METHOD,
      controller: v1,
      signer: alice.logSigner
    })
    // The second entry is signed at the controller's second version.
    const second = await buildResourceLogEntry({
      head: genesis,
      state: state(2),
      controller: v1,
      signer: bob.logSigner
    })
    const previous = await verifyResourceLog({
      entries: [genesis, second],
      controller: v1,
      expectedMethod: METHOD
    })
    expect(previous.headControllerVersionIndex).toBe(1)
    // A third entry signed back at the first version: behind the head.
    const behind = await buildResourceLogEntry({
      head: second,
      state: state(3),
      controller: fakeController({
        versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }]
      }),
      signer: alice.logSigner
    })
    await expect(
      verifyResourceLog({
        entries: [genesis, second, behind],
        controller: v1,
        expectedMethod: METHOD,
        previous
      })
    ).rejects.toThrow(/behind its predecessor/)
  })

  it('verifies in full against the other kind of controller view', async () => {
    const alice = await makeLogClient()
    const unversioned = fakeController({
      versions: [],
      currentKeys: [alice.signingKeyMultibase]
    })
    const genesis = await buildResourceLogGenesis({
      state: state(1),
      method: METHOD,
      controller: unversioned,
      signer: alice.logSigner
    })
    const previous = await verifyResourceLog({
      entries: [genesis],
      controller: unversioned,
      expectedMethod: METHOD
    })
    const versioned = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }]
    })
    await expect(
      verifyResourceLog({
        entries: [genesis],
        controller: versioned,
        expectedMethod: METHOD,
        previous
      })
    ).rejects.toThrow(/carries no controller versionId/)
  })
})

/**
 * A log created by alice, with reads and appends bound to her view and pin
 * store, plus bob appending under his own view and pin store so his writes
 * never touch alice's counters.
 */
async function makeWriter() {
  const alice = await makeLogClient()
  const bob = await makeLogClient()
  const versions = [
    {
      versionId: '1-v1',
      keys: [alice.signingKeyMultibase, bob.signingKeyMultibase]
    }
  ]
  const controller = counting(fakeController({ versions }))
  const store = memoryLogStore()
  const pinStore = memoryResourceLogPinStore()
  const { verified } = await createResourceLog({
    store,
    controller,
    method: METHOD,
    pinStore,
    logId: LOG_ID,
    signer: alice.logSigner,
    state: state(1)
  })
  const common = { controller, expectedMethod: METHOD, pinStore, logId: LOG_ID }
  return {
    alice,
    controller,
    store,
    pinStore,
    verified,
    async read(previous?: VerifiedResourceLog) {
      return readResourceLog({ store, ...common, previous })
    },
    async append({
      buildState,
      current,
      store: racingStore = store
    }: Pick<
      Parameters<typeof appendResourceLog>[0],
      'buildState' | 'current'
    > & {
      store?: typeof store
    }) {
      return appendResourceLog({
        store: racingStore,
        ...common,
        signer: alice.logSigner,
        buildState,
        current
      })
    },
    async bobAppends(value: number) {
      await appendResourceLog({
        store,
        controller: fakeController({ versions }),
        expectedMethod: METHOD,
        pinStore: memoryResourceLogPinStore(),
        logId: LOG_ID,
        signer: bob.logSigner,
        buildState: () => state(value)
      })
    }
  }
}

describe('readResourceLog and appendResourceLog (resumed)', () => {
  it('a repeat read verifies only the entries added since', async () => {
    const { controller, pinStore, verified, read, append } = await makeWriter()
    await append({ buildState: () => state(2) })
    const before = controller.calls()
    const current = await read(verified)
    expect(controller.calls() - before).toBe(1)
    expect(current!.verified.entries).toHaveLength(2)
    expect(await pinStore.read({ logId: LOG_ID })).toEqual(
      current!.verified.pin
    )
    const again = await read(current!.verified)
    expect(controller.calls() - before).toBe(1)
    expect(again!.verified).toEqual(current!.verified)
  })

  it('an append seeded by a read verifies only its own entry on read-back', async () => {
    const { controller, read, append } = await makeWriter()
    const current = await read()
    const before = controller.calls()
    const confirmed = await append({
      buildState: () => state(2),
      current: current!
    })
    // The pre-write pass checks the candidate once; the read-back verifies
    // it once more, and nothing before it.
    expect(controller.calls() - before).toBe(2)
    expect(confirmed.entries).toHaveLength(2)
  })

  it('a seed without a validator still resumes the first read', async () => {
    const { controller, verified, append } = await makeWriter()
    const before = controller.calls()
    const confirmed = await append({
      buildState: () => state(2),
      current: { verified }
    })
    // The read resumes at the genesis (nothing to verify), then the
    // candidate is checked pre-write and on read-back.
    expect(controller.calls() - before).toBe(2)
    expect(confirmed.entries).toHaveLength(2)
  })
})

describe('appendResourceLog (resumed across a lost race and a moved pin)', () => {
  it('a lost race re-reads from the lost attempt and verifies only the winner', async () => {
    const { controller, store, pinStore, verified, append, bobAppends } =
      await makeWriter()
    let raced = false
    const racingStore = {
      ...store,
      async append(
        entry: Parameters<typeof store.append>[0],
        options: Parameters<typeof store.append>[1]
      ) {
        if (!raced) {
          raced = true
          await bobAppends(100)
        }
        return store.append(entry, options)
      }
    }
    const before = controller.calls()
    const rebasedOn: number[] = []
    const confirmed = await append({
      store: racingStore,
      buildState: current => {
        rebasedOn.push(current.state.value as number)
        return state((current.state.value as number) + 1)
      },
      current: { verified }
    })
    // The seeded read verifies nothing (the log is the seed); the lost
    // candidate is checked pre-write; the re-read verifies bob's entry only;
    // the rebased candidate is checked pre-write and once more on read-back.
    expect(controller.calls() - before).toBe(4)
    expect(rebasedOn).toEqual([1, 100])
    expect(confirmed.entries).toHaveLength(3)
    expect(confirmed.state).toEqual(state(101))
    expect(await pinStore.read({ logId: LOG_ID })).toEqual(confirmed.pin)
  })

  it('a record behind a pin that already advanced still resumes and pins', async () => {
    const { controller, pinStore, verified, read, bobAppends } =
      await makeWriter()
    await bobAppends(100)
    // Another read on this pin store advances the pin past the record.
    const advanced = await read()
    await bobAppends(200)
    const before = controller.calls()
    const current = await read(verified)
    expect(controller.calls() - before).toBe(2)
    expect(current!.verified.entries).toHaveLength(3)
    expect(current!.verified.entries[1]).toEqual(advanced!.verified.head)
    expect(await pinStore.read({ logId: LOG_ID })).toEqual(
      current!.verified.pin
    )
  })

  it('a record behind a pin refuses a served log that forks past the record', async () => {
    const { alice, controller, store, verified, read, bobAppends } =
      await makeWriter()
    await bobAppends(100)
    await read()
    // The host replaces bob's entry with another one built on the same
    // genesis: the record still matches, the pin does not.
    const forked = await buildResourceLogEntry({
      head: verified.head,
      state: state(7),
      controller,
      signer: alice.logSigner
    })
    store._setEntries([verified.head, forked])
    await expect(read(verified)).rejects.toMatchObject({
      name: 'ResourceLogContinuityError',
      reason: 'fork',
      servedEntries: [verified.head, forked]
    })
  })
})

describe('verifyResourceLog (record from another controller view)', () => {
  it('verifies in full when the record head version is not at its index', async () => {
    const { alice, genesis, second, third, previous } = await makeResumableLog()
    // A view whose `versionIds` list puts another version at the record's
    // head index: the record's index would name the wrong version here.
    const shifted = counting(
      fakeController({
        versions: [
          { versionId: '1-v0', keys: [alice.signingKeyMultibase] },
          { versionId: '1-v1', keys: [alice.signingKeyMultibase] }
        ]
      })
    )
    const before = shifted.calls()
    const verified = await verifyResourceLog({
      entries: [genesis, second, third],
      controller: shifted,
      expectedMethod: METHOD,
      previous
    })
    expect(shifted.calls() - before).toBe(3)
    expect(verified.headControllerVersionIndex).toBe(1)
  })
})
