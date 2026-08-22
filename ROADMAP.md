# vh-resource-log Roadmap (open items)

Status as of 2026-08-22. Uses the formalized item structure shared across the
`@interop/*` repos (canonical in isomorphic-lib-template's AGENTS.md, "Roadmap &
Task Conventions").

Scope: open work items only. This document tracks the **remaining** items;
completed items move verbatim to [archived-roadmap.md](archived-roadmap.md) as
they land, so VRL-N references keep resolving (CHANGELOG.md remains the record
of what landed).

## Item format

Each work item is a `### VRL-N: Title` heading followed by a field block and
free prose context. Ids are permanent and never reused; new items take the next
unused number regardless of section. Statuses: `todo`, `in-progress`, `draft`
(no actionable done-state yet -- blocked externally or a parking record); `done`
items move to [archived-roadmap.md](archived-roadmap.md) once shipped. Full
conventions live in isomorphic-lib-template's AGENTS.md under "Roadmap & Task
Conventions".

---

## Source of the current items

VRL-1 through VRL-26 come from a whole-tree code review run on 2026-08-22 (VRL-1
has shipped and lives in [archived-roadmap.md](archived-roadmap.md); eight
finder angles, each candidate independently verified against the code, the
encrypted-collections spec, and the wallet-core / was-client call sites). The
verdict recorded on each item is the verifier's: `confirmed` means the failure
was reproduced or traced end to end, `plausible` means the mechanism is real but
the observable effect needs a caller that does not exist in-tree today.

Items VRL-1, VRL-2, and VRL-4 change verifier semantics that ARCHITECTURE.md
documents as invariants, so they carry the design gate. Items that add a new
error class, `reason` value, or other error-name contract (VRL-6, VRL-13,
VRL-16) need the wire-level convention decided by the maintainer before coding.

## Verifier and append correctness

### VRL-2: Pre-write admission pass in `appendResourceLog`

- status: in-progress
- priority: high
- labels: append, admission, poisoning
- verdict: confirmed
- touches:
  - vh-resource-log `src/verify.ts` (the extracted per-entry check and the
    export), `src/append.ts`, `src/controller.ts` and `src/errors.ts` (JSDoc),
    `src/index.ts`, ARCHITECTURE.md (invariants 6/7/10 prose, new invariant 11,
    ownership heuristic), CHANGELOG.md (0.3.0)
  - wallet-core `src/keys/rosterLogStore.ts` (`replace` and `create` adopt the
    export; the inline ladder-license block goes; ceremony-reviewer pass over
    the `lastVerified` / controller-floor lifecycle when made),
    ARCHITECTURE.md:574-587 (two passages), dependency range; WC-149 interaction
    noted there
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
  - [ ] wallet-core's `rosterLogStore.replace` and `create` call the export
        (each write site in design doc section 3 handled or exempted)

`src/append.ts:166`, `src/entry.ts:55`. `anchoredVerificationMethod` stamps
`versionIds[last]` unconditionally and the entry is written straight after
`buildResourceLogEntry`. A client whose key was removed at the latest controller
version (or the sealing sweep driven by it) writes durably, `confirmAppend`'s
re-verify then fails, and every future reader fails from genesis because the
entry cannot be removed. wallet-core's `rosterLogStore.replace` duplicates only
the ladder-license half pre-write and its comment names exactly this hazard.

### VRL-3: Reject an empty ETag as "no validator"

- status: todo
- priority: high
- labels: append, cas
- verdict: confirmed
- acceptance:
  - [ ] `appendResourceLog` and `createResourceLog` treat `''` (and any other
        empty validator) the same as `undefined`: refuse to write rather than
        send a blank `If-Match`
  - [ ] Unit test with a store whose `read` returns `etag: ''`

`src/append.ts:146`. The no-unconditional-write guard tests only
`etag === undefined`. was-client's `readEtag` maps a present-but-blank `ETag`
header to `''`, which the guard passes, so `writeHeaders` emits a literal empty
`If-Match` that a server may ignore (invariant 8 forbids an unconditional
write). On the encrypted-collection codec path the same value 412s on all three
CAS attempts instead.

### VRL-4: Check every proof against the entry's own anchor

- status: todo
- priority: high
- labels: verify, anchoring, seal
- verdict: confirmed
- touches:
  - vh-resource-log `src/verify.ts`, ARCHITECTURE.md
  - encrypted-collections-spec (the spec states the per-entry rule but does not
    say how divergent per-proof `versionId`s reduce to one entry anchor; decide
    and write it down)
  - wallet-core `src/resourceLog/license.ts` (the one-shot license is fed the
    same floor)
- design: not yet drafted
- design-approved:
- acceptance:
  - [ ] Within one entry, each proof's membership is checked at the entry's
        effective anchor (or the entry is refused when its proofs disagree),
        rather than at the proof's own anchor against the previous entry's floor
  - [ ] A multi-proof entry carrying a removed member's proof anchored below a
        co-signer's anchor is refused
  - [ ] Two ladder-signed proofs at one inventory-changing version no longer
        both pass a one-shot `admitAppend` license
  - [ ] Multi-proof test cases added to `test/node/resourceLog-verify.test.ts`

`src/verify.ts:476`. `anchorFloor` advances only after `verifyEntryProofs`
returns, so every proof in an entry is checked against the previous entry's
floor and at its own anchor. Alice removed at version 5, Bob anchored at 6 and
Alice at 4 on the same entry: both pass, `headAnchorIndex` becomes 6, and
`sealResourceLog` reports the log sealed with a removed member's signature on
its head. The spec's rule (spec.md:1345-1347) is written per entry.

### VRL-5: Escape the segments of `resourceLogPinId`

- status: todo
- priority: high
- labels: pin, ids
- verdict: confirmed
- touches:
  - vh-resource-log `src/pin.ts`, ARCHITECTURE.md (invariant 4)
  - wallet-core, was-client (any persisted pin ids change shape; greenfield, no
    migration)
- acceptance:
  - [ ] Two distinct `{ spaceId, collectionId, resourceId }` triples can never
        produce the same pin id (encode each segment, or length-prefix)
  - [ ] Test with slash-bearing collection and resource ids
  - [ ] The chosen encoding is recorded in ARCHITECTURE.md

`src/pin.ts:76` (derivation at `pin.ts:319`). A bare template concatenation with
`/`, so `{ collectionId: 'a/b', resourceId: 'c' }` and
`{ collectionId: 'a', resourceId: 'b/c' }` both map to `space/s/a/b/c`. The port
promises two different logs never share a `logId`; WAS leaves id format to the
implementer and was-client percent-encodes slots individually, so `a%2Fb` is a
legal collection. The encoding choice is a wire-level decision for the
maintainer.

### VRL-6: Do not classify a throwing `assertionKeysAt` as fabrication

- status: todo
- priority: medium
- labels: verify, error-classification
- verdict: plausible
- touches:
  - vh-resource-log `src/verify.ts`, `src/errors.ts`, ARCHITECTURE.md (invariant
    9 if a new name or reason is introduced)
  - wallet-core (`isLogRefusal`, `isRosterRefusal`)
- acceptance:
  - [ ] A non-kernel throw from the controller port inside `authorize`
        propagates as itself (or as a separately classified error), not as
        `ResourceLogIntegrityError`
  - [ ] Test with a controller whose `assertionKeysAt` rejects

`src/verify.ts:535`. The catch around `verifyEntryProofs` wraps every non-hook,
non-Integrity throw as `ResourceLogIntegrityError`. The only shipped adapter is
an in-memory view that rejects only with an Integrity-class refusal, which is
why this is plausible rather than confirmed, but the port is async and a
resolver or IndexedDB failure in a future adapter would be reported as tampering
and hard-refused by wallet-core. Any new error name or `reason` value is a
wire-level decision for the maintainer (see also VRL-13).

### VRL-7: Validate `versionTime` as RFC3339 UTC

- status: todo
- priority: medium
- labels: verify, shape
- verdict: confirmed
- acceptance:
  - [ ] Shape check uses an RFC3339 date-time pattern with a `Z` suffix
  - [ ] `'Aug 22 2026 Z'` and `'2026Z'` are refused; tests added

`src/verify.ts:152`. `endsWith('Z') && !isNaN(Date.parse(...))` accepts
non-RFC3339 strings that Node happens to parse. wallet-core's client-annex gc
compares the newest entry's `versionTime` against a quiet bound, so a lenient
value resolves to a wrong instant instead of being refused. Only
`'not-a-timestamp'` is tested today.

### VRL-8: Refuse an array-valued `parameters` member

- status: todo
- priority: medium
- labels: verify, shape
- verdict: confirmed
- acceptance:
  - [ ] `checkEntryShape` rejects `parameters: []` (and any non-plain-object) on
        non-genesis entries
  - [ ] Test added next to the existing `{ updateKeys: [] }` case

`src/verify.ts:163`. `typeof parameters !== 'object'` admits an array and
`Object.keys([]).length` is 0, so the non-genesis "must be `{}`" branch is
skipped. The spec says `parameters` is a JSON object. Genesis is safe because
the `method` check catches it.

### VRL-9: Make the `sealed` report independent of the `verified` hint

- status: todo
- priority: medium
- labels: seal, reporting
- verdict: confirmed
- touches:
  - vh-resource-log `src/seal.ts`, ARCHITECTURE.md (invariant 10 prose)
  - wallet-core `rosterLogStore.seal()` (maps the flag to `'sealed' | 'noop'`)
- acceptance:
  - [ ] `sealResourceLog` reports `sealed: true` only when this call wrote the
        sealing entry; an already-sealed log read fresh or via a stale hint
        reports the same result
  - [ ] The two "nothing to seal against" returns agree on `verified`
  - [ ] Tests land in this repo (see VRL-10)

`src/seal.ts:167`. With a stale hint whose `headAnchorIndex < removalIndex`,
`appendResourceLog`'s fresh read finds the log already sealed, `buildState`
returns `null`, nothing is written, and the call still returns
`{ sealed: true }`; the same state read without a hint returns `sealed: false`
at line 149. Lines 124-125 also return `verified: null` when a hint was
supplied, unlike line 129. wallet-core surfaces the flag as a ceremony outcome.

### VRL-10: Move the sealing-sweep test suite into this repo

- status: todo
- priority: medium
- labels: tests, docs
- verdict: confirmed
- touches:
  - vh-resource-log `test/node/`, ARCHITECTURE.md (line 133 claim), AGENTS.md
    (Tests section)
  - wallet-core `test/node/resourceLog-seal.test.ts` (moves out, or stays as a
    consumer-side integration test with its header fixed)
- acceptance:
  - [ ] `sealResourceLog` and `latestAssertionRemovalIndex` are exercised by
        `pnpm test` here
  - [ ] ARCHITECTURE.md's "moved in with their tests" statement is true

`ARCHITECTURE.md:133`. `grep -rl sealResourceLog test/` returns nothing; the
suite lives in wallet-core and still imports from `@interop/vh-resource-log`. A
seal regression is invisible to the breaking- release audit AGENTS.md runs from
this repo.

### VRL-11: Make `memoryLogStore` faithful to the store port

- status: todo
- priority: medium
- labels: testing, fixtures
- verdict: confirmed
- touches:
  - vh-resource-log `src/testing.ts`, AGENTS.md (fixture fidelity statement)
  - wallet-core (its resource-log tests run on this fake)
- acceptance:
  - [ ] `read` and `append` round-trip entries through `parseResourceLog` /
        `serializeResourceLogEntry` so a non-JSON value in `state` diverges in
        the fake the same way it does against was-client
  - [ ] `append` without a prior `read` is refused, matching the port's
        documented precondition (`store.ts:47`)

`src/testing.ts:96`. The fake stores `structuredClone(entries)`. A `Date` in
`state` canonicalizes to `{}` on the fixture path and hashes consistently, but
the real adapter JSON-serializes it to a string, so read-back verification fails
only in production.

### VRL-12: Guard `checkState` against `null` and `undefined`

- status: todo
- priority: low
- labels: entry, robustness
- verdict: confirmed
- acceptance:
  - [ ] `checkState(null)` and `checkState(undefined)` throw the intended misuse
        `Error`, not a `TypeError`
  - [ ] `checkState` and `checkEntryShape`'s state rule share one predicate

`src/entry.ts:68`, `src/verify.ts:219`. `typeof (state as ...).type` runs with
no null guard; `append.ts:153` gates only on `state === null`, so a JS
`buildState` returning `undefined` reaches it. `checkEntryShape` already has the
guarded form of the same rule.

## Error contracts and classification

### VRL-13: Distinguish "anchor unknown to this reader" from fabrication

- status: draft
- priority: medium
- labels: verify, error-classification
- verdict: plausible
- touches:
  - vh-resource-log `src/verify.ts`, `src/errors.ts`, ARCHITECTURE.md
  - wallet-core (`currentController` freshness, refusal predicates)
  - encrypted-collections-spec (spec.md:1366-1368 ratifies the rejection;
    classification is unspecified)

`src/verify.ts:468-474`. Rejecting an anchor past the reader's controller head
is the documented design, but the refusal is a reason-less
`ResourceLogIntegrityError`, indistinguishable from tampering, so wallet-core
hard-refuses where a controller refresh and retry would recover. Draft because
the fix is a new error name or `reason` value, which is a wire-level decision
for the maintainer, and because the stale-view case may be better handled on the
wallet-core side (`currentController` only supersedes its own floor).

### VRL-14: Attach served entries to the rollback refusal

- status: todo
- priority: low
- labels: verify, errors, docs
- verdict: plausible
- acceptance:
  - [ ] The `reason: 'rollback'` throw at `verify.ts:592` carries
        `servedEntries` like the fork throw does
  - [ ] `errors.ts` wording for rollback notes that a shorter served log may
        also be equivocation, not only replication lag

`src/verify.ts:592`. A short-and-divergent log is labeled the retryable
`rollback` class without evidence, before the fork comparison runs. With a
`{ method, scid, head }` pin there is nothing to compare against below the
pinned ordinal, so the classification cannot be sharpened; the contract text and
the missing evidence can.

### VRL-15: Make `pin` a required (nullable) argument of `verifyResourceLog`

- status: todo
- priority: low
- labels: verify, api
- verdict: plausible
- touches:
  - vh-resource-log `src/verify.ts`, ARCHITECTURE.md (invariant 1)
  - wallet-core `src/keys/rosterLogStore.ts` (already passes a pin; compiles
    unchanged)
- acceptance:
  - [ ] `pin: ResourceLogHeadPin | null` with no default; first contact is
        stated as `null`
  - [ ] In-repo tests updated

`src/verify.ts:359`. The exported verifier takes `pin?:`, so the pin rules
ARCHITECTURE.md invariant 1 says cannot be bypassed are bypassed by omission. No
production caller omits it.

### VRL-16: Error classes for caller-misuse throws in `append.ts`

- status: draft
- priority: low
- labels: errors, api
- verdict: plausible

`src/append.ts`. "the log does not exist yet", "the backend returned no
validator", and "lost the compare-and-swap race N times in a row" are bare
`Error`s, so invariant 9's match-by-`name` rule cannot reach them. jsonl.ts
documents the plain-`Error` convention for misuse guards, which covers the first
two; CAS exhaustion is the one a caller may want to retry on by class. Draft
pending the maintainer's decision on whether to add a name (an error-name
contract is wire-like here).

