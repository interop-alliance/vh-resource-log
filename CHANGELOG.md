# @interop/vh-resource-log Changelog

## 0.5.0 - TBD

### Added

- `isResourceLogRefusal(err)`, the read-side classification of the refusal
  taxonomy: `true` for `ResourceLogIntegrityError` and for
  `ResourceLogContinuityError` with any reason but `rollback`. It says which
  refusals a reader holding a cached copy must not fall back to it on; a
  rollback is reconcilable divergence under the profile's log-pin rules and is
  left to the caller's cached-copy path. Matched by `err.name`, like the
  conflict predicate. Moved here from `@interop/wallet-core`, which will
  re-export it.

## 0.4.2 - 2026-09-08

### Added

- `collectionLogPinId({ spaceId, collectionId })` builds the pin slot key
  `space/<spaceId>/<collectionId>/meta/log`, for a Collection's governing
  history log at its `meta/log` sub-resource.

### Changed

- The sealing-sweep test suite (`sealResourceLog`,
  `latestAssertionRemovalIndex`) moved into this repo's own test run, so a seal
  regression is caught here instead of only in a consumer's tests.

- The verify test suite now covers four previously untested refusal branches: a
  proof outside the profile's fixed shape, a non-object `parameters` member, a
  proof `verificationMethod` that is not a versioned DID URL, and a pinned head
  carrying no ordinal (refused as a fork with the served entries retained).

- New `entry.ts` unit tests pin `versionIdOrdinal`'s parsing table and the
  builder-side guards: both entry builders refuse a state carrying the reserved
  `history` member, and `buildResourceLogEntry` refuses a head whose `versionId`
  carries no ordinal.

## 0.4.1 - 2026-08-22

### Fixed

- `readResourceLog` now consults the chain-head pin on an absent log: with a pin
  held for `logId`, a `store.read()` of `null` is refused as
  `ResourceLogContinuityError` (reason `rollback`, pinned head attached) instead
  of reported as pre-genesis. `appendResourceLog` and `sealResourceLog` surface
  the same refusal, and `createResourceLog` checks the pin before building or
  writing anything, adopting the served log or refusing the absent one rather
  than landing a fresh genesis over a hidden log. With no pin held, an absent
  log still reads as `null`.

### Changed

- `resourceLogPinId` now throws a `TypeError` for an empty or slash-bearing
  `spaceId`, `collectionId`, or `resourceId`, instead of silently building an
  ambiguous slot key. Valid (URL-safe) ids produce the same pin id as before.
- `confirmAppend` compares the served and sent entries with the kernel's
  `canonicalizeStrict`; the direct `json-canonicalize` dependency is dropped.
- Internal cleanup: one shared verify-then-pin step in the append path, one
  `versionId` ordinal reader, and the sealing sweep resolves a controller's
  assertion key sets concurrently.
- The versioned verification-method DID URL is built and parsed by one codec,
  `buildVersionedVm` / `parseVersionedVm` (exported). The verifier now rejects a
  proof `verificationMethod` whose query is anything other than a single
  non-empty `versionId` parameter; previously extra parameters were ignored and
  the value was percent-decoded.

## 0.4.0 - 2026-08-22

### Changed

- **BREAKING**: Renamed "anchor" to "controller versionId" throughout the
  library. `VerifiedResourceLog.headAnchorIndex` is now
  `headControllerVersionIndex`; the `admitAppend` hook input's `anchor` and
  `anchorIndex` are now `controllerVersionId` and `controllerVersionIndex`.
  Integrity error messages that referred to an entry's "anchor" now refer to its
  controller versionId. Docs use "controller versionId" in place of "anchor".
- Docs and code now call the verifier's running controller version the "head
  controller version" (was "version floor"); the ARCHITECTURE.md glossary entry
  is renamed. No API change.
- **BREAKING**: an entry's proofs must all carry the same controller versionId
  and be by distinct signing keys. A log whose entry carries divergent
  controller versionIds or a repeated signing key is now refused from genesis as
  `ResourceLogIntegrityError`; the client's held pin stays where it was, and
  there is no in-library heal for that shape (only a hand-built log can carry
  it). `assertionMethod` membership is checked at the entry's controller
  versionId for every proof, once per entry, instead of at each proof's own. The
  `admitAppend` hook input's `controllerVersionId` and `controllerVersionIndex`
  are now the entry's controller version for every proof, and the input gains
  `proofKeys`: every proof's signing-key multibase, distinct, in array order. A
  consumer that constructs the hook input directly (rather than receiving it
  from the library) must add `proofKeys`, and a hook must return the same
  verdict regardless of `proofKeys` order, since the proof array is not
  integrity-bound. The verifier now makes one `assertionKeysAt` call per entry
  instead of one per proof.

