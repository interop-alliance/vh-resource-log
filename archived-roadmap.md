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