### VRL-17: Export `name`-based predicates for the refusal classes

- status: todo
- priority: low
- labels: errors, api
- verdict: plausible
- acceptance:
  - [ ] `isResourceLogIntegrityError`, `isResourceLogContinuityError` (with the
        `reason !== 'rollback'` variant consumers need) and
        `isLogNotConfirmedError` exported beside `isResourceLogConflictError`
  - [ ] wallet-core and freewallet call sites can drop their duck-typed `name`
        readers (follow-up in those repos)

`src/errors.ts:163`. Only `isResourceLogConflictError` exists. Every consumer
re-implements the same `(err as { name?: unknown })?.name` comparison, including
the rollback carve-out twice.

## Cleanup

### VRL-18: Factor the verify-then-pin block in `append.ts`

- status: todo
- priority: low
- labels: cleanup, append
- verdict: confirmed
- acceptance:
  - [ ] One private helper replaces the three identical verify-then-pin-write
        sites (`append.ts:65-71`, `178-184`, `263-269`)

### VRL-19: Share the sealed predicate in `seal.ts`

- status: todo
- priority: low
- labels: cleanup, seal
- verdict: confirmed
- acceptance:
  - [ ] `headAnchorIndex !== null && headAnchorIndex >= removalIndex` appears
        once (lines 145-148 and 160-163 today)

