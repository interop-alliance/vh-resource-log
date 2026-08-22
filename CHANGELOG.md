# @interop/vh-resource-log Changelog

## 0.1.0 - TBD

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
