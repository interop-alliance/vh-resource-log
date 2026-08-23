# VRL-4: Check every proof against the entry's own controller version (design)

- item: VRL-4
- status: approved
- approved: 2026-08-22
- wire-level decisions contained: none (section 5 flags one public hook-input
  member name and one spec-text sentence, neither a wire artifact)
- decision records extracted: decisions/0002-one-controller-version-per-entry.md
  (the max-reduction rejection, section 6)

Review pass run 2026-08-22 (six charters plus a completeness critic). Findings
are folded into the sections below; the points left for the maintainer are in
section 8. The pass changed the design in three places: the pre-pass also
requires distinct signing keys within an entry, because the proof array and its
order are outside the hash and every signature (section 5); the hook contract
gains an order-insensitivity obligation for the same reason (sections 2 and 5);
and `proofKeys` is stated as a verified-keys property rather than a wire view of
the array (section 2, invariant 6).

On 2026-08-22 the maintainer retired "anchor" for "controller versionId" across
the spec, ARCHITECTURE.md, and code; this doc was updated to match, keeping its
structure and file:line citations as they were. Later the same day "version
floor" was renamed "head controller version" (`headVersionIndex`,
`verifyEntryAgainstHead` in code), again without touching the citations.

## 1. Problem and scope

This doc relies on two terms. The controller versionId is the `versionId` DID
parameter on a proof's `verificationMethod` URL: it names the controller
document version the signing key's `assertionMethod` membership is checked at.
The head controller version is the value the verifier carries as it walks the
log: the controller version index the verified predecessor entries left behind.
An entry's controller versionId must be at or past it (controller-version
monotonicity), and it becomes the entry's own after the entry passes.

`verifyEntryAgainstHead` (`src/verify.ts:427-558`) checks a multi-proof entry
proof by proof. The `authorize` closure (`src/verify.ts:462-525`) parses the
proof's own `versionId`, checks it against `headVersionIndex` (the head
controller version the previous entries left behind), and checks the signing
key's `assertionMethod` membership at that version. `entryVersionIndex` becomes
the maximum over the proofs only after every proof has passed
(`src/verify.ts:524`). The hook input recorded for every proof carries
`headControllerVersionIndex: headVersionIndex` (`src/verify.ts:516-522`).

So a proof is checked at its own controller versionId against the predecessors'
head controller version, and the entry's controller versionId is whatever the
highest proof said. Alice is removed from `assertionMethod` at controller
version 5. Bob signs an entry carrying controller version 6 and Alice co-signs
it carrying version 4. Alice's proof passes (4 is at or past the head controller
version, and she was a member at 4), Bob's passes, the entry's controller
versionId becomes 6, and `sealResourceLog` (`src/seal.ts:148-149`) reports the
log sealed with a removed member's signature on its head. The same shape lets
two ladder-key proofs on one entry both pass wallet-core's one-shot license:
each proof's hook input carries the same pre-entry `headControllerVersionIndex`,
so the license (`wallet-core/src/resourceLog/license.ts:94-99`) sees the version
as unspent for both.

