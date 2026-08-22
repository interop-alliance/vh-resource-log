# 0001: The profile's generic client side lives in this package

- Status: accepted
- Date: 2026-08-22
- Driving work: extracting the Resource Log Profile's client-side
  verifier out of the wallet layer so the storage client's
  log-governed descriptor read path can verify logs without a second
  implementation.
- Affects: vh-resource-log (all of it); was-client (`src/log/` reduced
  to the WAS store adapter, dependency added); wallet-core
  (`src/resourceLog/` reduced to the did:webvh controller adapter, the
  ceremony-tail license, and the named pin-id builders); freewallet
  and dcw (direct declarers of the library for the pin port and the
  refusal classes)

## Context

The Resource Log Profile (encrypted-collections-spec,
`#resource-log-profile`) had one client-side implementation, split
across two packages by accident of birth: the verifier, entry
builders, pin port, and append path in wallet-core; the JSON Lines
codec, store port, WAS adapter, and read-back confirmation in
was-client. The storage client needed a verifier for its log-governed
descriptor read path. The never-reimplement rule forbids a second
verifier. Moving the existing one into was-client would pull
wallet-domain semantics (the ceremony-tail license on ladder-signed
appends, the did:webvh controller adapter) into a transport library.
Nothing in the verifier itself is wallet-specific: its inputs are
parsed entries, a caller-supplied controller view, an expected format
identifier, and a pin.

## Decision

`@interop/vh-resource-log` owns the profile's generic client side:
the JSON Lines codec, the `ResourceLogStore` port and `confirmAppend`,
the verifier and handover check, the entry builders, the chain-head
pin port (`ResourceLogPinStore`, `resourceLogPinId`), the
read/append/create path, the sealing sweep, and the shared test
fixtures (a `./testing` subpath). was-client and wallet-core both
depend on it, with the same caret range.

The boundaries the placement fixes:

- Wire types (`ResourceLogEntry`, `RESOURCE_LOG_METHOD`) stay in
  `@interop/storage-core`; types flow down from it, not up into it.
- The hashing, `versionId`, SCID, and proof kernel stays in
  `@interop/did-method-webvh`; the library consumes it by named
  import.
- Wallet-domain semantics stay in wallet-core: the did:webvh
  controller adapter and the ceremony-tail license, reached through
  the controller port's optional per-proof `admitAppend` hook. A
  controller port over an account did:webvh document must supply the
  hook; the library itself carries no license logic.
- was-client's `log` subpath is the WAS binding of the library's
  store port and nothing more; neither subpath re-exports the
  library's names (one owner per name).

## Rejected Alternatives

- **Move the verifier into was-client.** Pulls the ladder license and
  inventory types into a transport library, or leaves them behind a
  hook anyway; and creates a structural dependency cycle the moment
  the wallet layer's append path needs was-client's `confirmAppend`
  while was-client needs the wallet layer's verifier. Do not reopen:
  the cycle is structural, not incidental.
- **Keep the verifier in wallet-core and give was-client a verifier
  port.** Works for the descriptor read path in isolation, but leaves
  the profile's reference verifier inside a wallet package, so any
  non-wallet consumer (a server-side append sanity check, an app-side
  reader, a CLI) would have to depend on wallet-core's whole graph or
  reimplement.
- **Extract a lower "hash log kernel" from did-method-webvh** so that
  did-method-webvh, this library, and was-client all depend on it.
  The kernel is small but its proof verification is not DID-neutral
  inside did-method-webvh, so the split is a refactor of a published
  DID method's hot path. Worse, the kernel's outputs are fixed by the
  did:webvh spec and must be bit-identical everywhere; as a
  separately versioned package, the resolver could produce two copies
  in one tree, and the failure is a silent hash mismatch. The gain
  (this library not listing did-method-webvh) is cosmetic: the
  resolver and witness code is tree-shakeable and the spec profiles
  the log format on did:webvh by reference.
- **Facade re-exports** (was-client's and wallet-core's old subpaths
  keep re-exporting the moved names so consumer imports do not
  change). Rejected under the greenfield stance: two paths to one
  name is standing drift.

## Consequences

- One verifier serves every consumer; the descriptor read path and
  any future non-wallet reader import it directly.
- The library's dependency graph includes `@interop/did-method-webvh`
  and `@noble/curves`; was-client's `log` subpath is no longer
  crypto-free, and its layering docs say so.
- The refusal classes cross package boundaries and are matched by
  their `name` string, which every moved class assigns explicitly and
  keeps verbatim; a release train must still resolve one copy each of
  this library, was-client, wallet-core, and did-method-webvh in a
  consuming lockfile (kernel skew is a silent behavioral split, not a
  dispatch miss).
- Hook obligation: a consumer verifying a log whose controller
  document can list ladder-shaped verification methods must supply
  `admitAppend`; a bare controller view admits appends the wallets
  refuse.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. No second consumer of the library (beyond wallet-core) appears
   within a release cycle of the descriptor read path landing; the
   verifier-port alternative then deserves a second look.
2. For the kernel boundary: a third consumer of the hashing
   primitives appears that is neither a DID log nor a resource log,
   or did-method-webvh generalizes its proof verification's VM
   resolution on its own. The library's named kernel imports make
   that swap a one-file change.

The was-client-hosts-the-verifier alternative is not reopened by
either criterion; its dependency cycle is structural.
