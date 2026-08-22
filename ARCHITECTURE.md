# Architecture

The current shape of this library, with the rationale inline: why each part is
shaped the way it is, stated where the shape is described. This file is kept
current in the same change set that alters the shape; it overwrites in place and
records no history. History lives elsewhere: CHANGELOG.md for what landed,
`decisions/` for durable decisions with their rejected alternatives and revisit
criteria, and the archived roadmap for the work items. Reference decision
records from here where the resulting shape is described, instead of re-arguing
them.

## Layer map

`@interop/vh-resource-log` is the Resource Log Profile's generic client side.
The placement -- what lives here, what stays in storage-core, did-method-webvh,
was-client, and wallet-core -- is decision
[0001](decisions/0001-profile-client-side-placement.md).

```
src/index.ts       Public entry point (the export map's "." door)
src/jsonl.ts       Strict JSON Lines parse/serialize (the wire framing)
src/store.ts       The ResourceLogStore port (read/append/create) and the
                   read-back confirmAppend
src/errors.ts      The refusal taxonomy and the ratified name contracts
src/controller.ts  The controller-view port verification authorizes against,
                   including the optional admitAppend admission hook
src/vmFragment.ts  The one fragment reader for verification-method ids
src/entry.ts       Genesis (two-pass SCID) and next-entry builders + signing
src/verify.ts      Full chain verification, terminal entries, continuity
                   against the chain-head pin, the handover check
src/pin.ts         The chain-head pin port (ResourceLogHeadPin,
                   ResourceLogPinStore, resourceLogPinId, memory impl)
src/append.ts      readResourceLog / appendResourceLog / createResourceLog
                   (verify-build-CAS-rebase-confirm)
src/seal.ts        The sealing sweep (latestAssertionRemovalIndex,
                   sealResourceLog)
src/testing.ts     The "./testing" subpath: fakeController, memoryLogStore
                   (test fixtures only, never production)
```

Dependency direction is strictly downward: this library depends on
`@interop/storage-core` (the wire types, `RESOURCE_LOG_METHOD`) and
`@interop/did-method-webvh` (the hashing, `versionId`, SCID, and proof kernel,
consumed as ten named imports) plus `json-canonicalize`, and on nothing else.
was-client and wallet-core depend on this library; nothing here depends on them.

## Invariants

1. **Log state is adopted only from a verified head.** `readResourceLog` is the
   one read entry point; chain, proofs, external authorization, and the
   chain-head pin are all checked before any state is handed out, so the pin
   rules cannot be bypassed by reading around them.
2. **The verifier recomputes everything.** No served head, digest, or count is
   ever accepted in place of recomputation (`verify.ts`); any failure rejects
   the whole log, not just the failing entry.
3. **The chain-head pin is established at first contact, advances only past a
   full verification, and is replaced wholesale only across a verified
   handover.** The pin never regresses; a rollback, fork, SCID switch, or method
   switch against it refuses with `ResourceLogContinuityError`, and fork
   refusals retain the served entries as transferable evidence of equivocation.
4. **Pin slot keys are derived by the library** (`resourceLogPinId`), not chosen
   by a store implementation, and are host-free
   (`space/<spaceId>/<collection>/<resource>`): a log served from a claimed new
   host lands in the SAME slot and is checked against the pin already held,
   rather than opening a fresh trust-on-first-use slate.
5. **The controller view is resolved independently of the host serving the
   log.** The `ResourceLogController` port carries no resolution -- it is a view
   the caller builds from an already verified document -- which is what enforces
   the profile's rule that controller-document material never comes from the
   channel the log came from.
6. **The admission hook is where controller-domain append policy lives.** The
   library carries none of it: `admitAppend`, when supplied, is called per PROOF
   (multi-proof entries are legal, so a per-entry call would admit an unadmitted
   proof in a later array position), after `assertionMethod` membership passes
   and before the anchor floor advances, for every entry past genesis; a hook
   throw propagates with its class intact (the capture slot in `verify.ts` --
   the library cannot name the consumer's error classes, and a blanket
   pass-through would stop wrapping kernel failures as the integrity class). The
   obligation the seam creates: a controller port over a document that can list
   ladder-shaped verification methods (any wallet account did:webvh document)
   MUST supply the hook, carrying wallet-core's ceremony-tail license -- a bare
   view does not lack ladder keys, it lacks the ability to recognize them, and a
   hook-less read would admit the silent-rekey shape the license exists to
   refuse.
7. **An acknowledged append is a promise, not a fact.** Every append and create
   is confirmed by reading the log back (`confirmAppend`) and re-verifying the
   extended history before the append -- or any ceremony step gated on it -- is
   treated as durable.
8. **A stale compare-and-swap validator fails into the caller's rebase-and-retry
   loop**, never downgraded to an unconditional write. The conflict signal is
   the library-owned `ResourceLogConflictError`, minted by store adapters with
   the transport's error as `cause`, and matched by `err.name`
   (`isResourceLogConflictError`) everywhere it crosses a package boundary --
   `instanceof` breaks the moment two library copies resolve in one tree, and a
   missed match would turn a benign lost race into a hard ceremony failure.
9. **Error names are contracts.** Every error class assigns its `name`
   explicitly and keeps the string verbatim across releases; cross-package
   catchers dispatch on `err.name`, and a drifted name fails open in them. The
   full ratified list (design sign-off 2026-08-22) is restated in
   `src/errors.ts`'s header.
10. **Sealing is computed from durable state alone.** The membership change is
    read off the controller view and the log's side off the verified head's
    effective anchor, so the backstop append is idempotent and a torn sweep is
    finished by a naive re-run. The sweep exists because an ordinary post-edit
    write is the sealing append by construction; the gap is the run where no
    such write happens (a rotation that no-ops because the retiree held no
    current-epoch wrap), leaving the log's head still anchored pre-removal. The
    wallet-side ceremonies that drive it stay in `@interop/wallet-core`.

## Ownership heuristics

- Wire types and the `resource-log:0.1` format identifier:
  `@interop/storage-core`. Types flow down from it, never up into it.
- Entry hashing, `versionId`/SCID construction, proof verification:
  `@interop/did-method-webvh`. Do not re-derive any of it here; the kernel's
  outputs are fixed by the did:webvh spec and must be bit-identical everywhere
  (decision 0001, rejected alternative 3).
- The WAS binding of `ResourceLogStore` (`resourceLogStore` over a Resource,
  `LOG_CONTENT_TYPE`): `@interop/was-client/log`. Adapters translate their
  transport's precondition failures into `ResourceLogConflictError` at the port
  boundary.
- The did:webvh controller adapter (`webvhResourceLogController`), the
  ceremony-tail license and its error class, and the named pin-id builders
  (`accountLogPinId`, `userKeyRosterPinId`, `clientAnnexLogPinId`):
  `@interop/wallet-core`. Wallet-domain admission policy reaches the verifier
  only through `admitAppend`.
- Durable pin storage: the consuming apps (freewallet's session database, dcw's
  table row). Only the port and the in-memory implementation live here.

## Current State labels

Current. Nothing here is aspirational: the modules above moved in from
`@interop/wallet-core` and `@interop/was-client` with their tests, and no
consumer-facing behavior beyond the ratified error-class swaps (CHANGELOG 0.1.0)
changed in the move.