The spec leaves the reduction undefined. The controller versionId is defined per
proof (`encrypted-collections-spec/spec.md:1330-1339`, the `versionId` DID
parameter of the proof's `verificationMethod`). The authorization rule
(`spec.md:1345-1347`) and the monotonicity rule (`spec.md:1369-1372`) are
written per entry ("the entry's controller version"). Multi-proof entries are
permitted (`spec.md:1311`, `1327-1328`). Nothing says what the entry's
controller version is when its proofs carry different `versionId`s.

The kernel sets the constraint on the fix. `verifyEntryProofs`
(`did-method-webvh/src/assertions.ts:31-88`) loops over the proofs in order,
calling `authorize` and then `resolveVM` per proof with no lookahead. An
`authorize` call for proof 1 cannot know proof 2's controller versionId. The
entry-level controller versionId must therefore be computed before the kernel
call, from the parsed `verificationMethod` strings alone.

The change: an entry carries one controller versionId, by distinct signing keys.
Every proof of an entry carries the same controller versionId (or none, under an
unversioned controller); proofs that disagree refuse the log, and so does a
signing key that appears twice. That one controller versionId is checked for
presence and monotonicity once per entry, every signing key is checked for
membership at it, and it is the head controller version for the next entry. The
hook gets the entry's controller versionId as `controllerVersionIndex` for every
proof and a new member listing every proof's signing key, so wallet-core's
license can refuse an entry that carries more than one ladder-key proof.

The distinct-keys rule exists because the proof array is not integrity-bound.
The hash input omits `proof` (`src/verify.ts:286-296`) and each proof signs the
entry minus the array plus its own options
(`did-method-webvh/src/assertions.ts:47, 76-79`), so a host can duplicate or
reorder proofs without touching `versionId`, the pin, or any signature. Without
the rule, two served copies of one honest ladder proof would pass the pre-pass
and be refused by wallet-core's per-entry count as `ResourceLogLicenseError`,
the class the library documents as not evidence of a doctored log. With it, the
duplicate is refused as Integrity before any signature check.

Not in scope: the classification of controller-port throws (VRL-6; the pass
keeps one `assertionKeysAt` call per entry inside the same wrap), the sealing
report (VRL-9), the test-file move (VRL-10), the pin and `VerifiedResourceLog`'s
shape (unchanged), `verifyResourceLogAppend`'s signature (it shares the changed
function and changes behavior with it, no API change), and error names (none
added; every new refusal is `ResourceLogIntegrityError`).

## 2. Invariant inventory

ARCHITECTURE.md invariants walked 1 through 11. 1, 4, 5, 7, 8, and 9 are
untouched (no read entry point, pin-id, controller-resolution, read-back, CAS,
or error-name change).

