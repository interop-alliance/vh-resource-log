/**
 * Unit tests for `src/entry.ts`'s two guard seams that are not exercised
 * elsewhere as such: `versionIdOrdinal`'s parse behavior (shared by the entry
 * builder, the append confirmation, and the pin-continuity check), and the
 * entry builders' own refusals -- the `history` fault on both the create and
 * append paths, and a head `versionId` carrying no ordinal on the append
 * path. The `type` fault and the reader-side `history` fault are already
 * covered in `resourceLog-append.test.ts` and `resourceLog-verify.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  buildResourceLogEntry,
  buildResourceLogGenesis,
  versionIdOrdinal
} from '../../src/entry.js'
import { fakeController } from '../../src/testing.js'
import { makeLogClient } from './fixtures/log.js'

const METHOD = 'resource-log:0.1'

describe('versionIdOrdinal', () => {
  it.each([
    ['3-hash', 3],
    ['0-x', undefined],
    ['-1-x', undefined],
    ['abc', undefined],
    ['', undefined]
  ])('reads %j as %j', (versionId, expected) => {
    expect(versionIdOrdinal(versionId)).toBe(expected)
  })
})

describe('entry builders refuse a state carrying the history member', () => {
  it('buildResourceLogGenesis refuses it before signing', async () => {
    const alice = await makeLogClient()
    const controller = fakeController({
      versions: [{ versionId: '1-v1', keys: [alice.signingKeyMultibase] }]
    })
    await expect(
      buildResourceLogGenesis({
        state: { type: 'TestState', history: [] },
        method: METHOD,
        controller,
        signer: alice.logSigner
      })
    ).rejects.toThrow(
      'A resource log entry state must not carry a history member (the ' +
        'profile reserves that member name).'
    )
  })

  it('buildResourceLogEntry refuses it before signing', async () => {
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
    await expect(
      buildResourceLogEntry({
        head: genesis,
        state: { type: 'TestState', history: [] },
        controller,
        signer: alice.logSigner
      })
    ).rejects.toThrow(
      'A resource log entry state must not carry a history member (the ' +
        'profile reserves that member name).'
    )
  })
})

describe('buildResourceLogEntry refuses a head with no ordinal', () => {
  it('refuses a head whose versionId does not start with a 1-based ordinal', async () => {
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
    const headWithoutOrdinal = { ...genesis, versionId: 'abc' }
    await expect(
      buildResourceLogEntry({
        head: headWithoutOrdinal,
        state: { type: 'TestState', value: 2 },
        controller,
        signer: alice.logSigner
      })
    ).rejects.toThrow(
      `Cannot build a resource log entry: the head's versionId ` +
        `"abc" does not start with a 1-based ordinal.`
    )
  })
})