Pairs naturally with VRL-9.

### VRL-20: Collapse the malformed-pin and fork guards in `verify.ts`

- status: todo
- priority: low
- labels: cleanup, verify
- verdict: confirmed
- acceptance:
  - [ ] The malformed-`pinnedOrdinal` guard (586-591) and the head-mismatch
        guard (598) become one `fork` throw placed after the rollback check,
        with identical `reason` outcomes for every input

### VRL-21: Delete `src/declarations.d.ts`

- status: todo
- priority: low
- labels: cleanup
- verdict: confirmed
- acceptance:
  - [ ] File removed; `pnpm build` and `pnpm lint` pass

The file holds only a commented-out `declare module 'jsonld'`; nothing imports
`jsonld`.

### VRL-22: Use the kernel's `versionId` parse in `confirmAppend` and `entry.ts`

- status: todo
- priority: low
- labels: cleanup, robustness
- verdict: confirmed (entry.ts), plausible (store.ts)
- acceptance:
  - [ ] `entry.ts:220-222` uses the `versionNumber` returned by
        `parseAndValidateVersionId` instead of a second `Number.parseInt`
  - [ ] `store.ts:98` (`confirmAppend`, public API) derives the ordinal the same
        way rather than with a looser `parseInt`

Both downstream checks are fail-closed today, so this is consistency, not a bug.