- 2, "the verifier recomputes everything; any failure rejects the whole log".
  Upheld. The new refusals (divergent controller versionIds, a repeated signing
  key, membership at the entry's controller versionId) are Integrity and reject
  the log.
- 3, "the pin is established at first contact, advances only past a full
  verification". Upheld, and leaned on in one direction: the pin stores
  `{ method, scid, head }` and no controller versionId (`src/verify.ts:721`), so
  no client state carries a value the new rule would recompute differently. A
  durable log that the new rule refuses keeps its pin held (section 4).
- 6, "the admission hook is where controller-domain append policy lives", called
  per proof, after membership, after every proof verified, before the head
  controller version advances. Ordering upheld: the pre-pass and membership
  checks run before the kernel call, the drain runs after it, and the head
  controller version advances after the drain. Input changed:
  `controllerVersionIndex` is now the entry's controller versionId for every
  proof (it was each proof's own controller versionId, which under invariant 12
  is the same thing), and the input gains `proofKeys` (section 5) so a hook can
  apply a per-entry policy without the library carrying it. The library still
  carries no ladder policy. The invariant's clause "the hook never sees input
  from an unverified proof" is restated per entry: every key in `proofKeys`
  belongs to a proof of the same entry that verified through the kernel and
  passed membership, because the drain (`src/verify.ts:555-557`) runs only after
  `verifyEntryProofs` returns and the kernel throws on the first failure
  (`did-method-webvh/src/assertions.ts:26-29`). A refactor that moved the drain
  inside the kernel wrap would break this property, which is why the doc edit
  names it. New obligation on the hook: proof order is not integrity-bound
  (section 1), so a hook must treat `proofKeys` as a set and return the same
  verdict for any ordering; the identical-input promise for pre-write and
  read-back holds up to that order. Doc edits: ARCHITECTURE.md invariant 6, the
  sentences at `:85-88` ("after `assertionMethod` membership passes ... the hook
  never sees input from an unverified proof"); the matching comment block in
  `src/verify.ts:546-553`; the `test/node/resourceLog-admitAppend.test.ts:1-14`
  header; and the port JSDoc in `src/controller.ts`.
- 10, "sealing is computed from durable state alone", the log's side being the
  verified head's effective controller version. Upheld and made sound: after the
  change the head's `headControllerVersionIndex` is the controller versionId
  every proof of the head carries and every signer of the head was a member at
  it. A removed member's proof can no longer ride on a co-signer's controller
  versionId, which closes the roadmap's seal scenario. `seal.ts` code is
  unchanged.
- 11, "the write path refuses before the host does". Upheld.
  `verifyResourceLogAppend` (`src/verify.ts:762-802`) calls
  `verifyEntryAgainstHead`, so a writer refuses a divergent, duplicated, or
  removed-co-signer candidate pre-write, from the same code. The create path's
  one-entry `verifyResourceLog` over the genesis shares the rule; a refused
  co-signed genesis against an existing log still falls through to lost-race
  adoption (`src/append.ts:270-290`).
- New invariant 12, recorded in ARCHITECTURE.md's invariants list (section 5):
  an entry carries one controller versionId, by distinct signing keys. Every
  proof of an entry carries the same `versionId` controller version (or none, on
  an unversioned controller), and no signing key appears twice; proofs that
  disagree, or a repeated key, refuse the log as Integrity. That one controller
  versionId is checked for presence and monotonicity once per entry, every
  signing key's `assertionMethod` membership is checked at it, and it becomes
  the head controller version for the next entry.

Kernel behavior leaned on: `verifyEntryProofs` is sequential per proof and
throws on the first failure (`assertions.ts:26-29`, `59-85`), so the pre-pass is
the only place with a whole-entry view before signatures are checked. Library
behavior leaned on: the parse-once map in `verifyEntryAgainstHead`
(`src/verify.ts:451-461`) already parses each `verificationMethod` exactly once;
the pre-pass fills it and `resolveVM` reads it. `checkEntryShape`
(`src/verify.ts:242-249`) already guarantees a non-empty proof array whose
`verificationMethod` members are strings.

## 3. Consumer enumeration

Method: grep `verifyEntryAgainstHead`, `headControllerVersionIndex`,
`controllerVersionIndex`, `admitAppend`, `coSignEntry`, and
`assertLadderAppendLicensed` over `src/` and `test/` of this repo, wallet-core,
and was-client.

In this repo:

- `src/verify.ts`: the only code change (section 5). `verifyResourceLog`,
  `verifyResourceLogAppend`, and every helper keep their signatures.
- `src/controller.ts`: the `admitAppend` input type gains `proofKeys`; the JSDoc
  for `controllerVersionId` (`:83`, today "the proof's entry controller
  versionId") and for `controllerVersionIndex` says "the entry's controller
  versionId"; the hook doc gains the order-insensitivity obligation (section 2,
  invariant 6).
- `src/seal.ts`: unchanged code. Its reads of `headControllerVersionIndex`
  (`seal.ts:148-149`, `163-164`) now mean what the module header already claims.
- `src/append.ts`, `src/entry.ts`, `src/testing.ts`: unchanged. `fakeController`
  attaches a caller's hook; the new tests record `proofKeys` through it.
- `test/node/resourceLog-admitAppend.test.ts`: every existing co-signed case
  builds both proofs against one controller view, so the proofs share a
  controller versionId and the cases keep passing. The case at `:292-330`
  ("hands the hook the head controller version of the entries before it") stays
  valid and needs no edit: it projects the input to three members before
  asserting (`:314-316`). The raw-input `toEqual` at `:67-81` fails at runtime
  on the extra member and gains `proofKeys`.
- `test/node/resourceLog-append.test.ts:739-768`: pushes the raw hook input and
  asserts `toEqual` against a five-member literal; gains `proofKeys`. The
  identical-input case at `:770-830` compares two inputs and is fine.
- `test/node/fixtures/log.ts` `coSignEntry` (`:100-128`): signs the added proof
  at the passed controller's last version. A divergent entry is built by handing
  the co-signer a shorter view. No fixture change needed.
- ARCHITECTURE.md: invariant 6 input list, new invariant 12 (section 5).

In wallet-core (in-house, same release train):

- `src/resourceLog/controller.ts:283-291` (`admitAppend`): forwards the hook
  input to the license; passes `proofKeys` through.
- `src/resourceLog/license.ts:60-100` (`assertLadderAppendLicensed`): gains the
  entry's signing keys and refuses with `ResourceLogLicenseError` when more than
  one of them is a ladder key. The one-shot becomes per entry rather than per
  proof; the version-unspent check (`:94-99`) is unchanged and now runs against
  an entry-level `controllerVersionIndex`. The hook gates on the calling key
  (`controller.ts:284-285`), so the refusal fires on the first ladder-key
  proof's call, whichever array position it holds; the drain stops at the first
  throw (`src/verify.ts:554-556`), so exactly one refusal lands. Policy strength
  is settled at at most one ladder-key proof per entry (section 8, question 2);
  a rotation co-signed by a member stays licensed.
- The "exactly two shapes" statements of the license go stale: the module header
  (`license.ts:4-16`), the predicate JSDoc (`:38-48`), wallet-core
  `ARCHITECTURE.md:560-569`, and the
  `test/node/resourceLog-license.test.ts:1-15` header all state the one-shot
  comparison as the whole refinement. Each gains the per-entry rule (section 5).
- `test/node/fixtures/resourceLog.ts:99-108`: the fixture's own `admitAppend`,
  mirroring `controller.ts:283-291`, calls `assertLadderAppendLicensed`
  directly. It must forward the new member, or every wallet-core suite built on
  the fixture runs a hook without the policy.
- `test/node/resourceLog-license.test.ts`: the existing hand-built input
  literals stop compiling once the input gains a required member and are
  rewritten: the `assertLadderAppendLicensed` calls at `:87-91`, `:105-108`,
  `:124-127`, `:132-135`, `:150-153`, `:164-167`, `:188-191` and the
  `controller.admitAppend` calls at `:690-696`, `:706-712`, `:721-728`. New
  cases are separate (section 7). No co-signed fixture exists in wallet-core
  (`grep "proof: \["` finds single-element arrays only,
  `test/node/fixtures/resourceLog.ts:192`, `recovery-remint.test.ts:159`); one
  is ported from this repo's `coSignEntry`.
- `resourceLog-seal`, `descriptors`, `keys-rosterLogStore`: single-proof entries
  throughout; no behavior change once the fixture forwards the member.
- WC-149 (draft: a License refusal as a soft class) interacts. The hook also
  runs on read, so the per-entry ladder refusal reaches readers as
  `ResourceLogLicenseError`; today that is a hard refusal, and if WC-149 softens
  the class on read it softens this refusal with it. VRL-4 lands independent of
  WC-149 and is recorded there as an interacting item.

Parties-table walk (encrypted-collections-spec AGENTS.md):

- was-client: zero references to `headControllerVersionIndex` or
  `controllerVersionIndex` in `src/` or `test/`; the log store adapter carries
  no controller-version bookkeeping. Dependency range bump only.
- encrypted-collections-spec: four passages carry the rule (section 8, decision
  3). `#log-proof` (`spec.md:1330-1339`) defines the controller versionId per
  proof and is where the same-controller-versionId and distinct-keys MUST
  belongs; `#log-authorization` (`:1345-1347`) defines "the entry's controller
  version" as the common value; `#log-verification` step 5 (`:1434-1437`) gains
  the reduction step before membership; `#log-append` states that a multi-proof
  entry's proofs are assembled by one writer and all carry that writer's
  verified head's controller version. The maintainer edits the spec.
- app-connect-spec: `decisions/0003-ladder-authority-clauses.md:99-106` states
  the license "in exactly two shapes" with the one-shot comparison as the whole
  refinement, and its revisit criterion 2 (`:201-206`) allows extension only as
  a new enumerated shape. The per-entry rule is a refinement inside shape 2, not
  a loosening; the record gains it (section 5), stating the settled at-most-one
  policy (section 8, question 2).
- freewallet: a direct consumer, not only a transitive one. It imports this
  library in `src/session/persistence.ts:20`, `annexReach.ts:32`,
  `rosterStore.ts:41`, `keyring.ts:114`, `verifiedLog.ts:38`, and
  `lib/sessionKey.ts:35` (pin `^0.3.0`), and depends on wallet-core as
  `link:../wallet-core`. The `link:` means wallet-core's checkout edits reach
  freewallet's build immediately, before 0.4.0 is on npm, so freewallet's
  install is broken from the wallet-core edit until its own range bump (the
  VRL-2 pattern). Named in `touches:`; release order in section 5.
- dcw: range bump when it next bumps wallet-core (a real npm range, `^0.45.0`).
- was-react, storage-core, was-teaching-server, was-conformance-suite:
  unaffected.

## 4. Interaction matrix

Rows are entry shapes the verifier meets (read path and pre-write pass alike);
columns are today and after. "Same" means outcome and class are identical.

| Situation                                                                                         | Today                                                                 | After                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Single-proof entry, member at its controller versionId                                            | passes                                                                | same; one `assertionKeysAt` call, as before                                                                                 |
| Co-signed, both proofs at one controller versionId, both members there                            | passes; hook per proof                                                | same; hook per proof with identical `controllerVersionIndex`, `proofKeys` both keys                                         |
| Co-signed, controller versionIds differ, each key a member at its own                             | passes; entry's controller versionId is the higher one                | Integrity ("proofs disagree on the entry's controller versionId"); hook never called                                        |
| Roadmap case: Alice removed at 5, Bob at 6, Alice at 4                                            | passes; `headControllerVersionIndex` 6; seal reports sealed           | Integrity (disagreement); `headControllerVersionIndex` not produced                                                         |
| Alice removed at 5, both proofs at 6                                                              | Alice's proof refused by membership at 6                              | same (membership at the entry's controller versionId); the right answer                                                     |
| Co-signed, second proof at a controller versionId behind the head controller version, first at it | Integrity (monotonicity, second proof)                                | Integrity (disagreement; the pre-pass checks presence, equality, known, monotone in that order)                             |
| Co-signed, both proofs at one controller versionId behind the head controller version             | Integrity (monotonicity, first proof)                                 | Integrity (monotonicity, once per entry); with two different controller versionIds the disagreement fires first             |
| Co-signed, both proofs at one unknown version                                                     | Integrity (unknown controller versionId)                              | same; with two different unknown versions the disagreement fires first                                                      |
| Duplicate proof (same signing key) inserted by the host                                           | both verify; both licensed (ladder) or pass (member)                  | Integrity from the pre-pass ("two proofs by one signing key"); hook never called                                            |
| Same co-signed entry with its proofs reversed                                                     | same verdict; hook calls in the new order                             | same verdict; hook inputs identical up to `proofKeys` order (hook must be order-insensitive)                                |
| Co-signed genesis (index 0)                                                                       | passes; controller versionId is the higher one; no hook               | pre-pass applies; divergent refused; on the create path a refused genesis against an existing log falls through to adoption |
| Durable log already carrying an entry with divergent controller versionIds (hand-built only)      | readable                                                              | refused from genesis; pin held; no in-library heal; a recreated resource is `scid-switch` until the pin slot is cleared     |
| Two ladder-key proofs at one inventory-changing version                                           | both pass the license (`headControllerVersionIndex` unspent for each) | `ResourceLogLicenseError` from the first ladder-key proof's hook call, whichever position; one refusal, order-independent   |
| One ladder-key proof plus one member proof                                                        | licensed                                                              | licensed (one ladder proof; at most one is the settled wallet-core policy, section 8, question 2)                           |
| Unversioned controller, co-signed entry carrying no controller versionId                          | passes; hook gets `controllerVersionIndex: null`                      | same                                                                                                                        |
| Unversioned controller, one proof carries a controller versionId                                  | Integrity (controller versionId on an unversioned controller)         | same, from the pre-pass                                                                                                     |
| Versioned controller, one proof carries no controller versionId                                   | Integrity (no controller versionId)                                   | same, from the pre-pass                                                                                                     |
| A proof under a different controller DID                                                          | Integrity                                                             | same, from the pre-pass                                                                                                     |
| Co-signed, second proof's signature forged, controller versionIds agree                           | Integrity from the kernel; hook never called                          | same                                                                                                                        |
| Co-signed, second proof's signature forged, controller versionIds differ                          | Integrity from the kernel (proof 1 verified first)                    | Integrity from the pre-pass (disagreement); same class, earlier                                                             |
| Co-signed, first proof's key not a member, second proof's signature forged                        | Integrity (membership, proof 1)                                       | Integrity (membership, proof 1; membership is still checked in array order inside `authorize`)                              |
| Pre-write pass over a co-signed candidate (`verifyResourceLogAppend`)                             | same rules as read                                                    | same rules as read; a divergent candidate is refused before the write                                                       |
| Sealing sweep convergence check (`seal.ts:163-164`)                                               | sound only for single-proof heads                                     | sound; code unchanged                                                                                                       |
| `assertionKeysAt` rejects                                                                         | wrapped as Integrity, once per proof                                  | wrapped as Integrity, once per entry (VRL-6 changes the wrap for both)                                                      |
| Error ordering within one entry                                                                   | proof 1's signature before proof 2's controller-versionId rules       | every proof's controller-versionId rules before any signature; same class, within-entry order only                          |
| Hook input `headControllerVersionIndex`                                                           | predecessors' head controller version                                 | same                                                                                                                        |

No library writer emits a multi-proof entry (`src/entry.ts:146` builds
`proof: [proof]`; `coSignEntry` lives in `test/node/fixtures/log.ts` only), so
the durable-log row covers hand-built logs alone.

Cost: one `assertionKeysAt` call per entry instead of one per proof, plus one
string comparison and one set insertion per proof. Nothing else changes.

## 5. Design

`src/verify.ts`, `verifyEntryAgainstHead` (the rest of the module is unchanged):

- Before the kernel call, a pre-pass over `entry.proof` parses every
  `verificationMethod` through the existing parse-once map and checks, per proof
  and in array order: the controller DID matches; under a versioned controller
  the controller versionId is present; under an unversioned one it is absent;
  and the `keyMultibase` has not appeared on an earlier proof of this entry
  (otherwise Integrity, "two proofs by one signing key"). Then, once per entry:
  every controller versionId equals the first proof's (otherwise Integrity,
  "proofs disagree on the entry's controller versionId"); the controller
  versionId is a known version (`versionIndexesOf`); its index is at or past
  `headVersionIndex`; and `controller.assertionKeysAt(controllerVersionId)` is
  resolved once into a set. The existing Integrity messages are kept for the
  checks that move; the pre-pass sits inside the same wrap the kernel call uses
  today, so a port rejection is still wrapped as Integrity. The pre-pass reads
  parsed DID URLs only and runs before any signature check; a duplicated or
  reordered array (section 1) is therefore refused or accepted on its key set,
  and the parse-once map (keyed on the `verificationMethod` string) stays a
  cache, not the source of `proofKeys`.
