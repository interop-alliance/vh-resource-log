# @interop/vh-resource-log Changelog

## 0.4.0 - TBD

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