### VRL-23: Replace the direct `json-canonicalize` import with the kernel's canonicalizer

- status: todo
- priority: low
- labels: cleanup, dependencies
- verdict: confirmed
- touches:
  - vh-resource-log `src/store.ts`, `package.json`, ARCHITECTURE.md (layer map
    line 44 lists `json-canonicalize` as a direct dependency)
- acceptance:
  - [ ] `confirmAppend` uses `canonicalizeStrict` from
        `@interop/did-method-webvh`; output is byte-identical for JSON-parsed
        and literal-built entries
  - [ ] `json-canonicalize` dropped from direct dependencies

### VRL-24: Thread the first read into `appendResourceLog` from `sealResourceLog`

- status: todo
- priority: low
- labels: cleanup, efficiency, seal
- verdict: plausible
- acceptance:
  - [ ] `sealResourceLog`'s own `readResourceLog` result (etag and verified
        view) seeds `appendResourceLog`'s first attempt instead of being read
        again

`src/seal.ts:133` then `src/append.ts:129`. Redundant but cheap in practice:
wallet-core threads `verified` on every call after the first. Consider together
with VRL-9.

### VRL-25: `substituteScid` re-derives the kernel's `replaceValueInObject`

- status: draft
- priority: low
- labels: cleanup, kernel-boundary
- verdict: plausible