### Fixed

- `appendResourceLog` now treats an empty `etag` from `store.read` as no
  validator and refuses to write, instead of sending a blank `If-Match`.
- The entry builders now refuse a `null` or `undefined` state with the intended
  misuse `Error` instead of a `TypeError`. The builders and the reader's entry
  shape check share one state-document rule.

## 0.3.0 - 2026-08-22

### Added

- `verifyResourceLogAppend`: an exported pre-write verification pass. It
  verifies a candidate entry as the reader would, as the next entry of a
  verified head, for consumers with their own write path.

### Changed

- **BREAKING**: `appendResourceLog` (and the sealing sweep through it) now
  verifies every built entry pre-write on every compare-and-swap attempt, and
  `createResourceLog` verifies the genesis as a one-entry log before
  `store.create` (falling through to lost-race adoption when a log already
  exists). Refusals that used to surface after the write, from read-back, now
  surface before it, and nothing is written. The `admitAppend` hook contract
  gains an obligation: it is also consulted pre-write on the writer's candidate,
  is called on entries that are never written, is called twice for a successful
  append, and must be side-effect-free. A consumer with its own write path must
  call the new export to be covered. No error name changes.
- `VerifiedResourceLog` is now also an input, to the new export, so adding a
  required field to it is henceforth a breaking change for any consumer that
  constructs one.

## 0.2.0 - 2026-08-22

### Changed

- **BREAKING**: the controller port's `admitAppend` hook now runs after the
  entry's proofs verify. It used to run inside the kernel's authorize callback,
  before the signature check. An entry with a forged `proofValue` is now refused
  as `ResourceLogIntegrityError` whatever the hook would have said, on the read
  path, the read-back after an append, and the sealing sweep, and the hook never
  receives input from an unverified proof. Consumers whose refusal predicates
  match only the Integrity and Continuity names now hard-refuse such a log where
  they warned and continued. No error name changes.

## 0.1.2 - 2026-08-22

### Changed

- Update to latest `@types/*` and `prettier`.

## 0.1.1 - 2026-08-22

### Changed

- Update to latest `json-canonicalize@3.0.0`.

## 0.1.0 - 2026-08-22

### Added

- Initial release: the Resource Log Profile's generic client side, extracted
  from `@interop/wallet-core` (`src/resourceLog/`: the verifier and handover
  check, entry builders, chain-head pin port, read/append/create path, and
  sealing sweep, with their adversarial test suites) and `@interop/was-client`
  (`src/log/`: the strict JSON Lines codec, the `ResourceLogStore` port, and the
  read-back `confirmAppend`). Wire types come from `@interop/storage-core`; the
  hashing and proof kernel from `@interop/did-method-webvh`.
- The controller port's optional per-proof `admitAppend` admission hook,
  replacing the verifier's inline ceremony-tail license call: the library
  carries no admission policy, and a consumer whose controller document can list
  ladder-shaped verification methods supplies the license through the hook. A
  hook throw propagates with its class intact; kernel and proof failures keep
  wrapping as `ResourceLogIntegrityError`.
- `ResourceLogConflictError` (and the `isResourceLogConflictError` name
  predicate): the store port's compare-and-swap conflict signal, minted by store
  adapters with the transport's error as `cause` and matched by `err.name`
  across package boundaries. `LogNotConfirmedError` moves in and extends `Error`
  directly.
- The `./testing` subpath: `fakeController` and `memoryLogStore`, the shared
  test fixtures (test-only; the fakes neuter authorization and durability).
- A Playwright browser smoke test verifying a fixture log in Chromium.

### Changed (relative to the code's previous homes)

- A resource-log body that does not parse as strict JSON Lines, and a read-back
  entry whose `versionId` carries no ordinal, now refuse with
  `ResourceLogIntegrityError` (previously was-client's `ValidationError`): a log
  that does not parse is a doctored or truncated log, the fabrication class.
