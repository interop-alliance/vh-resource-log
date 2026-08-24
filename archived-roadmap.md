# vh-resource-log Roadmap -- archived (completed) items

Completed items from [ROADMAP.md](ROADMAP.md), moved here verbatim when they
ship so that item-number references (VRL-N) in the active roadmap, commit
messages, and design docs keep resolving. Append-only: newest at the bottom; do
not rewrite or summarize items on the way in. Ids remain permanent and are never
reused. CHANGELOG.md stays the record of _what_ landed; this file preserves each
item's acceptance criteria and context.

---

### VRL-1: Run `admitAppend` after the signature check, not before

- status: done (2026-08-22)
- priority: high
- labels: verify, admission, error-classification
- verdict: confirmed
- touches:
  - shipped 2026-08-22: vh-resource-log `src/verify.ts` (admission inputs queued
    in `authorize`, drained after `verifyEntryProofs`), `src/controller.ts`
    (hook JSDoc), `test/node/resourceLog-admitAppend.test.ts` (five cases),
    `test/node/fixtures/log.ts` (`coSignEntry`), ARCHITECTURE.md (invariant 6
    ordering and mechanism text), CHANGELOG.md (0.2.0, breaking)
  - wallet-core: predicates confirmed against the new order (no code change;
    `isLogRefusal` / `isRosterRefusal` now receive Integrity for a forged entry,
    the branch they were written for; suites pass against the new build);
    ARCHITECTURE.md license sentence updated 2026-08-22; the residual soft
    classification of license refusals is WC-149; dependency range bumped to
    `^0.2.0` (shipped 2026-08-22).
  - was-client, freewallet: `unaffected` in behavior (no verifier call or class
    dispatch that changes; design section 3); dependency range bumped to
    `^0.2.0` (shipped 2026-08-22).
  - shipped 2026-08-22: did-method-webvh `src/assertions.ts`
    (`verifyEntryProofs` JSDoc states the every-proof-verified guarantee)
  - shipped 2026-08-22: byoe-ecosystem LEARNINGS.md (policy checks inside
    pre-verification callbacks)
- design: designs/VRL-1-admission-after-signature.md
- design-approved: 2026-08-22
- acceptance:
  - [x] A served entry with a garbage `proofValue` whose verification method is
        under `assertionMethod` at the anchor is refused as
        `ResourceLogIntegrityError`, even when the controller's `admitAppend`
        would also refuse it
  - [x] `admitAppend` still runs per proof, after membership, after every proof
        of the entry has verified, and before `anchorFloor` advances for the
        entry
  - [x] Regression test in `test/node/resourceLog-admitAppend.test.ts`

`src/verify.ts:498`. The kernel calls `authorize` before `verifier.verify`, and
`admitAppend` runs inside `authorize`. A forged entry therefore surfaces as the
consumer's admission-refusal class (wallet-core's `ResourceLogLicenseError`)
instead of `ResourceLogIntegrityError`. wallet-core's `isLogRefusal` and
`isRosterRefusal` match only the Integrity / Continuity names, so the fabricated
log lands in the warn-and-proceed and serve-stale-cache branches. Fix shape:
have `authorize` record the admission arguments per proof and drain that queue
after `verifyEntryProofs` resolves, so a signature failure wins over an
admission refusal.

---

### VRL-2: Pre-write admission pass in `appendResourceLog`

