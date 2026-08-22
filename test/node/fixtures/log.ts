/**
 * Shared fixtures for the resource-log suites, beside the published fakes
 * (`src/testing.ts`, the `./testing` subpath: `fakeController`,
 * `memoryLogStore`): a signing-client fixture (a fresh Ed25519 key wrapped as
 * a `ResourceLogSigner`), a co-signing helper that appends a second proof to
 * an already-signed entry, and a terminal handover-entry builder (nothing in
 * `src/` emits terminal entries yet, so the suite constructs them from the
 * kernel primitives directly).
 */
import {
  buildVersionId,
  createDataIntegrityProofTemplate,
  deriveHash,
  signDataIntegrityProof,
  signerFromExternalKey
} from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import type { ResourceLogEntry } from '@interop/storage-core'
import type {
  ResourceLogController,
  ResourceLogSigner
} from '../../../src/index.js'

/**
 * A test log-writing client: its Ed25519 signing key's public multibase (the
 * controller-document verification method its entry proofs resolve against)
 * and the {@link ResourceLogSigner} its appends sign with.
 */
export interface LogTestClient {
  signingKeyMultibase: string
  logSigner: ResourceLogSigner
}

/**
 * Mints a fresh {@link LogTestClient}.
 *
 * @returns {Promise<LogTestClient>}
 */
export async function makeLogClient(): Promise<LogTestClient> {
  const signingKey = await Ed25519VerificationKey.generate()
  const signingKeyMultibase = signingKey.publicKeyMultibase as string
  const signingDid = `did:key:${signingKeyMultibase}`
  signingKey.controller = signingDid
  signingKey.id = `${signingDid}#${signingKeyMultibase}`
  const signer = signingKey.signer()
  return {
    signingKeyMultibase,
    logSigner: {
      keyMultibase: signingKeyMultibase,
      async sign({ data }: { data: Uint8Array }): Promise<Uint8Array> {
        const signature = await signer.sign({ data })
        // Re-wrap as a plain Uint8Array: a signer may return a Node Buffer
        // (or a cross-realm view), which the kernel's strict byte check
        // rejects.
        return new Uint8Array(
          signature.buffer,
          signature.byteOffset,
          signature.byteLength
        )
      }
    }
  }
}

/**
 * The writer's anchored verification-method DID URL, exactly as the entry
 * builders construct it: the anchor is the controller's verified head (omitted
 * for an unversioned controller).
 *
 * @param options {object}
 * @param options.controller {ResourceLogController}
 * @param options.keyMultibase {string}
 * @returns {string}
 */
export function anchoredVm({
  controller,
  keyMultibase
}: {
  controller: ResourceLogController
  keyMultibase: string
}): string {
  const anchor = controller.versionIds[controller.versionIds.length - 1]
  const query = anchor === undefined ? '' : `?versionId=${anchor}`
  return `${controller.did}${query}#${keyMultibase}`
}

/**
 * Co-signs an already-signed entry: returns it with one more proof appended,
 * signed by `signer` under its anchored verification method and carrying the
 * entry's own `versionTime` as the proof's `created` time. Multi-proof entries
 * are legal in the profile, and the added proof sits in a later array
 * position -- the placement a per-entry admission hook would never see.
 *
 * @param options {object}
 * @param options.entry {ResourceLogEntry}
 * @param options.controller {ResourceLogController}
 * @param options.signer {ResourceLogSigner}
 * @returns {Promise<ResourceLogEntry>}
 */
export async function coSignEntry({
  entry,
  controller,
  signer
}: {
  entry: ResourceLogEntry
  controller: ResourceLogController
  signer: ResourceLogSigner
}): Promise<ResourceLogEntry> {
  const { proof: _omitted, ...unsigned } = entry
  const coSignature = await signDataIntegrityProof(
    unsigned,
    createDataIntegrityProofTemplate({
      verificationMethod: anchoredVm({
        controller,
        keyMultibase: signer.keyMultibase
      }),
      created: entry.versionTime
    }),
    signerFromExternalKey({
      publicKeyMultibase: signer.keyMultibase,
      sign: signer.sign
    })
  )
  return {
    ...entry,
    proof: [...entry.proof, coSignature as ResourceLogEntry['proof'][number]]
  }
}

/**
 * Builds and signs a terminal handover entry against a verified head: the
 * profile's `{ nextLog }` parameters, the predecessor's state verbatim (a
 * handover changes no resource state), hash chained off the head.
 *
 * @param options {object}
 * @param options.head {ResourceLogEntry}
 * @param options.nextLog {{ method: string, scid: string }}
 * @param options.controller {ResourceLogController}
 * @param options.signer {ResourceLogSigner}
 * @param [options.versionTime] {string}
 * @returns {Promise<ResourceLogEntry>}
 */
export async function buildTerminalEntry({
  head,
  nextLog,
  controller,
  signer,
  versionTime
}: {
  head: ResourceLogEntry
  nextLog: { method: string; scid: string }
  controller: ResourceLogController
  signer: ResourceLogSigner
  versionTime?: string
}): Promise<ResourceLogEntry> {
  const time = versionTime ?? new Date().toISOString()
  const ordinal = Number.parseInt(head.versionId, 10) + 1
  const parameters = { nextLog }
  const entryHash = await deriveHash({
    versionId: head.versionId,
    versionTime: time,
    parameters,
    state: head.state
  })
  const entry = {
    versionId: buildVersionId(ordinal, entryHash),
    versionTime: time,
    parameters,
    state: head.state
  }
  const proof = await signDataIntegrityProof(
    entry,
    createDataIntegrityProofTemplate({
      verificationMethod: anchoredVm({
        controller,
        keyMultibase: signer.keyMultibase
      }),
      created: time
    }),
    signerFromExternalKey({
      publicKeyMultibase: signer.keyMultibase,
      sign: signer.sign
    })
  )
  return {
    ...entry,
    proof: [proof as ResourceLogEntry['proof'][number]]
  }
}
