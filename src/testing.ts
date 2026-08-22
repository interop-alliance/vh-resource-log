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
import { ResourceLogConflictError } from './errors.js'
import type { ResourceLogEntry } from '@interop/storage-core'
import type { ResourceLogStore } from './store.js'

/**
 * The account DID the fake controller answers for by default.
 */
export const CONTROLLER_DID = 'did:webvh:QmScid:example.com:space:abc:id'

/**
 * A fake `ResourceLogController`: an ordered controller-log version list with
 * per-version `assertionMethod` key-multibase sets. An empty `versions` list
 * models an unversioned static controller; `currentKeys` then supplies the
 * current-document set (for a versioned controller the last version is the
 * current document). Controller-domain admission policy is the caller's:
 * pass `admitAppend` to attach one (a consumer testing its own hook), or a
 * wrapper can extend the returned view -- the fixture itself carries none,
 * exactly as the library's port does.
 *
 * @param options {object}
 * @param [options.did] {string}
 * @param options.versions {Array<{ versionId: string, keys: string[] }>}
 * @param [options.currentKeys] {string[]}   unversioned controllers only
 * @param [options.admitAppend] {function}   the admission hook to attach
 * @returns {ResourceLogController}
 */
export function fakeController({
  did = CONTROLLER_DID,
  versions,
  currentKeys,
  admitAppend
}: {
  did?: string
  versions: Array<{ versionId: string; keys: string[] }>
  currentKeys?: string[]
  admitAppend?: ResourceLogController['admitAppend']
}): ResourceLogController {
  function versionAt(versionId?: string) {
    if (versionId === undefined) {
      return versions[versions.length - 1]
    }
    const version = versions.find(entry => entry.versionId === versionId)
    if (!version) {
      throw new Error(`fake controller has no version "${versionId}"`)
    }
    return version
  }
  return {
    did,
    versionIds: versions.map(version => version.versionId),
    async assertionKeysAt(versionId?: string): Promise<Set<string>> {
      if (versionId === undefined && versions.length === 0) {
        return new Set(currentKeys ?? [])
      }
      return new Set(versionAt(versionId)?.keys ?? [])
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
