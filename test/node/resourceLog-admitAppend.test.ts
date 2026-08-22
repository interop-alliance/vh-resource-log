/**
 * Unit tests for the controller port's `admitAppend` admission hook
 * (`src/controller.ts`, called from `src/verify.ts`): the seam through which
 * a consumer's controller-domain append policy (wallet-core's ceremony-tail
 * license on ladder-signed appends) reaches the generic verifier. The library
 * itself carries no admission policy -- a hook-less controller admits every
 * membership-passing append, which is exactly why a controller port over a
 * document that can list ladder-shaped verification methods must supply the
 * hook -- and a hook throw propagates with its class intact through the
 * capture mechanism, while kernel and proof failures keep wrapping as the
 * integrity class.
 */
import { describe, expect, it } from 'vitest'
import {
  buildResourceLogEntry,
  buildResourceLogGenesis,
  verifyResourceLog,
  ResourceLogIntegrityError
} from '../../src/index.js'
import { fakeController } from '../../src/testing.js'
import { anchoredVm, makeLogClient } from './fixtures/log.js'

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
        anchor: '1-v1',
        anchorIndex: 0,
        headAnchorIndex: 0
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
    const { signDataIntegrityProof, createDataIntegrityProofTemplate } =
      await import('@interop/did-method-webvh')
    const { signerFromExternalKey } = await import('@interop/did-method-webvh')
    const { proof: _omitted, ...unsigned } = second
    const bobProof = await signDataIntegrityProof(
      unsigned,
      createDataIntegrityProofTemplate({
        verificationMethod: anchoredVm({
          controller,
          keyMultibase: bob.logSigner.keyMultibase
        }),
        created: second.versionTime
      }),
      signerFromExternalKey({
        publicKeyMultibase: bob.logSigner.keyMultibase,
        sign: bob.logSigner.sign
      })
    )
    const coSigned = {
      ...second,
      proof: [...second.proof, bobProof as (typeof second.proof)[number]]
    }
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
