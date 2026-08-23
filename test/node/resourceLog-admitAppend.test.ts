/**
 * Unit tests for the controller port's `admitAppend` admission hook
 * (`src/controller.ts`, called from `src/verify.ts`): the seam through which
 * a consumer's controller-domain append policy (wallet-core's ceremony-tail
 * license on ladder-signed appends) reaches the generic verifier. The library
 * itself carries no admission policy -- a hook-less controller admits every
 * membership-passing append, which is exactly why a controller port over a
 * document that can list ladder-shaped verification methods must supply the
 * hook -- and the hook runs after the entry's proofs have verified, outside
 * the integrity wrap: a forged signature is refused as the integrity class
 * whatever the hook would have said, and a hook throw keeps its own class.
 * The same rules hold on the write path, where the pre-write pass consults
 * the hook on the writer's own candidate (`resourceLog-append.test.ts`).
 */
import { describe, expect, it } from 'vitest'
import {
  buildResourceLogEntry,
  buildResourceLogGenesis,
  verifyResourceLog,
  ResourceLogIntegrityError
} from '../../src/index.js'
import { fakeController } from '../../src/testing.js'
import { coSignEntry, makeLogClient } from './fixtures/log.js'

const METHOD = 'resource-log:0.1'

/**
 * A refusal class standing in for a consumer's admission policy error (the
 * shape wallet-core's `ResourceLogLicenseError` takes): its identity must
 * survive the verifier untouched.
 */
class FakeAdmissionRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FakeAdmissionRefusal'
  }
}

/**
 * A two-entry log signed by one client, built against the given controller.
 */
async function makeTwoEntryLog(
  controller: Parameters<typeof buildResourceLogGenesis>[0]['controller'],
  signer: Awaited<ReturnType<typeof makeLogClient>>['logSigner']
) {
  const genesis = await buildResourceLogGenesis({
    state: { type: 'TestState', value: 1 },
    method: METHOD,
    controller,
    signer
  })
  const second = await buildResourceLogEntry({
    head: genesis,
    state: { type: 'TestState', value: 2 },
    controller,
    signer
  })
  return [genesis, second]
}