`src/verify.ts:253-268` is a hand-rolled inverse of the kernel's
`replaceValueInObject`, which ARCHITECTURE.md's ownership heuristic says not to
re-derive here. The helper is not in the kernel's export map, and the two differ
in semantics (whole-string equality here, `replaceAll` substring there), so a
swap changes behavior. Draft: either export a whole-value variant from
`@interop/did-method-webvh` (in-house change) and import it, or record in
ARCHITECTURE.md why this one is local. Note also that
`verifyResourceLogHandover` has no call site in any consumer today; keep it
(decision 0001 moved it in deliberately) but say so in ARCHITECTURE.md.

## Conventions

### VRL-26: Comment wording that the house style forbids

- status: todo
- priority: low
- labels: conventions, comments
- verdict: confirmed
- acceptance:
  - [ ] "spellings" / "spelled" replaced in `src/vmFragment.ts:8-9` and
        `test/node/vmFragment.test.ts:4`
  - [ ] "X, never Y" phrasing rephrased in `src/append.ts:197`,
        `src/errors.ts:30`, `src/index.ts:21`, and
        `test/node/resourceLog-verify.test.ts:152`

A mechanical pass over the remaining CONTRIBUTING.md rules (arrow/mdash/
ellipsis characters, collapsed JSDoc, `catch (e)`, `.cause` mutation,
`testing.ts` imports from production code, `node:` prefixes, default imports,
module-level arrow functions, single-use named types) found nothing.
