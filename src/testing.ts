/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * TEST FIXTURES ONLY, published as the `./testing` subpath so this library's
 * consumers exercise their log-driving code against one shared reference
 * implementation of the ports instead of re-deriving fakes: a fake
 * `ResourceLogController` and an in-memory `ResourceLogStore`.
 *
 * Never import this subpath from production code. The fake controller
 * neuters the authorization root (any configured key authorizes, no document
 * is verified anywhere) and the memory store neuters durability (fabricated
 * etags, nothing persisted) -- both while appearing to work. Consumers keep a
 * lint restriction excluding `@interop/vh-resource-log/testing` from
 * non-test globs.
 */
import type { ResourceLogController } from './controller.js'
import type { ControllerDocument, VerificationMethodShape } from './document.js'
import { ResourceLogConflictError } from './errors.js'
import type { ResourceLogEntry } from '@interop/storage-core'
import type { ResourceLogStore } from './store.js'

/**
 * The account DID the fake controller answers for by default.
 */
export const CONTROLLER_DID = 'did:webvh:QmScid:example.com:space:abc:id'

/**
 * A fake `ResourceLogController`: an ordered controller-log version list with
 * a synthesized controller document per version. Each version's `keys` are
 * published as the methods `${did}#${key}` carrying `publicKeyMultibase: key`
 * (the id this stack mints a method under) and referenced from
 * `assertionMethod`; its `methods` are embedded in `assertionMethod`
 * verbatim, for a document whose member id and published key disagree, or
 * whose member publishes no key. An empty `versions` list models an
 * unversioned static controller; `currentKeys` then supplies the current
 * document (for a versioned controller the last version is the current
 * document). A versionId the list does not carry rejects, as the port
 * requires. Controller-domain admission policy is the caller's: pass
 * `admitAppend` to attach one (a consumer testing its own hook), or a
 * wrapper can extend the returned view -- the fixture itself carries none,
 * exactly as the library's port does.
 *
 * @param options {object}
 * @param [options.did] {string}
 * @param options.versions {Array<{ versionId: string, keys: string[], methods?: VerificationMethodShape[] }>}
 * @param [options.currentKeys] {string[]}   unversioned controllers only
 * @param [options.admitAppend] {function}   the admission hook to attach
 * @returns {ResourceLogController}
 */
export function fakeController({
  did = CONTROLLER_DID,
  versions,
  currentKeys = [],
  admitAppend
}: {
  did?: string
  versions: Array<{
    versionId: string
    keys: string[]
    methods?: VerificationMethodShape[]
  }>
  currentKeys?: string[]
  admitAppend?: ResourceLogController['admitAppend']
}): ResourceLogController {
  function documentOf({
    keys,
    methods = []
  }: {
    keys: string[]
    methods?: VerificationMethodShape[]
  }): ControllerDocument {
    const verificationMethod = keys.map(key => ({
      id: `${did}#${key}`,
      type: 'Multikey',
      controller: did,
      publicKeyMultibase: key
    }))
    return {
      verificationMethod,
      assertionMethod: [
        ...verificationMethod.map(method => method.id),
        ...methods
      ]
    }
  }
  return {
    did,
    versionIds: versions.map(version => version.versionId),
    async documentAt(versionId?: string): Promise<ControllerDocument> {
      const version =
        versionId === undefined
          ? versions[versions.length - 1]
          : versions.find(entry => entry.versionId === versionId)
      if (version === undefined && versionId !== undefined) {
        throw new Error(`fake controller has no version "${versionId}"`)
      }
      return documentOf(version ?? { keys: currentKeys })
    },
    ...(admitAppend === undefined ? {} : { admitAppend })
  }
}

/**
 * An in-memory `ResourceLogStore` with a monotonic version counter as the
 * compare-and-swap etag ({@link ResourceLogConflictError} on a stale
 * validator or a lost guarded create), plus control seams so tests can play a
 * tampering or replaying host (`_setEntries`) and a backend that versions
 * nothing (`_withholdEtag`).
 *
 * @returns {ResourceLogStore & object}
 */
export function memoryLogStore(): ResourceLogStore & {
  _getEntries(): ResourceLogEntry[] | null
  _setEntries(entries: ResourceLogEntry[] | null): void
  _withholdEtag(withhold: boolean): void
} {
  let entries: ResourceLogEntry[] | null = null
  let version = 0
  let withholdEtag = false
  return {
    async read() {
      if (entries === null) {
        return null
      }
      return withholdEtag
        ? { entries: structuredClone(entries) }
        : { entries: structuredClone(entries), etag: `v${version}` }
    },
    async append(entry, { ifMatch }: { ifMatch: string }) {
      if (entries === null || ifMatch !== `v${version}`) {
        throw new ResourceLogConflictError('stale log etag')
      }
      entries = [...entries, structuredClone(entry)]
      version++
    },
    async create(entry) {
      if (entries !== null) {
        throw new ResourceLogConflictError('log already exists')
      }
      entries = [structuredClone(entry)]
      version++
    },
    _getEntries() {
      return entries ? structuredClone(entries) : null
    },
    _setEntries(next) {
      entries = next ? structuredClone(next) : null
      version++
    },
    _withholdEtag(withhold: boolean) {
      withholdEtag = withhold
    }
  }
}