- The `authorize` closure keeps only two duties: the membership check of this
  proof's `keyMultibase` against the entry's set (the existing message), and the
  admission-input push for entries past genesis.
- `entryVersionIndex` is the pre-pass's index (`0` when unversioned); the
  `Math.max` goes. The return value and the loop in `verifyResourceLog` are
  unchanged.
- Hook input per proof: `ordinal` and `keyMultibase` as today;
  `controllerVersionId` and `controllerVersionIndex` are the entry's;
  `headControllerVersionIndex` stays the predecessors' head controller version;
  new `proofKeys: string[]`, every proof's signing-key multibase in array order,
  one element per proof, distinct by the pre-pass (the calling proof's key
  included, at its position). Every key in it belongs to a proof of this entry
  that verified and passed membership (section 2, invariant 6).

`src/controller.ts`: the `admitAppend` input type gains `proofKeys: string[]`;
JSDoc for `controllerVersionId` and `controllerVersionIndex` reads "the entry's
controller versionId" (as a `versionId`, and as an index into `versionIds`);
`proofKeys` is documented as the entry-level view a per-proof hook otherwise
lacks, distinct, verified, and to be read as a set: proof order is not
integrity-bound, so a hook must return the same verdict for any ordering.

Public-API names needing sign-off (not wire artifacts; nothing is stored or
sent): the hook-input member `proofKeys` (section 8, question 1). Error names:
none added. New Integrity messages: "Resource log entry N carries proofs that
disagree on the entry's controller versionId (all proofs of an entry must carry
the same controller version)." and "Resource log entry N carries two proofs by
one signing key."

