# VRL-1: Run `admitAppend` after the signature check (design)

- item: VRL-1
- status: approved
- approved: 2026-08-22
- wire-level decisions contained: none
- decision records extracted: none (section 6's one do-not-reopen rejection,
  changing the kernel's authorize order, fails the qualifying test: reversible,
  and the kernel's own header states the order's rationale)

Review pass run 2026-08-22 (six charters plus a completeness critic); findings
are folded into the sections below and the points left for the maintainer are in
section 8.

## 1. Problem and scope

The did:webvh kernel's `verifyEntryProofs` loops over an entry's proofs and, for
each, calls the caller's `authorize` callback and only then verifies that
proof's signature (`did-method-webvh/src/assertions.ts:53-83`).
`verifyResourceLog` runs the controller port's `admitAppend` admission hook
inside `authorize` (`src/verify.ts:496-509`). Two things follow. First, the hook
is handed attacker-chosen input: for a served entry whose `proofValue` is
garbage, `keyMultibase`, `anchor`, and `anchorIndex` come from an unverified
proof, and wallet-core's license is consulted on them before any signature is
checked. Second, when the hook refuses, the refusal carries the consumer's class
(wallet-core's `ResourceLogLicenseError`) instead of
`ResourceLogIntegrityError`, and wallet-core's refusal predicates, which match
only the Integrity and Continuity names, route the forged log into their
warn-and-proceed and serve-stale-cache branches (section 3 lists them).

The encrypted-collections spec fixes the order: `#log-verification`
(spec.md:1416-1441) runs step 4 "Proofs" before step 5 "Authorization". Today's
placement is a conformance defect, not an internal preference.

The change: `authorize` keeps every check it runs today except the hook call,
and records the hook's input per proof instead. Once `verifyEntryProofs` has
resolved for the entry (every proof's signature verified), the recorded inputs
are drained through `admitAppend` in proof-array order, and only then does the
anchor floor advance. The rule the change establishes: within one entry, any
verification failure (shape, membership, anchor, signature) wins over an
admission refusal, and the hook is never consulted on a proof that did not
verify.

What this closes and what it does not. It closes the same-entry case: an entry
with a forged `proofValue` is refused as Integrity whatever the hook would have
said. It does not change whole-log first-failure semantics, so two shapes still
surface as the hook's class:

- A served log whose entry N is a genuine, validly signed append the license
  refuses, followed by a forged entry N+1. Verification stops at N with the
  license class; N+1 is never examined.
- An entry minted by a compromised key holder whose key is still under
  `assertionMethod` at an anchor the license refuses (`license.ts:94`:
  `headAnchorIndex >= anchorIndex`). The signature verifies, the drain runs, and
  the refusal is the license class.

Both are the consumer-side question of whether a license refusal on a served log
should be a soft class at all. That decision belongs to wallet-core's predicates
and is recorded as an open point in section 8, not solved here.

Also not in scope: the hook's input shape and the error classes (no wire
change); the per-proof granularity of the hook; the membership and anchor checks
staying inside `authorize` (they still run before the signature, a
class-invisible deviation from the spec's step order since both arms are
Integrity; moving them is not worth a second pass over the proofs); the anchor
rule itself (VRL-4); the pre-write admission pass (VRL-2); the classification of
controller-port throws inside `authorize` (VRL-6); a cap on proof-array length
(none exists today; see the cost note in section 4).

## 2. Invariant inventory

ARCHITECTURE.md invariants walked 1 through 10; 1, 3, 4, 5, 7, 8, and 10 are
untouched (the drain sits inside step 4+5 of the verify loop, the floor
assignment at `verify.ts:540` keeps its position relative to it, and the only
class-dispatching catch on the append path is `isResourceLogConflictError`,
`append.ts:167-175` and `:248-252`).

- 2, "the verifier recomputes everything; any failure rejects the whole log".
  Upheld. A hook refusal still rejects the log; the only change is which check
  runs first within an entry.
- 6, "the admission hook is where controller-domain append policy lives",
  ordering clause "after `assertionMethod` membership passes and before the
  anchor floor advances, for every entry past genesis", mechanism clause "a hook
  throw propagates with its class intact (the capture slot in `verify.ts`)".
  Changed in two places. The ordering clause gains "and after every proof of the
  entry has verified cryptographically". The mechanism clause changes because
  the hook no longer runs inside the kernel call: its throw propagates naturally
  and the capture slot is deleted. The `catch` around `verifyEntryProofs` then
  wraps kernel throws and controller-port throws raised inside `authorize`
  (`assertionKeysAt` at `verify.ts:483` still rejects there); that residual wrap
  is VRL-6's subject and gets simpler once the "non-hook" qualifier is gone. The
  doc edits are listed in section 5.
- 9, "error names are contracts". No name or `reason` is added or changed. The
  substance of the invariant is that cross-package catchers dispatch on
  `err.name`; this change alters which name a forged entry dispatches to, and
  section 3's reading of the predicates shows that restores the invariant's
  intent (a forged log reaches the refusal branch written for it).

Kernel behavior leaned on (`@interop/did-method-webvh`,
`src/assertions.ts:53-83`): `verifyEntryProofs` calls `authorize` for every
proof before verifying that proof's signature, verifies every proof in order,
and throws on the first failure, so "resolves without throwing" means every
proof in the array verified. This is an implementation property, not a
documented one: the JSDoc at `assertions.ts:17-27` describes the injected seams
and the fixed proof shape only. A future kernel change that short-circuits on
the first valid proof would let the drain admit unverified proofs and restore
the defect silently. Section 5 therefore adds the guarantee to the kernel's
JSDoc (in-house, one sentence) and section 7 names the multi-proof test as the
in-repo guard.

Library behavior leaned on: the "every proof verified" property also needs a
non-empty proof array, which the kernel does not require (`proof: []` is truthy;
the loop runs zero times and returns `true`). `checkEntryShape`
(`verify.ts:234-238`) is what refuses an empty array. That coupling predates
this item but the drain now rests on it too; section 7 pins it.

## 3. Consumer enumeration

Method: grep `admitAppend`, `isLogRefusal`, `isRosterRefusal`,
`verifyResourceLog`, `readResourceLog`, `appendResourceLog`,
`createResourceLog`, `sealResourceLog`, `confirmAppend`,
`webvhResourceLogController`, `convergeUserKeyRosterToAccount`,
`checkUserKeyRosterAtLogin`, `.seal()`, `ResourceLogLicenseError`,
`ResourceLogIntegrityError`, `ResourceLogContinuityError` over `src/` and
`test/` of this repo, wallet-core, was-client, freewallet, and was-react, and
over `app/` and `test/` of dcw (its source is not under `src/`); then follow
each hit up to the frame that dispatches on error class. A symbol grep alone
misses the seal path, which is reached through
`isSealableDescriptorStore(store).seal()`; the `isRosterRefusal` term is what
finds it.

In this repo:

- `src/verify.ts`, the one call site of `admitAppend`. Changes.
- `src/append.ts` (`readResourceLog`, `appendResourceLog`, `createResourceLog`)
  and `src/seal.ts`: call `verifyResourceLog` with no class-sensitive catch
  (`append.ts:167` and `:248` match only the conflict class); errors pass
  through. Unchanged code; their callers see the new classification, including
  on the write path (see the adversarial-host rows in section 4).
- `src/testing.ts` `fakeController`: attaches the hook verbatim. Unchanged.
- `test/node/resourceLog-admitAppend.test.ts`: header describes the capture
  mechanism (text changes). All six existing cases use validly signed logs or an
  admitting hook, and the multi-proof case sorts before comparing, so they pass
  under both orders. The regression cases are new.

In wallet-core:

- `src/resourceLog/controller.ts:283-292`, `webvhResourceLogController`'s
  `admitAppend`: reads `inventoryAt(anchor)` off the verified controller view
  and, for a ladder key, calls `assertLadderAppendLicensed` with the two indices
  from the hook input. A pure read of the view; it never observes whether the
  signature was checked first and does not use `this`. Unchanged code.
- `src/resourceLog/license.ts:60-100`, `assertLadderAppendLicensed`: stateless;
  refuses when `headAnchorIndex >= anchorIndex`. Under the new order it is never
  consulted for an entry whose signature fails. Unchanged code.
- `src/descriptors/acquire.ts:41-50` `isLogRefusal` and
  `src/clients/rosterPolicy.ts:110-121` `isRosterRefusal`: match
  `ResourceLogIntegrityError`, `ResourceLogContinuityError` (minus `rollback`),
  and (the roster one) the `UserKeyRoster*` names; `ResourceLogLicenseError` is
  in neither. Unchanged code. The frames that use them, and what flips for a
  forged-and-unlicensed entry:
  - `acquire.ts:155-159` (`acquireDescriptor`, above
    `src/descriptors/logSource.ts:73`): today `onFetchError` then the cached
    descriptor; after, the refusal is rethrown.
  - `rosterPolicy.ts:177` (`checkUserKeyRosterAtLogin`): today warn and return
    `null`; after, rethrown.
  - `rosterPolicy.ts:288` (`convergeUserKeyRosterToAccount`, converge step):
    today warn and return `unchanged`; after, rethrown.
  - `rosterPolicy.ts:312` (same function, the `store.seal()` step, which reaches
    `rosterLogStore.ts:310` then `sealResourceLog`): today warn and continue
    unsealed; after, rethrown.
  - `rosterPolicy.ts:340` (same function, the post-rotation re-read): today
    rewrapped in a generic `Error`; after, rethrown as Integrity.
- `src/keys/rosterLogStore.ts:202` (`settle`, read-back verify) has no local
  catch; its callers are the roster ceremonies above. `rosterLogStore.replace`
  also calls `assertLadderAppendLicensed` directly before its write, not through
  the hook; untouched here (VRL-2's territory).
- `ARCHITECTURE.md:575-578` states the license is enforced "inside the library
  verifier's per-proof authorization". That sentence goes stale and is a
  deliverable (section 5); it is the text the breaking-release audit reads to
  check wallet-core against the contract.
- Tests: `test/node/resourceLog-license.test.ts:280-305, 330-361` assert a
  license refusal on validly signed entries and `647-687` call the hook
  directly; `test/node/keys-rosterLogStore.test.ts:151-213` assert Integrity on
  tampered and spliced entries; the fixture hook at
  `test/node/fixtures/resourceLog.ts:99-107` records nothing. No wallet-core
  test encodes the hook-before-signature order or expects a forged entry as
  `ResourceLogLicenseError`.

Apps, where the rethrows above land:

- freewallet: `src/session/rosterStore.ts:98, 144` inject the hook-carrying
  controller; `src/session/initSession.ts:298` and `:535` call the roster check
  and converge with no catch, so a forged roster log now aborts login where it
  used to warn. Its own log-error dispatches (`recovery.ts:624`,
  `keyring.ts:820`, `LoginPage.tsx:109`, `RecoverPage.tsx:92`,
  `storageManager.ts:2085`) match Continuity only and see no difference.
  `freewallet/ARCHITECTURE.md:803` already describes a forged log as Integrity;
  no edit.
- dcw: `app/lib/sync/rosterStore.ts:65` injects the controller;
  `app/lib/sync/userKeySweep.ts:211` calls converge with no catch, and
  `app/lib/sync/engineStart.ts:84-136` turns any throw into `status: 'error'`,
  so a forged roster log now stops sync start where it used to continue on the
  cached key. Test dispatches (`test/loginRosterRollback.test.ts`) match
  Continuity only.

Parties-table walk (encrypted-collections-spec AGENTS.md:94-113), for the rows
not covered above:

- unaffected: was-client (`src/log/logStore.ts`, `src/log/index.ts` are the
  store-port adapter; no verifier call, no error-name dispatch). It still needs
  the dependency-range bump in section 5.
- unaffected: was-react (no match for any log error name or verifier call).
- unaffected: storage-core, was-teaching-server, was-conformance-suite (no
  client-side verifier).

## 4. Interaction matrix

Rows are served-log shapes the verifier meets; columns are the two hook orders.
"Same" means the outcome and class are identical before and after. Arity matters
because the kernel interleaves `authorize` and the signature check per proof, so
"today" for a multi-proof entry depends on which proof fails first.

| Served entry                                                              | Today                                                 | After                                          |
| ------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------- |
| Honest, one proof, hook admits                                            | verified                                              | same                                           |
| Honest, multi-proof, hook admits each                                     | verified; hook per proof, interleaved with signatures | verified; hook per proof, after all signatures |
| Honest, hook refuses (genuine unlicensed append, or a compromised holder) | hook's class                                          | same (the residual in section 1)               |
| Honest, hook throws a bug (`TypeError`)                                   | raw `TypeError`                                       | same                                           |
| Forged `proofValue`, one proof, hook would refuse                         | hook's class, on attacker-chosen input (the defect)   | `ResourceLogIntegrityError`, hook never called |
| Forged `proofValue`, one proof, hook would admit                          | Integrity                                             | same; hook never called                        |
| Multi-proof, proof 1 honest and admitted, proof 2 forged                  | hook called for proof 1 AND proof 2, then Integrity   | Integrity, hook never called                   |
| Multi-proof, hook would refuse proof 1, proof 2 forged                    | hook's class (the defect, multi-proof form)           | Integrity, hook never called                   |
| Multi-proof, hook would refuse proof 1, proof 2 fails membership/anchor   | hook's class                                          | Integrity (proof 2's `authorize` throws first) |
| Multi-proof, proof 1 admitted, proof 2 fails membership/anchor            | hook called once, then Integrity                      | Integrity, hook never called                   |
| Multi-proof, drain refuses proof 2 after admitting proof 1                | hook's class                                          | same                                           |
| Single proof failing membership, anchor, or controller DID                | Integrity (inside `authorize`)                        | same                                           |
| `assertionKeysAt` rejects with a non-Integrity error                      | wrapped as Integrity                                  | same (VRL-6)                                   |
| Entry N license-refused, entry N+1 forged                                 | hook's class at N                                     | same (the residual in section 1)               |
| Genesis entry                                                             | hook exempt                                           | same                                           |
| Hook-less controller                                                      | no admission step                                     | same                                           |
| Unversioned controller                                                    | hook gets `anchorIndex: null`                         | same                                           |
| Read-back after our own append, honest host                               | re-verify passes                                      | same                                           |
| Read-back after our own append, host appends a forged unlicensed N+1      | hook's class out of `appendResourceLog`               | Integrity out of `appendResourceLog`           |
| Sealing sweep over a served log with a forged unlicensed head             | hook's class out of `sealResourceLog`                 | Integrity                                      |

The rows that flip all flip toward Integrity, which is the direction every
consumer predicate in section 3 was written for.

Anchor-floor advance: today `entryAnchorIndex` is updated at the end of
`authorize`, after the hook; the floor is assigned after `verifyEntryProofs`
resolves. After the change `entryAnchorIndex` is still updated inside
`authorize` (it is the membership/anchor result, not an admission result), now
for every proof including ones the drain later refuses; it is a per-entry local
read only by the floor assignment, which still runs only after the drain
completes, so a hook refusal never advances the floor. The `headAnchorIndex` the
hook receives is still the previous entries' floor, because nothing assigns
`anchorFloor` between push and drain, including when two proofs of one entry
anchor at different versions.

Cost: today an admission refusal short-circuits before any signature
verification for that entry; after, every proof of the entry is verified first.
`checkEntryShape` caps neither proof-array length nor duplicates, so a host can
force N verifications per entry before a refusal. Accepted: the same host
already forces N verifications on any entry the hook admits, the work is bounded
by served-log size, which step 3 already hashes in full, and the missing cap
predates this item (out of scope, noted in section 1).

## 5. Design

`src/verify.ts`, inside the per-entry loop of `verifyResourceLog`:

- Delete `hookSlot` and its comment block, and the `hookSlot.thrown !== null`
  branch of the `catch` with its comment (`verify.ts:526-531`). Add
  `const admissions: Array<Parameters<NonNullable<ResourceLogController['admitAppend']>>[0]> = []`
  (the hook's existing input type; no new type is declared).
- In `authorize`, replace the `try { await controller.admitAppend(...) }` block
  with a push of the same object literal onto `admissions`, under the same
  `index > 0 && controller.admitAppend !== undefined` guard. The object carries
  `headAnchorIndex: anchorFloor` evaluated at push time, equal to the value at
  drain time (nothing assigns `anchorFloor` between the two).
- After the `verifyEntryProofs` call, outside its `try`/`catch`, drain:
  `for (const input of admissions) { await controller.admitAppend?.(input) }`.
  Call through `controller` so a class-based adapter keeps its receiver (the
  port declares the hook in method syntax); do not detach it into a local. The
  optional call re-evaluates presence per iteration, as the guard at the push
  site does today. A throw leaves the loop with its class intact because no
  wrapping code surrounds it.
- The `catch` keeps its two remaining branches: rethrow
  `ResourceLogIntegrityError`, otherwise wrap as `ResourceLogIntegrityError`
  with `cause`.
- `anchorFloor = entryAnchorIndex` stays where it is, now after the drain.

Comment edits in `src/verify.ts`: the module header sentence about "the capture
mechanism below" becomes "the hook runs after the kernel call, outside the
wrap"; the comment above the hook call moves to the drain and gains the
signature-first rationale; the `verifyResourceLog` JSDoc sentence on hook
propagation is unchanged in meaning.

Doc edits, this repo: ARCHITECTURE.md invariant 6 (ordering clause and mechanism
clause, as in section 2); `src/controller.ts` `admitAppend` JSDoc (ordering
sentence, plus one clause that the hook is not called for any proof of an entry
that fails verification, so an implementation must not depend on being called,
which the port's pure-check description already implies); the
`test/node/resourceLog-admitAppend.test.ts` header; ROADMAP VRL-1's `touches:`
(the test files, the wallet-core ARCHITECTURE.md line, the did-method-webvh
JSDoc line, and the range bumps below).

Doc edits, other repos (in-house): wallet-core `ARCHITECTURE.md:575-578`
("inside the library verifier's per-proof authorization" becomes "after the
entry's proofs verify, through the controller port's `admitAppend` hook");
did-method-webvh `src/assertions.ts` `verifyEntryProofs` JSDoc gains the
sentence "Resolves only after every proof in the array verified; throws on the
first failure" (section 2); byoe-ecosystem `LEARNINGS.md` gains a lesson under
"Cross-repo invariants and gotchas": a policy check placed inside a callback
that the callee invokes before its own verification runs on unverified input and
inverts which failure class the consumer sees.

Release: the CHANGELOG entry's version is an open point (section 8). The entry
text, under "Changed": the admission hook now runs after the entry's proofs
verify, so an entry with a forged `proofValue` is refused as
`ResourceLogIntegrityError` whatever the hook would have said, on the read path,
the read-back after an append, and the sealing sweep; consumers whose predicates
match only the Integrity and Continuity names (wallet-core's roster and
descriptor paths) now hard- refuse such a log where they warned and continued.
If the bump is a 0.x minor, wallet-core, was-client, and freewallet pin
`^0.1.2`, which a caret on 0.x does not widen to 0.2.0; all three need a range
bump and a release in dependency order (LEARNINGS.md, "Publish in dependency
order, then re-verify off the registry"), and the breaking-release doc-vs-code
audit runs over the parties table (the walk is in section 3).

Wire-level decisions: none. The hook's input object is unchanged member for
member, and no error name or `reason` value is added.

## 6. Alternatives rejected

- Call `verifyEntryProofs` twice: once with an admission-free `authorize` to
  establish the signatures, once more with the hook. Doubles the signature work
  on every entry for a reorder. Rejected.
- Change the kernel so `authorize` runs after the signature check. The kernel's
  order serves did:webvh's own `documentStateIsValid`, where refusing an
  unauthorized key before the crypto is the cheap path, and the kernel is
  shared; a consumer-specific ordering does not belong there. Rejected.
  Do-not-reopen unless the kernel grows a separate post-verification hook, in
  which case this library's drain can move onto it.
- Call the hook once per entry after verification, passing all proofs. Changes
  the hook's input shape (a wire-level contract) and contradicts invariant 6's
  per-proof rule. Rejected.
- Fix it on the consumer side by having `isLogRefusal` / `isRosterRefusal` also
  match the license class. On the read path the verifier cannot tell a genuinely
  appended unlicensed entry from an attacker-minted one (both chain-valid and
  signature-valid), so widening the predicates is a policy decision about
  license refusals as such, not a classification fix; it would also leave the
  hook running on unverified input. Deferred to the wallet-core open point in
  section 8 rather than rejected outright; it does not replace this reorder.
- Keep the hook inside `authorize` and re-classify its throw as Integrity
  whenever a later signature check would have failed. Not implementable:
  `authorize` runs before that check and cannot know its result.

## 7. Test plan

Fixture: the co-signed two-proof entry is built inline today inside one case
(`resourceLog-admitAppend.test.ts:81-138`, two dynamic kernel imports and a
strip-and-re-sign). Extract it as a `coSignEntry` helper in
`test/node/fixtures/log.ts` (takes an entry and a second signer, returns the
entry with the added proof) so the cases below share it.

New cases in `test/node/resourceLog-admitAppend.test.ts`:

- A two-entry log with `proofValue` of entry 2 replaced by garbage, a controller
  whose hook throws `FakeAdmissionRefusal` on every call: rejects with
  `ResourceLogIntegrityError`, and the hook was called zero times (the
  acceptance box's primary case).
- A co-signed entry with the second (Bob) proof forged and a recording hook:
  rejects with `ResourceLogIntegrityError` and the recording hook saw no call,
  including none for Alice's valid first proof. This is the named in-repo guard
  for the kernel's every-proof-verified property (section 2).
- A co-signed entry with a hook that refuses Alice's key and Bob's proof forged:
  `ResourceLogIntegrityError` (the multi-proof form of the defect).
- An ordering probe: a hook that records `headAnchorIndex` on a log whose
  entries step the anchor from `1-v1` to `2-v2`; the recorded values are
  unchanged from today's (`0` for entry 2, the previous floor), proving the
  drain runs before the floor advances.
- A co-signed third entry anchored at `2-v2` on a log whose entry 2 anchors at
  `1-v1`, with a recording hook: both of entry 3's inputs carry
  `headAnchorIndex: 0`, the previous entries' floor (the floor does not move
  between push and drain within an entry).
- An entry served with `proof: []` is refused as Integrity with the hook never
  called (pins the shape-check coupling in section 2).

Existing cases that must stay green: all of `resourceLog-admitAppend.test.ts`,
`resourceLog-verify` and `resourceLog-append` in full, and wallet-core's
resource-log, roster, and seal suites run against this checkout.

## 8. Open questions

1. Version and release shape (maintainer). Invariant 9's letter says only a
   `name` change is breaking, which would make this 0.1.3 and let consumers pick
   it up through `^0.1.2`. The observable effect, though, is that freewallet
   login and dcw sync start hard-fail on a forged roster log where they warned
   before, which is a behavior consumers dispatch on. Recommendation: 0.2.0 with
   the entry labeled breaking, the three range bumps, and the parties-table
   audit (section 5). Answer lands in CHANGELOG.md and the `touches:` field.
2. License refusals as a soft class (maintainer, wallet-core). The two residual
   shapes in section 1 surface as `ResourceLogLicenseError` and fall to the warn
   / serve-cached branches. Whether a license refusal on a served log should
   hard-refuse like Integrity is a wallet-core policy decision; recommendation:
   a wallet-core roadmap item noting `discovered-from: VRL-1`. Answer lands in
   wallet-core's ROADMAP.md.