describe('the admitAppend admission hook', () => {
  it('is consulted per proof for every entry past genesis, with the documented input', async () => {
    const alice = await makeLogClient()
    const seen: unknown[] = []
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }],
      admitAppend: async input => {
        seen.push(input)
      }
    })
    const entries = await makeTwoEntryLog(controller, alice.logSigner)
    await verifyResourceLog({ entries, controller, expectedMethod: METHOD })
    // The genesis entry is exempt; the second entry's one proof is admitted.
    expect(seen).toEqual([
      {
        ordinal: 2,
        keyMultibase: alice.signingKeyMultibase,
        controllerVersionId: '1-v1',
        controllerVersionIndex: 0,
        headControllerVersionIndex: 0
      }
    ])
  })

  it('sees every proof of a multi-proof entry (per-proof placement)', async () => {
    const alice = await makeLogClient()
    const bob = await makeLogClient()
    const controller = fakeController({
      versions: [
        {
          versionId: '1-v1',
          keys: [alice.signingKeyMultibase, bob.signingKeyMultibase]
        }
      ]
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
    // Bob co-signs the second entry: a second proof in a later array
    // position, which a per-entry hook would never see.
    const coSigned = await coSignEntry({
      entry: second,
      controller,
      signer: bob.logSigner
    })
    const admitted: string[] = []
    const watching = fakeController({
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
    await verifyResourceLog({
      entries: [genesis, coSigned],
      controller: watching,
      expectedMethod: METHOD
    })
    expect(admitted.sort()).toEqual(
      [alice.signingKeyMultibase, bob.signingKeyMultibase].sort()
    )
  })

  it('propagates a hook refusal with its class intact (no integrity wrap)', async () => {
    const alice = await makeLogClient()
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }],
      admitAppend: async () => {
        throw new FakeAdmissionRefusal('not licensed')
      }
    })
    const entries = await makeTwoEntryLog(controller, alice.logSigner)
    let refusal: unknown
    try {
      await verifyResourceLog({ entries, controller, expectedMethod: METHOD })
    } catch (err) {
      refusal = err
    }
    expect(refusal).toBeInstanceOf(FakeAdmissionRefusal)
  })

  it('propagates a hook-internal bug raw too (not evidence of a doctored log)', async () => {
    const alice = await makeLogClient()
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }],
      admitAppend: async () => {
        throw new TypeError('hook bug')
      }
    })
    const entries = await makeTwoEntryLog(controller, alice.logSigner)
    await expect(
      verifyResourceLog({ entries, controller, expectedMethod: METHOD })
    ).rejects.toBeInstanceOf(TypeError)
  })

  it('still wraps a kernel proof failure as the integrity class beside the hook', async () => {
    const alice = await makeLogClient()
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }],
      admitAppend: async () => {}
    })
    const entries = await makeTwoEntryLog(controller, alice.logSigner)
    const tampered = structuredClone(entries)
    tampered[1]!.proof[0]!.proofValue = 'z3BadSignatureValueBadSignatureValue'
    await expect(
      verifyResourceLog({
        entries: tampered,
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toBeInstanceOf(ResourceLogIntegrityError)
  })

  it('refuses a forged proofValue as the integrity class, hook never called', async () => {
    const alice = await makeLogClient()
    let calls = 0
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }],
      admitAppend: async () => {
        calls++
        throw new FakeAdmissionRefusal('not licensed')
      }
    })
    const entries = await makeTwoEntryLog(controller, alice.logSigner)
    const tampered = structuredClone(entries)
    tampered[1]!.proof[0]!.proofValue = 'z3BadSignatureValueBadSignatureValue'
    await expect(
      verifyResourceLog({
        entries: tampered,
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toBeInstanceOf(ResourceLogIntegrityError)
    expect(calls).toBe(0)
  })

  it('never consults the hook when a later proof of a co-signed entry is forged', async () => {
    const alice = await makeLogClient()
    const bob = await makeLogClient()
    const versions = [
      {
        versionId: '1-v1',
        keys: [alice.signingKeyMultibase, bob.signingKeyMultibase]
      }
    ]
    const admitted: string[] = []
    const controller = fakeController({
      versions,
      admitAppend: async ({ keyMultibase }) => {
        admitted.push(keyMultibase)
      }
    })
    const [genesis, second] = await makeTwoEntryLog(controller, alice.logSigner)
    const coSigned = await coSignEntry({
      entry: second!,
      controller,
      signer: bob.logSigner
    })
    coSigned.proof[1]!.proofValue = 'z3BadSignatureValueBadSignatureValue'
    await expect(
      verifyResourceLog({
        entries: [genesis!, coSigned],
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toBeInstanceOf(ResourceLogIntegrityError)
    // Not even for Alice's valid first proof: the drain runs only once every
    // proof of the entry has verified.
    expect(admitted).toEqual([])
  })

  it('refuses a co-signed entry with a forged proof as integrity, not as the hook refusal', async () => {
    const alice = await makeLogClient()
    const bob = await makeLogClient()
    const versions = [
      {
        versionId: '1-v1',
        keys: [alice.signingKeyMultibase, bob.signingKeyMultibase]
      }
    ]
    const controller = fakeController({
      versions,
      admitAppend: async ({ keyMultibase }) => {
        if (keyMultibase === alice.signingKeyMultibase) {
          throw new FakeAdmissionRefusal('alice is not licensed')
        }
      }
    })
    const [genesis, second] = await makeTwoEntryLog(controller, alice.logSigner)
    const coSigned = await coSignEntry({
      entry: second!,
      controller,
      signer: bob.logSigner
    })
    coSigned.proof[1]!.proofValue = 'z3BadSignatureValueBadSignatureValue'
    await expect(
      verifyResourceLog({
        entries: [genesis!, coSigned],
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toBeInstanceOf(ResourceLogIntegrityError)
  })

  it("hands the hook the version floor of the entries before it, not the entry's own controller versionId", async () => {
    const alice = await makeLogClient()
    const bob = await makeLogClient()
    const versions = [
      { versionId: '1-v1', keys: [alice.signingKeyMultibase] },
      {
        versionId: '2-v2',
        keys: [alice.signingKeyMultibase, bob.signingKeyMultibase]
      }
    ]
    // Entries 1 and 2 are built against a view carrying only 1-v1, so they
    // carry that controller version (index 0); entry 3 is built against the
    // full view and carries controller version 2-v2 (index 1).
    const atFirstVersion = fakeController({ versions: [versions[0]!] })
    const [genesis, second] = await makeTwoEntryLog(
      atFirstVersion,
      alice.logSigner
    )
    const atSecondVersion = fakeController({ versions })
    const third = await buildResourceLogEntry({
      head: second!,
      state: { type: 'TestState', value: 3 },
      controller: atSecondVersion,
      signer: alice.logSigner
    })
    const coSignedThird = await coSignEntry({
      entry: third,
      controller: atSecondVersion,
      signer: bob.logSigner
    })
    const seen: Array<{
      ordinal: number
      controllerVersionIndex: number | null
      headControllerVersionIndex: number
    }> = []
    const watching = fakeController({
      versions,
      admitAppend: async ({
        ordinal,
        controllerVersionIndex,
        headControllerVersionIndex
      }) => {
        seen.push({
          ordinal,
          controllerVersionIndex,
          headControllerVersionIndex
        })
      }
    })
    await verifyResourceLog({
      entries: [genesis!, second!, coSignedThird],
      controller: watching,
      expectedMethod: METHOD
    })
    // headControllerVersionIndex is the floor the previous entries left
    // behind, so entry 3 still sees 0 (entry 2's controller version) even
    // though it carries controller version index 1: the drain runs before
    // the floor advances.
    expect(seen).toEqual([
      { ordinal: 2, controllerVersionIndex: 0, headControllerVersionIndex: 0 },
      { ordinal: 3, controllerVersionIndex: 1, headControllerVersionIndex: 0 },
      { ordinal: 3, controllerVersionIndex: 1, headControllerVersionIndex: 0 }
    ])
    // Both proofs of entry 3 read the same floor: it does not move between
    // one proof of an entry and the next.
    expect(seen[1]!.headControllerVersionIndex).toBe(
      seen[2]!.headControllerVersionIndex
    )
  })

  it('refuses an entry served with an empty proof array before any admission', async () => {
    const alice = await makeLogClient()
    let calls = 0
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }],
      admitAppend: async () => {
        calls++
      }
    })
    const entries = await makeTwoEntryLog(controller, alice.logSigner)
    const stripped = structuredClone(entries)
    stripped[1]!.proof = []
    await expect(
      verifyResourceLog({
        entries: stripped,
        controller,
        expectedMethod: METHOD
      })
    ).rejects.toBeInstanceOf(ResourceLogIntegrityError)
    expect(calls).toBe(0)
  })

  it('admits without any admission step when no hook is supplied', async () => {
    // The library carries no license of its own: a hook-less controller
    // admits an append a policy-carrying adapter would refuse. This is why a
    // controller port over a document that can list ladder-shaped
    // verification methods MUST supply the hook.
    const alice = await makeLogClient()
    const hookless = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }]
    })
    const entries = await makeTwoEntryLog(hookless, alice.logSigner)
    const refusing = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }],
      admitAppend: async () => {
        throw new FakeAdmissionRefusal('a policy-carrying adapter refuses')
      }
    })
    await expect(
      verifyResourceLog({
        entries,
        controller: hookless,
        expectedMethod: METHOD
      })
    ).resolves.toBeDefined()
    await expect(
      verifyResourceLog({
        entries,
        controller: refusing,
        expectedMethod: METHOD
      })
    ).rejects.toBeInstanceOf(FakeAdmissionRefusal)
  })
})