Doc edits, this repo: ARCHITECTURE.md invariant 6 (the sentences at `:85-88`,
restated per entry as in section 2, plus the order-insensitivity obligation) and
new invariant 12, which goes into the invariants list; the Controller versionId
and Head controller version glossary entries gain the per-entry rule
(ARCHITECTURE.md already has a glossary); `src/verify.ts` module header, the
`verifyEntryAgainstHead` JSDoc, the parse-once comment at `:449-450` (the parse
now throws from the pre-pass, not from `authorize`), and the drain comment block
at `:546-553`; `src/controller.ts` JSDoc; `test/node/resourceLog-verify.test.ts`
and `resourceLog-admitAppend.test.ts` headers; CHANGELOG.md 0.4.0 `TBD`, labeled
breaking, absorbing the pending 0.3.1 entry unless the maintainer publishes
0.3.1 first: a log whose entry carries divergent controller versionIds or a
repeated signing key is now refused from genesis, its held pin stays, and there
is no in-library heal (only hand-built logs can carry that shape); membership is
checked at the entry's controller versionId; the hook input gains `proofKeys`,
so a consumer that constructs the input itself (a TypeScript hook test) must add
it, and a hook must be order-insensitive over it. ROADMAP VRL-4's acceptance
boxes are rewritten against this doc's sections.

