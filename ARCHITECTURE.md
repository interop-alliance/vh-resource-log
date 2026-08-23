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
                   against the chain-head pin, the handover check, and the
                   pre-write pass verifyResourceLogAppend
src/pin.ts         The chain-head pin port (ResourceLogHeadPin,
                   ResourceLogPinStore, resourceLogPinId, memory impl)
src/append.ts      readResourceLog / appendResourceLog / createResourceLog
                   (verify-build-verify-CAS-rebase-confirm)
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
   proof in a later array position), after `assertionMethod` membership passes,
   after every proof of the entry has verified cryptographically, and before the
   head controller version advances, for every entry past genesis. The hook is
   also consulted on the writer's own candidate entry before the write
   (`verifyResourceLogAppend`, run by `appendResourceLog` on every
   compare-and-swap attempt), after the candidate's proofs verify. It is
   therefore called on entries that then lose the race or are refused and never
   written, and twice for a successful append (pre-write and on read-back) with
   identical input. It must be a side-effect-free function of the controller
   view and the input; a call is not evidence that an entry was or will be
   written. The hook runs after the kernel call, outside the integrity wrap, so
   a throw needs no capture and a forged signature is refused as the integrity
   class whatever the hook would have said. The hook never sees input from an
   unverified proof: every key in the input's `proofKeys` belongs to a proof of
   the same entry that verified through the kernel and passed membership,
   because the drain that pushes hook input runs only after `verifyEntryProofs`
   returns, and the kernel throws on the first failure. A refactor that moved
   the drain inside the kernel's wrap would break this. The input's
   `controllerVersionId` and `controllerVersionIndex` are the entry's controller
   version, the same for every proof of the entry (invariant 12); `proofKeys`
   lists every proof's signing key, distinct, so a hook can apply a per-entry
   policy the library does not carry. The proof array is host-mutable in order
   and multiplicity, in both directions. A host can reorder, duplicate, or
   delete proofs without touching a signature or the hash, since each proof
   signs the entry minus the array and the hash input omits `proof`. Any strict
   non-empty subset of an entry's proofs still verifies, so `proofKeys` is a
   lower bound on the entry's proofs, not the full set. A hook must treat
   `proofKeys` as a set and return the same verdict for any ordering of it. A
   policy that refuses on a count above one therefore binds an honest host and
   the writer's own pre-write pass; read-back confirmation catches a deleted
   proof for the writer's own entry, but a malicious host can still present a
   smaller proof set to a third-party reader, silently. The identical-input
   promise between the pre-write pass and read-back holds up to `proofKeys`
   order. The obligation the seam creates: a controller port over a document
   that can list ladder-shaped verification methods (any wallet account
   did:webvh document) MUST supply the hook, carrying wallet-core's
   ceremony-tail license -- a bare view does not lack ladder keys, it lacks the
   ability to recognize them, and a hook-less read would admit the silent-rekey
   shape the license exists to refuse.
7. **An acknowledged append is a promise, not a fact.** Every append and create
   is confirmed by reading the log back (`confirmAppend`) and re-verifying the
   extended history before the append -- or any ceremony step gated on it -- is
   treated as durable. The pre-write pass of invariant 11 is additive to this;
   read-back confirmation stays the only evidence that an append is durable.
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
    effective controller version, so the backstop append is idempotent and a
    torn sweep is finished by a naive re-run by any surviving member. The sweep
    exists because an ordinary post-edit write is the sealing append by
    construction; the gap is the run where no such write happens (a rotation
    that no-ops because the retiree held no current-epoch wrap), leaving the
    log's head still at a controller version from before the removal. A sweep
    that would write is refused pre-write when the sweeping client is the
    removed member (invariant 11); the convergence branch, which writes nothing,
    still runs before the pass. The wallet-side ceremonies that drive it stay in
    `@interop/wallet-core`.
