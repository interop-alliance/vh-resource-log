/**
 * The browser smoke-test harness, imported into the page by the Playwright
 * spec through the Vite dev server. It exercises the library's full positive
 * path in a real browser build -- mint an Ed25519 signer, build a genesis and
 * an append, verify the log, advance the in-memory pin -- plus one
 * fabrication refusal, covering the `@interop/did-method-webvh` kernel and
 * `@noble/curves` under the browser bundle.
 */
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import {
  buildResourceLogEntry,
  buildResourceLogGenesis,
  verifyResourceLog,
  type ResourceLogSigner
} from '../../src/index.js'
import { fakeController } from '../../src/testing.js'

const METHOD = 'resource-log:0.1'

/**
 * Runs the smoke flow and reports what the spec asserts on.
 *
 * @returns {Promise<object>}
 */
export async function runBrowserSmoke(): Promise<{
  state: unknown
  headOrdinal: number
  tamperRefusalName: string | null
}> {
  const signingKey = await Ed25519VerificationKey.generate()
  const keyMultibase = signingKey.publicKeyMultibase as string
  const signingDid = `did:key:${keyMultibase}`
  signingKey.controller = signingDid
  signingKey.id = `${signingDid}#${keyMultibase}`
  const rawSigner = signingKey.signer()
  const signer: ResourceLogSigner = {
    keyMultibase,
    async sign({ data }: { data: Uint8Array }): Promise<Uint8Array> {
      const signature = await rawSigner.sign({ data })
      return new Uint8Array(
        signature.buffer,
        signature.byteOffset,
        signature.byteLength
      )
    }
  }
  const controller = fakeController({
    versions: [{ versionId: '1-v1', keys: [keyMultibase] }]
  })
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
  const verified = await verifyResourceLog({
    entries: [genesis, second],
    controller,
    expectedMethod: METHOD
  })

  const tampered = structuredClone([genesis, second])
  ;(tampered[1]!.state as unknown as { value: number }).value = 999
  let tamperRefusalName: string | null = null
  try {
    await verifyResourceLog({
      entries: tampered,
      controller,
      expectedMethod: METHOD
    })
  } catch (err) {
    tamperRefusalName = err instanceof Error ? err.name : 'not-an-error'
  }

  return {
    state: verified.state,
    headOrdinal: Number.parseInt(verified.head.versionId, 10),
    tamperRefusalName
  }
}