Doc edits, other repos (in-house, in publish order: vh-resource-log 0.4.0 to
npm; then wallet-core's range bump, license and controller adoption, the fixture
hook, the rewritten license-test literals, and a co-signed test; then
was-client's and freewallet's range bumps; dcw when it next bumps wallet-core).
freewallet's `link:` on wallet-core means its build breaks at the wallet-core
edit and stays broken until its own bump, so the wallet-core and freewallet
steps are done back to back. The mixed-fleet window is empty for library-written
logs: every in-house writer emits single-proof entries, on which both rules
agree, and the pin stores no controller versionId, so no client state migrates.
wallet-core's "exactly two shapes" texts (`ARCHITECTURE.md:560-569`,
`license.ts:4-16`, `:38-48`, the license test header) gain the per-entry rule.
app-connect-spec `decisions/0003-ladder-authority-clauses.md:99-106` gains the
same sentence as a refinement inside shape 2 (its revisit criterion 2 forbids
loosening the one-shot; this tightens it). encrypted-collections-spec
`#log-proof`, `#log-authorization`, `#log-verification` step 5, and
`#log-append` gain the rule (section 8, decision 3). byoe-ecosystem
`LEARNINGS.md` gains a lesson under "Cross-repo invariants and gotchas": when a
rule is written per entry but checked per element, fix the reduction before the
check, and do it before the kernel's per-element loop, because that loop has no
lookahead; and an array outside the hash and the signatures is host-mutable in
order and multiplicity, so its consumers must be set-based.