11. **The write path refuses before the host does.** Before `store.append` or
    `store.create`, the candidate entry is verified as the reader would verify
    it at its ordinal (shape, hash chain to the head, proofs, the authorization
    rule at the head controller version, the `admitAppend` hook, the
    terminal-entry rules), against a controller view at or past the one the head
    was verified with, so an honest writer does not send an entry it would
    itself refuse on read-back -- one refused entry rejects the whole log for
    every reader (invariant 2) and an appended entry cannot be removed. A
    refusal throws the class the read-back would have thrown, from the same
    code, and nothing is written. On the create path a refused genesis against
    an existing log falls through to lost-race adoption (the winner's log is
    verified and pinned), and only the Integrity class falls through. This is
    self-protection, not an authorization boundary: a removed member whose
    controller view is stale still passes (invariant 5, the spec's revocation
    window), and a writer that bypasses the library's write path is not
    constrained. It does not replace read-back (invariant 7).
12. **An entry carries one controller versionId, by distinct signing keys.**
    Every proof of an entry carries the same controller versionId (or none,
    under an unversioned controller), and no signing key appears twice; proofs
    that disagree, or a repeated key, refuse the log as Integrity. Presence or
    absence of a controller versionId is checked on every proof; whether the
    proofs agree, whether that versionId is known, and its monotonicity against
    the head controller version are each checked once per entry. Every signing
    key's `assertionMethod` membership is checked at the entry's controller
    versionId, and it becomes the head controller version for the next entry.
    The rule exists because the proof array sits outside the hash and every
    signature (`proof` is omitted from the hash input, and each proof signs the
    entry minus the array), so a host can duplicate, reorder, or delete proofs
    undetected; the reduction from proofs to one entry-level controller
    versionId is computed before the kernel checks any signature, since the
    kernel verifies proofs in array order with no lookahead. Decision
    [0002](decisions/0002-one-controller-version-per-entry.md).

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
- The pre-write verification of a candidate entry, closed-head refusal included,
  is `verifyResourceLogAppend` in this library; a consumer with its own write
  path (wallet-core's `rosterLogStore.replace`) calls it rather than re-deriving
  any reader rule.

## Glossary

The repo's domain vocabulary: one canonical term per concept, used the same way
in code, tests, docs, commit messages, and conversation. A repo is one bounded
context; when a term carries a different meaning in a neighbouring repo, the
entry says so and points at that repo's glossary. Entries say what a term is and
where it lives. How it works belongs to the invariant or module that describes
the mechanism. The convention is canonical in isomorphic-lib-template's
ARCHITECTURE.md Glossary section.

### The log and its entries

- **Resource log** -- one resource's complete history under the Resource Log
  Profile: a hash-chained, signed, append-only JSON Lines file whose verified
  head's `state` is the resource's current state. The profile's client side is
  this library (decision 0001). Avoid: history, audit log, did log.
- **Entry** -- one line of a resource log, carrying exactly `versionId`,
  `versionTime`, `parameters`, `state`, and `proof` (`verify.ts`). Avoid:
  record, event, version.
- **Genesis entry** -- the first entry, whose `parameters` carry the format
  identifier and the SCID (plus `previousLog` on a handover successor). Built by
  the two-pass SCID construction in `entry.ts`. Avoid: root entry, initial
  entry.
- **Ordinal** -- an entry's 1-based position in the log, the integer prefix of
  its `versionId`. Refusal messages name the candidate's would-be ordinal.
  Avoid: index, sequence number, line number.
- **SCID** -- the log's self-certifying identifier, computed by the did:webvh
  kernel over the genesis entry and recorded in the chain-head pin. The
  construction is `@interop/did-method-webvh`'s and is not re-derived here.
- **Format identifier** -- the `parameters.method` string of the genesis entry
  (`resource-log:0.1`, `RESOURCE_LOG_METHOD` in `@interop/storage-core`). A
  reader passes the one it expects as `expectedMethod`. Avoid: profile version,
  method string.
- **Verified head** -- the last entry of a log after full verification, the only
  head an entry is ever built on or a pin advanced to (invariant 1). A "stated
  head" is anything the host serves as a summary; the verifier never accepts one
  (invariant 2). Avoid: tip, latest entry, current entry.
- **Candidate entry** -- the entry a writer has built against the verified head
  but not yet sent; the pre-write pass runs over it. Avoid: draft, pending
  entry.
- **State** -- an entry's `state` member: a non-null object with a string `type`
  schema identifier and no `history` member (`resourceLogStateFault`, shared by
  the builders and the reader). Avoid: payload, body, document.
- **Terminal entry** -- the entry that closes a log: the only non-genesis entry
  with `parameters`, exactly `{ nextLog: { method, scid } }`, and a `state`
  equal to its predecessor's. A log whose verified head is terminal is "closed"
  and appends refuse with `ResourceLogClosedError`. Avoid: tombstone, migration
  entry, final entry.
- **Handover** -- the move of a resource's history to a successor log: the
  closed log's terminal entry names the successor, and the successor's genesis
  names the closed log in `previousLog`. The one transition across which a pin's
  SCID or method may change (`verifyResourceLogHandover`). Avoid: migration,
  rotation.

### Authority

- **Controller view** -- the `ResourceLogController` port: what verification
  consumes of the independently verified controller document (the DID, the
  ordered `versionIds`, `assertionKeysAt`, and the optional admission hook). The
  caller builds it from a document it has already verified; the port carries no
  resolution (invariant 5). The did:webvh adapter over a wallet account document
  lives in `@interop/wallet-core`. Avoid: resolver, controller document (the
  thing the view is taken from), DID document.
- **Unversioned controller** -- a controller view with an empty `versionIds` (a
  static controller). Entries under it carry no controller versionId and every
  controller-version rule degrades to current-document verification.
- **Controller versionId** -- the controller-log version a proof names through
  the `versionId` DID parameter on its `verificationMethod`: the controller head
  as the writer last verified it, and the version at which `assertionMethod`
  membership is checked on read. Expressed inside the verifier as an index into
  the controller view's `versionIds`. Defined per proof, but an entry carries
  only one: every proof of an entry must carry the same controller versionId, by
  distinct signing keys (invariant 12); it is the entry's, not each proof's own.
  Avoid: checkpoint, pinned version, anchor.
- **Head controller version** -- the controller version the verified entries so
  far stand at, carried by the verifier as it walks the log (`headVersionIndex`
  in the code). An entry's controller versionId must be at or past it
  (controller-version monotonicity), checked once per entry against the entry's
  single controller versionId rather than per proof (invariant 12), and it
  becomes the entry's own once the entry passes. The hook sees it as
  `headControllerVersionIndex`. Avoid: version floor, floor, watermark,
  high-water mark, anchor floor.
- **Effective controller version** -- the head controller version after the
  whole loop, which monotonicity makes the verified head's own controller
  version (`VerifiedResourceLog.headControllerVersionIndex`). The sealing sweep
  compares it against the controller's latest membership change. Avoid:
  effective anchor.
- **Authorization rule** -- the profile's whole append-authority test: the
  proof's key is a member of `assertionMethod` at the controller version it
  carries. It is checked against that version on purpose, so a signature made
  while the key was listed verifies forever. The server-side counterpart, which
  checks the document as resolved now, is the current-key-set rule in
  freewallet's and wallet-core's glossaries; the two are deliberately
  asymmetric. Avoid: current-key-set rule (for this rule), membership check.
- **Admission hook** -- the controller view's optional `admitAppend`: the
  per-proof seam through which controller-domain append policy reaches the
  verifier (invariant 6). This library carries no policy of its own; the policy
  wallet-core supplies through it is the ceremony-tail license, which reasons
  about ladder keys and inventory (terms of wallet-core's glossary, not this
  one). Avoid: policy callback, authorizer, license (the license is one hook's
  content).
- **Writer** -- the client appending an entry, signing under its enrolled
  Ed25519 key through the `ResourceLogSigner` seam. Identified on the wire only
  by the key's multibase fragment. Not wallet-core's `writerId`, which is an
  unkeyed attribution label for revision history and names nothing here. Avoid:
  author, device, client (wallet-core's term for the keyed identity).
- **Kernel** -- the did:webvh log kernel in `@interop/did-method-webvh`: entry
  hashing, `versionId` and SCID construction, proof creation and verification,
  consumed as named imports and never re-derived.

### Continuity

- **Chain-head pin** -- a client's durable per-log record of the log's verified
  identity and latest verified head: `{ method, scid, head }`
  (`ResourceLogHeadPin`). Established at first contact, advanced only past a
  full verification, replaced only across a verified handover (invariant 3).
  Avoid: checkpoint, head cache, trust anchor.
- **Pin slot** -- the keyed place a `ResourceLogPinStore` holds one log's pin,
  named by the `logId` the library derives with `resourceLogPinId` (invariant
  4). Wallet-core's named builders (`accountLogPinId`, and siblings) wrap it.
  Avoid: pin key, storage key.
- **Continuity** -- the relation a served log must hold to the pin: same method
  and SCID, and a history that descends from the pinned head. Its failures are
  the `ResourceLogContinuityError` kinds (rollback, fork, scid-switch,
  method-switch). Avoid: consistency, freshness.
- **Fork evidence** -- the served entries a fork refusal keeps on the error: two
  signed histories sharing a prefix and diverging, transferable as proof of the
  host's equivocation. Avoid: conflict log.

### The write path

- **Validator** -- the opaque `etag` a store read returns and the next append is
  conditioned on (`ifMatch`). An absent or empty validator forbids the append
  (invariant 8). Avoid: version tag, revision.
- **Compare-and-swap append** -- the conditional write `ResourceLogStore.append`
  performs against the validator; a stale validator is a lost race, surfaced as
  `ResourceLogConflictError`. Avoid: optimistic lock, conditional PUT (the WAS
  adapter's transport term).
- **Rebase** -- the caller's response to a lost race: re-read, re-verify,
  rebuild the candidate on the new verified head, retry (`appendResourceLog`).
  Avoid: merge, replay.
- **Lost race** -- a concurrent writer got there first: a stale validator on
  append, or an existing log on create. Benign; on create the winner's log is
  adopted. Avoid: collision, failure.
- **Pre-write pass** -- `verifyResourceLogAppend`, the reader's per-entry checks
  run over the candidate before `store.append` or `store.create`, so a writer
  refuses what it would refuse on read-back (invariant 11). Avoid: preflight,
  dry run, self-check.
- **Read-back confirmation** -- `confirmAppend`: after an acknowledged append,
  read the log back and check the entry is in the served history at its ordinal;
  the only evidence an append is durable (invariant 7). Its failure is
  `LogNotConfirmedError`. Avoid: ack, receipt.

### Sealing

- **Membership change** -- a controller version whose `assertionMethod` set lost
  a member against its predecessor; the latest one is
  `latestAssertionRemovalIndex`. Only assertion removals count, so a
  `keyAgreement`-only method leaving the document never registers. Avoid:
  revocation event, roster change.
- **Sealing append** -- an entry carrying a controller version at or past the
  latest membership change, proving the surviving writers extended the log under
  the new membership. Any ordinary post-edit write is one by construction.
  Avoid: fence, checkpoint.
- **Sealing sweep** -- `sealResourceLog`, the idempotent backstop that writes a
  sealing append (a verbatim re-append of the head state) only when the
  effective controller version is still pre-removal (invariant 10). A log is
  "sealed" when its effective controller version is at or past the latest
  membership change. Avoid: reseal, cleanup.

### Refusals

- **Refusal class** -- one of the library's error names, each a contract
  (invariant 9): Integrity (the served log is doctored, truncated, or
  unauthorized), Continuity (the log disagrees with the pin), Closed (the head
  is terminal), NotConfirmed (read-back did not show the entry), and Conflict (a
  lost race). The ratified list is in `src/errors.ts`'s header. Avoid: error
  type, failure mode.
- **Port** -- one of the library's three seams a consumer implements or
  supplies: `ResourceLogStore`, `ResourceLogPinStore`, and
  `ResourceLogController`. An implementation of a port is an adapter
  (was-client's `resourceLogStore`, wallet-core's `webvhResourceLogController`).
  Avoid: seam, interface, backend.

## Current State labels

Current. Nothing here is aspirational: the modules above moved in from
`@interop/wallet-core` and `@interop/was-client` with their tests, and no
consumer-facing behavior beyond the ratified error-class swaps (CHANGELOG 0.1.0)
changed in the move.
