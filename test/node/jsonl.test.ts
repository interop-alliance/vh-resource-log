/**
 * Unit tests for the strict JSON Lines codec (`src/jsonl.ts`) and the
 * read-back confirmation (`src/store.ts`). The parse-failure class is part of
 * the library's contract (design sign-off item 2): a body that does not parse
 * as the profile's format refuses as the fabrication class,
 * `ResourceLogIntegrityError`, as does a read-back entry whose `versionId`
 * carries no ordinal.
 */
import { describe, expect, it } from 'vitest'
import type { ResourceLogEntry } from '@interop/storage-core'
import {
  confirmAppend,
  LogNotConfirmedError,
  parseResourceLog,
  ResourceLogIntegrityError,
  serializeResourceLog,
  serializeResourceLogEntry
} from '../../src/index.js'
import { memoryLogStore } from '../../src/testing.js'

/**
 * Builds a minimal syntactically valid entry at ordinal `n`. The wire types
 * only constrain shapes -- hashes and proofs here are placeholders, since the
 * codec and the read-back containment check never verify them.
 *
 * @param n {number}
 * @returns {ResourceLogEntry}
 */
function entryAt(n: number): ResourceLogEntry {
  return {
    versionId: `${n}-QmEntryHash${n}`,
    versionTime: '2026-08-10T12:00:00Z',
    parameters: n === 1 ? { method: 'resource-log:0.1', scid: 'QmScid' } : {},
    state: { type: 'TestState', value: n },
    proof: [
      {
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        proofPurpose: 'assertionMethod',
        verificationMethod: 'did:webvh:QmScid:h:space:s:id?versionId=1-x#key',
        proofValue: `z${n}`
      }
    ]
  }
}

describe('parseResourceLog / serializeResourceLog', () => {
  it('round-trips a serialized log, with the terminating newline', () => {
    const entries = [entryAt(1), entryAt(2)]
    const text = serializeResourceLog(entries)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toBe(
      serializeResourceLogEntry(entries[0]!) +
        '\n' +
        serializeResourceLogEntry(entries[1]!) +
        '\n'
    )
    expect(parseResourceLog(text)).toEqual(entries)
  })

  it('parses a body without a trailing newline', () => {
    const text = serializeResourceLogEntry(entryAt(1))
    expect(parseResourceLog(text)).toEqual([entryAt(1)])
  })

  it('fails the whole parse on a non-object line, as the integrity class', () => {
    const good = serializeResourceLogEntry(entryAt(1))
    for (const bad of ['[1,2]', '"text"', 'null', '42', 'not json', '']) {
      expect(() => parseResourceLog(`${good}\n${bad}\n`)).toThrow(
        ResourceLogIntegrityError
      )
    }
  })

  it('rejects an empty body as the integrity class (a log has at least its genesis entry)', () => {
    expect(() => parseResourceLog('')).toThrow(ResourceLogIntegrityError)
    expect(() => parseResourceLog('\n')).toThrow(ResourceLogIntegrityError)
  })

  it('refuses to serialize an empty log', () => {
    expect(() => serializeResourceLog([])).toThrow(/at least its genesis/)
  })
})

describe('confirmAppend', () => {
  it('returns the read-back log containing the entry at its ordinal', async () => {
    const store = memoryLogStore()
    store._setEntries([entryAt(1), entryAt(2)])
    const confirmed = await confirmAppend({ store, entry: entryAt(2) })
    expect(confirmed.entries).toHaveLength(2)
  })

  it('throws LogNotConfirmedError when the served log is too short', async () => {
    const store = memoryLogStore()
    store._setEntries([entryAt(1)])
    await expect(
      confirmAppend({ store, entry: entryAt(2) })
    ).rejects.toBeInstanceOf(LogNotConfirmedError)
  })

  it('throws LogNotConfirmedError on a different entry at the ordinal', async () => {
    const store = memoryLogStore()
    store._setEntries([
      entryAt(1),
      { ...entryAt(2), versionTime: '2026-08-11T00:00:00Z' }
    ])
    await expect(
      confirmAppend({ store, entry: entryAt(2) })
    ).rejects.toBeInstanceOf(LogNotConfirmedError)
  })

  it('throws LogNotConfirmedError when the log vanished', async () => {
    const store = memoryLogStore()
    await expect(
      confirmAppend({ store, entry: entryAt(1) })
    ).rejects.toBeInstanceOf(LogNotConfirmedError)
  })

  it('refuses an entry whose versionId has no ordinal, as the integrity class', async () => {
    const store = memoryLogStore()
    store._setEntries([entryAt(1)])
    const bad = { ...entryAt(1), versionId: 'Qm-no-ordinal' }
    await expect(confirmAppend({ store, entry: bad })).rejects.toBeInstanceOf(
      ResourceLogIntegrityError
    )
  })
})