- status: done (2026-08-22)
- priority: high
- labels: append, admission, poisoning
- verdict: confirmed
- touches:
  - vh-resource-log `src/verify.ts` (the extracted per-entry check and the
    export), `src/append.ts`, `src/controller.ts` and `src/errors.ts` (JSDoc),
    `src/index.ts`, ARCHITECTURE.md (invariants 6/7/10 prose, new invariant 11,
    ownership heuristic), CHANGELOG.md (0.3.0)
  - shipped 2026-08-22 (wallet-core 0.52.0, unpublished): wallet-core
    `src/keys/rosterLogStore.ts` (`replace` and `create` adopt the export; the
    inline ladder-license block goes; ceremony-reviewer pass over the
    `lastVerified` / controller-floor lifecycle run), ARCHITECTURE.md (the two
    license passages; WC-149 interaction noted there), dependency range
    `^0.3.0`, CHANGELOG.md, one case each in `resourceLog-license.test.ts` and
    `descriptors.test.ts`
  - was-client (affected through the descriptor-store port only: a refused
    roster write now surfaces before anything is written; range bump)
  - encrypted-collections-spec (`#log-append` gains a writer SHOULD to verify
    the built entry before writing it, decided 2026-08-22; maintainer edits the
    spec)
  - freewallet (direct `^0.2.0` pin plus `link:` wallet-core; range bump in
    publish order), dcw (pins wallet-core `^0.45.0`; observes nothing until it
    bumps)