## 6. Alternatives rejected

- Effective controller version = the maximum over the proofs, every key checked
  at that maximum. Closes the roadmap case. Rejected: it checks a key at a
  version the proof's own DID URL does not name, so dereferencing the
  `verificationMethod` as written can return a document that does not list the
  key; and it gives an entry with divergent controller versionIds a meaning the
  spec never gave it, where refusing costs nothing: the spec's append procedure
  is single-writer (`spec.md:1482-1495`, one writer builds the entry, its
  controller versionId, and its proof against its verified head,
  `spec.md:1389-1391`), so a co-signer has no defined assembly step and any
  multi-proof entry is assembled by one party at one time against one view.
  Do-not-reopen. Recorded in decisions/0002-one-controller-version-per-entry.md.
- Effective controller version = the minimum. Rejected outright: a removed
  member's low controller versionId would drag the head behind the seal.
- Advance the head controller version handed to later proofs of the same entry
  to the entry's controller versionId, so the one-shot license spends itself on
  the second ladder proof. Rejected: array-order dependent (a member proof ahead
  of a ladder proof would see the advanced head controller version and the
  ladder proof would be refused), and it encodes ladder policy in the library,
  against invariant 6. `proofKeys` hands the hook the whole-entry view instead.
- Call the hook once per entry with all proofs. Rejected: invariant 6's
  per-proof rule and its stated reason (a later-position proof must not be
  admitted by an earlier one's call).
- Two kernel passes (collect controller versionIds, then verify). Rejected:
  doubles signature verification; the pre-pass needs only the parsed DID URLs.
- Refuse any multi-proof entry. Rejected: the spec permits them
  (`spec.md:1327-1328`) and the admission-hook tests depend on them.

## 7. Test plan

New cases in `test/node/resourceLog-verify.test.ts` (the `makeLogClient` and
`coSignEntry` fixtures, with `fakeController` views of differing length to put
the co-signer's controller versionId elsewhere):

- Co-signed entry with divergent controller versionIds, each key a member at its
  own: refused as Integrity with the disagreement message; a recording hook is
  never called.
- The roadmap scenario (Alice removed at version 5, Bob carrying controller
  version 6, Alice carrying version 4): `verifyResourceLog` refuses, so no
  `headControllerVersionIndex` is produced.
- Co-signed entry at one controller versionId by two members: passes;
  `headControllerVersionIndex` equals that version's index.
- Co-signed entry at the removal version where one key is removed there: refused
  by the membership message.
- Divergent controller versionIds where the lower one is behind the head
  controller version: the disagreement message, not the monotonicity one.
- Both proofs at one controller versionId behind the head controller version:
  the monotonicity message.
- A proof duplicated in the array (same key, same `verificationMethod`): refused
  as Integrity with the duplicate-key message; a recording hook is never called.
- The same co-signed entry with its proofs reversed: the same verdict, and the
  recorded hook inputs are identical up to `proofKeys` order.
- Unversioned controller, co-signed entry carrying no controller versionId:
  passes.
- Versioned controller, one proof carrying a controller versionId and one
  carrying none: refused.
- Recording hook: `proofKeys` equals the proofs' keys in array order on every
  call, and `controllerVersionIndex` is the entry's controller versionId on
  every call.
- `assertionKeysAt` is called once for a co-signed entry.
- `verifyResourceLogAppend` with a divergent co-signed candidate: refused
  pre-write.

Existing suites that must stay green: `resourceLog-verify`,
`resourceLog-admitAppend` and `resourceLog-append` in full, each with its one
raw-input `toEqual` assertion (section 3) updated for `proofKeys`.

wallet-core (against this checkout, per the local-build recipe): the fixture
hook (`test/node/fixtures/resourceLog.ts:99-108`) forwards the new member and
the ten hand-built input literals in `resourceLog-license.test.ts` (section 3)
gain it, before any new case runs; then a co-signed fixture ported from
`coSignEntry`; two ladder keys signing one rotation entry at an
inventory-changing version, refused with `ResourceLogLicenseError` in both array
orders (one refusal each run, from the first ladder proof's call); a ladder
proof plus a member proof, licensed (at most one ladder proof, section 8,
question 2); `resourceLog-license`, `resourceLog-seal`, `descriptors`, and
`keys-rosterLogStore` stay green.

## 8. Decisions (resolved at approval)

1. Hook-input member name: `proofKeys`.
2. wallet-core policy strength: at most one ladder-key proof per entry. A
   rotation co-signed by a member stays licensed. Under app-connect-spec
   decision 0003's revisit criterion 2 this is a refinement inside shape 2 (the
   one-shot), not a new enumerated shape, so the record gains a sentence rather
   than a shape.
3. Spec text: all four passages named in section 3 are edited. `#log-proof`
   gains "All proofs of an entry MUST carry the same controller version and MUST
   be by distinct signing keys; a verifier MUST reject an entry whose proofs
   disagree or repeat a key"; `#log-authorization` defines the entry's
   controller version as that common value; `#log-verification` step 5 gains the
   reduction step before membership; `#log-append` states that a multi-proof
   entry's proofs are assembled by one writer and all carry that writer's
   verified head's controller version, which grounds the do-not-reopen rejection
   in section 6. The maintainer edits the spec; VRL-4's `touches:` entry tracks
   it.
4. Release: 0.4.0 labeled breaking, absorbing the pending 0.3.1 entry.