- design: designs/VRL-2-pre-write-admission.md
- design-approved: 2026-08-22
- acceptance:
  - [x] Before `store.append`, the freshly built entry is verified as the reader
        would verify it at its ordinal (shape, chain, proofs, authorization at
        the head's floor, `admitAppend` if supplied), through the same code the
        read loop runs
  - [x] A refused pre-check throws the same class the read-back verify would
        have thrown, and nothing is written
  - [x] The sealing sweep (`sealResourceLog`) is covered by the same pre-check
  - [x] `createResourceLog` verifies the genesis as a one-entry log before
        `store.create`, and a refusal against an existing log still adopts the
        winner (design doc section 4, lost-race rows)
  - [x] Read-back confirmation is unchanged (the pre-check is best effort; the
        anchor floor can still go stale before the write lands)
  - [x] wallet-core's `rosterLogStore.replace` and `create` call the export
        (each write site in design doc section 3 handled or exempted)

`src/append.ts:166`, `src/entry.ts:55`. `anchoredVerificationMethod` stamps
`versionIds[last]` unconditionally and the entry is written straight after
`buildResourceLogEntry`. A client whose key was removed at the latest controller
version (or the sealing sweep driven by it) writes durably, `confirmAppend`'s
re-verify then fails, and every future reader fails from genesis because the
entry cannot be removed. wallet-core's `rosterLogStore.replace` duplicates only
the ladder-license half pre-write and its comment names exactly this hazard.

---

### VRL-3: Reject an empty ETag as "no validator"

- status: done (2026-08-22)
- priority: high
- labels: append, cas
- verdict: confirmed
- touches:
  - shipped 2026-08-22: vh-resource-log `src/append.ts` (the guard now tests
    `!etag`), `src/store.ts` (the `read` port JSDoc states that an empty string
    counts as absent), `test/node/resourceLog-append.test.ts` (blank-validator
    case), CHANGELOG.md (0.3.1)
  - `createResourceLog` needed no change: it never conditions a write on the
    etag (the guarded `store.create` uses `If-None-Match`, and the lost-race
    branch only reads)
- acceptance:
  - [x] `appendResourceLog` and `createResourceLog` treat `''` (and any other
        empty validator) the same as `undefined`: refuse to write rather than
        send a blank `If-Match`
  - [x] Unit test with a store whose `read` returns `etag: ''`

`src/append.ts:146`. The no-unconditional-write guard tests only
`etag === undefined`. was-client's `readEtag` maps a present-but-blank `ETag`
header to `''`, which the guard passes, so `writeHeaders` emits a literal empty
`If-Match` that a server may ignore (invariant 8 forbids an unconditional
write). On the encrypted-collection codec path the same value 412s on all three
CAS attempts instead.

### VRL-12: Guard `checkState` against `null` and `undefined`

- status: done (2026-08-22)
- priority: low
- labels: entry, robustness
- verdict: confirmed
- touches:
  - shipped 2026-08-22: vh-resource-log `src/entry.ts` (`resourceLogStateFault`,
    the shared rule), `src/verify.ts` (`checkEntryShape` calls it),
    `test/node/resourceLog-append.test.ts`, CHANGELOG.md
- acceptance:
  - [x] `checkState(null)` and `checkState(undefined)` throw the intended misuse
        `Error`, not a `TypeError`
  - [x] `checkState` and `checkEntryShape`'s state rule share one predicate

`src/entry.ts:68`, `src/verify.ts:219`. `typeof (state as ...).type` runs with
no null guard; `append.ts:153` gates only on `state === null`, so a JS
`buildState` returning `undefined` reaches it. `checkEntryShape` already has the
guarded form of the same rule.

### VRL-4: Check every proof against the entry's own controller version

- status: done (2026-08-22)
- priority: high
- labels: verify, controller-version, seal
- verdict: confirmed
- touches:
  - shipped 2026-08-22: vh-resource-log `src/verify.ts` (entry-level pre-pass),
    `src/controller.ts` (`proofKeys` hook input), ARCHITECTURE.md (invariants 6
    and 12, glossary), decisions/0002-one-controller-version-per-entry.md,
    CHANGELOG.md (0.4.0, breaking)
  - encrypted-collections-spec: `#log-proof`, `#log-authorization`,
    `#log-verification` step 5, and `#log-append` carry the reduction rule
    (shipped 2026-08-22)
  - wallet-core: range bump to `^0.4.0` and the `proofKeys` test literals
    shipped in 0.52.1 (2026-08-22); the per-entry ladder rule in
    `src/resourceLog/license.ts`, the controller and fixture hook forwarding,
    and the co-signed license tests landed in the checkout 2026-08-22 for 0.53.0
  - freewallet: range bump to `^0.4.0` in the checkout (2026-08-22); was-client
    already allowed `^0.4.0`; dcw bumps when it next bumps wallet-core
  - app-connect-spec `decisions/0003-ladder-authority-clauses.md`: shape 2 gains
    the per-entry refinement (in the checkout, 2026-08-22)
- design: designs/VRL-4-entry-controller-version.md
- design-approved: 2026-08-22
- acceptance:
  - [x] `src/verify.ts` pre-pass implemented per design section 5; every row of
        the section 4 interaction matrix has a test or is exempted with the
        exemption recorded
  - [x] the consumer list in design section 3 is handled in full (this repo's
        three raw-input `toEqual` assertions, wallet-core's license, controller,
        fixture hook, and ten license-test literals, the "exactly two shapes"
        texts, app-connect-spec decision 0003, the range bumps in publish order)
  - [x] the section 7 test plan is green in this repo and wallet-core
  - [x] the doc edits in section 5 are made (ARCHITECTURE.md invariants 6 and 12
        and the glossary, CHANGELOG 0.4.0 breaking, the LEARNINGS.md lesson, and
        the spec passages in section 8 decision 3 edited by the maintainer)

`src/verify.ts:476`. `headVersionIndex` advances only after `verifyEntryProofs`
returns, so every proof in an entry is checked against the previous entry's head
controller version and at its own controller version. Alice removed at version
5, Bob carrying controller version 6 and Alice carrying version 4 on the same
entry: both pass, `headControllerVersionIndex` becomes 6, and `sealResourceLog`
reports the log sealed with a removed member's signature on its head. The spec's
rule (spec.md:1345-1347) is written per entry.

### VRL-5: Escape the segments of `resourceLogPinId`

- status: done (2026-08-22)
- priority: high
- labels: pin, ids
- verdict: confirmed
- touches:
  - vh-resource-log `src/pin.ts`, ARCHITECTURE.md (invariant 4)
  - wallet-core, was-client (any persisted pin ids change shape; greenfield, no
    migration) (not needed: shape unchanged)
- decision: reconsidered the percent-encoding approach. WAS requires Space,
  Collection, and Resource ids to be URL-safe, so a `/` cannot appear inside a
  valid id and the collision this item worried about cannot arise from valid
  ids. Encoding also needlessly changed pin ids for `urn:uuid:` spaceIds.
  Resolved instead with a guard: `resourceLogPinId` throws a `TypeError` on an
  empty or slash-bearing segment. The pin id shape (`space/<spaceId>/
  <collectionId>/<resourceId>`) is unchanged.
- acceptance:
  - [x] Two distinct `{ spaceId, collectionId, resourceId }` triples can never
        produce the same pin id (by refusing slash-bearing segments)
  - [x] Test with slash-bearing collection and resource ids
  - [x] The guard is recorded in ARCHITECTURE.md

`src/pin.ts:76` (derivation at `pin.ts:319`). A bare template concatenation with
`/`, so `{ collectionId: 'a/b', resourceId: 'c' }` and
`{ collectionId: 'a', resourceId: 'b/c' }` both map to `space/s/a/b/c`. The port
promises two different logs never share a `logId`; WAS leaves id format to the
implementer and was-client percent-encodes slots individually, so `a%2Fb` is a
legal collection. The encoding choice is a wire-level decision for the
maintainer.

### VRL-27: `readResourceLog` reports an absent log without consulting the pin

- status: done
- priority: medium
- labels: continuity, pin, read
- verdict: plausible
- touches:
  - vh-resource-log `src/append.ts` (`readResourceLog`), ARCHITECTURE.md
    (invariant 3 prose), `test/node/resourceLog-append.test.ts`
  - wallet-core `rotateRosterToDocumentAndCascade` and `ensureUserKeyRoster`
    (both treat a `null` read as the pre-genesis state), `descriptors.test.ts`
    and `keys-rosterLogStore.test.ts`
- acceptance:
  - [x] With a pin held for `logId`, a `store.read()` of `null` is refused as
        `ResourceLogContinuityError` with reason `rollback` and the pinned head
        attached, through `readResourceLog` and every caller of it
        (`appendResourceLog`, `createResourceLog`, `sealResourceLog`)
  - [x] With no pin held, an absent log still reads as `null`
  - [x] wallet-core's governed read and create paths surface the refusal instead
        of re-provisioning a fresh roster

`src/append.ts:67-70`. The absent branch returns before `pinStore.read`, so a
host that deletes or hides a log this client has pinned is reported as
pre-genesis. Downstream, wallet-core re-provisions a new roster with a fresh
epoch; the genesis pre-write pass is blind to it by design (`pin: null`, VRL-2
design section 2), and `settle`'s read-back only catches it as `scid-switch`
after `store.create` has landed a new log at the resource. Found by the VRL-2
ceremony-reviewer pass over wallet-core's log-governed store, 2026-08-22.

Landed 2026-08-22: vh-resource-log 0.4.1 (`readResourceLog` consults the pin
on an absent log; `createResourceLog` consults it before building or writing)
and wallet-core 0.53.0 (the governed store's `create` consults the pin; read
paths surface the refusal through the library).

### VRL-10: Move the sealing-sweep test suite into this repo

- status: done (2026-08-23)
- priority: medium
- labels: tests, docs
- verdict: confirmed
- touches:
  - vh-resource-log `test/node/`, ARCHITECTURE.md (line 133 claim), AGENTS.md
    (Tests section)
  - wallet-core `test/node/resourceLog-seal.test.ts` (moves out, or stays as a
    consumer-side integration test with its header fixed)
- acceptance:
  - [x] `sealResourceLog` and `latestAssertionRemovalIndex` are exercised by
        `pnpm test` here
  - [x] ARCHITECTURE.md's "moved in with their tests" statement is true

`ARCHITECTURE.md:133`. `grep -rl sealResourceLog test/` returns nothing; the
suite lives in wallet-core and still imports from `@interop/vh-resource-log`. A
seal regression is invisible to the breaking- release audit AGENTS.md runs from
this repo.

Landed 2026-08-23: vh-resource-log 0.4.2 (the sealing-sweep suite moved into
`test/node/resourceLog-seal.test.ts`, exercising `sealResourceLog` and
`latestAssertionRemovalIndex`); the wallet-core copy was deleted.
