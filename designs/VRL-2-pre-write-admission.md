# VRL-2: Pre-write admission pass in `appendResourceLog` (design)

- item: VRL-2
- status: approved
- approved: 2026-08-22
- wire-level decisions contained: none (section 5 flags one public API name and
  one spec-text question, neither a wire artifact)
- decision records extracted: none (section 6's two do-not-reopen rejections
  fail the qualifying test: both are reversible, and invariant 11's wording plus
  the export's contract record the chosen shape)

Review pass run 2026-08-22 (six charters plus a completeness critic). Findings
are folded into the sections below; the points left for the maintainer are in
section 8 and were answered at approval (2026-08-22). The pass changed the
design in three places: the check now runs the reader's full per-entry
verification over the candidate entry rather than the authorization half alone,
including the terminal-entry rules and the closed-head refusal (section 5); the
create path falls through to lost-race adoption on an Integrity refusal (section
5); and the export's view precondition is checked in both directions (section
5).

## 1. Problem and scope

`appendResourceLog` builds the next entry and writes it straight away
(`src/append.ts:158-167`). `buildResourceLogEntry` anchors the proof at
`controller.versionIds[last]` unconditionally (`src/entry.ts:55`) and signs with
whatever key the signer holds. Nothing between the build and `store.append` asks
the question the reader will ask on read-back: does this entry verify as the
next entry of the log, with its signing key listed under `assertionMethod` at
that anchor and the controller's `admitAppend` hook admitting the proof. A
client whose key was removed at the controller's latest version, or the sealing
sweep it drives, therefore writes a durable entry, `confirmAppend`'s re-verify
refuses it, and every later reader refuses the log from genesis (invariant 2:
any failure rejects the whole log). An appended entry cannot be removed, so the
log is poisoned for good. The same mechanism, one member over, poisons the log
for a caller-supplied `versionTime` that is not RFC3339 `Z` form
(`src/entry.ts:218` forwards it unchecked; `src/verify.ts:154-163` refuses it)
or for a signer seam whose `keyMultibase` and `sign` disagree
(`src/entry.ts:32-35` couples nothing).

wallet-core already knows this. `rosterLogStore.replace`
(`wallet-core/src/keys/rosterLogStore.ts:246-264`) runs the ladder license
before its write with a comment naming the hazard, but it covers only the
license half (the hook's policy), not membership or any other reader check, and
only its own write path. It does not call `appendResourceLog` at all: it builds
with `buildResourceLogEntry` and writes with `log.append` itself, so a pre-check
placed inside `appendResourceLog` alone would not reach it.

The change: before `store.append`, the freshly built entry is verified as the
reader would verify it at its ordinal against the verified head (entry shape,
hash chain to the head, proof signatures through the kernel, the
external-authorization rule at the head's anchor floor, then the `admitAppend`
hook per proof with the same input the reader passes). A refusal throws the
class the read-back verify would have thrown, from the same code, and nothing is
written. Before `store.create`, the genesis is verified as a one-entry log. The
append check is one exported function, so wallet-core's direct write path calls
the same code instead of carrying its own copy.

What this protects and what it does not. It protects an honest writer running
this library from poisoning a log it can still read. It is not an authorization
boundary: a removed member whose controller view is stale still passes (its view
still lists it), which the spec's revocation window already allows
(`#log-trust-bounds`), and a writer that bypasses the library's write path is
not constrained at all. The check is additive to read-back (invariant 7), which
stays the only proof that the append is durable.

Not in scope: the anchor rule itself (VRL-4 changes how a multi-proof entry
reduces to one anchor and will edit the shared code this design extracts); the
classification of controller-port throws (VRL-6; the pass shares the read path's
wrap, so the two stay identical); the hook's input members and every error name
(no wire change); the sealing report (VRL-9); the empty-ETag guard (VRL-3);
whether a license refusal is a soft class in wallet-core (WC-149, section 3).

## 2. Invariant inventory

ARCHITECTURE.md invariants walked 1 through 10; 1 and 4 are untouched (no
read-path change, no pin-id change).

- 2, "the verifier recomputes everything; any failure rejects the whole log".
  Upheld and leaned on: it is what makes one refused entry poison the log, so
  the write path must refuse first. The read path is unchanged.
- 3, "the pin is established at first contact, advances only past a full
  verification". Upheld, by two deliberate choices on the create path (section
  5): the genesis pass runs with `pin: null`, because the candidate is not
  served history and continuity belongs to the read-back (passing the held pin
  would refuse every create by a client that already holds a pin, and the
  fallthrough would then adopt whatever the host serves, turning a rollback
  refusal into a silent adoption); and the fallthrough on a refused genesis
  against an existing log still reaches the lost-race branch, so the
  first-contact pin is written for a client that can read but not write.
- 5, "the controller view is resolved independently of the host". Upheld. The
  pass reads the `controller` object handed in; no new resolution, no served
  material. In `appendResourceLog` that is the same object the attempt's
  `readResourceLog` verified against. wallet-core's `replace` passes a
  re-resolved view (section 3); the precondition that makes that safe is stated
  on the export (section 5).
- 6, "the admission hook is where controller-domain append policy lives",
  ordering clause "after `assertionMethod` membership passes, after every proof
  of the entry has verified cryptographically, and before the anchor floor
  advances, for every entry past genesis". Ordering upheld: the pass runs the
  kernel's proof verification over the candidate entry and drains the hook after
  it, through the same extracted code the read loop uses, so the hook still
  never sees input from an unverified proof (the VRL-1 guarantee survives the
  new door). Contract extended: the hook is now also consulted on the writer's
  own candidate entry before the write, once per CAS attempt, including attempts
  that then lose the race and entries that are refused and never written, and a
  successful append consults it twice with identical input (pre-write and
  read-back). The hook must therefore be a side-effect- free function of the
  controller view and the input; a call is not evidence that an entry was or
  will be written. wallet-core's hook is such a function
  (`resourceLog/controller.ts:283-291`, `license.ts:60-99`). Doc edits: the
  sentences above, in ARCHITECTURE.md invariant 6 and the `controller.ts` JSDoc
  (section 5).
- 7, "an acknowledged append is a promise, not a fact". Upheld; read-back
  confirmation and re-verification are unchanged and remain the only evidence of
  durability. Invariant 7's text gains a clause naming 11 as additive, so a
  later reader of 11 does not take it as licence to drop `confirmAppend`.
- 8, "a stale CAS validator fails into the rebase loop". Upheld in this library.
  Touched in wallet-core: the adoption fallthrough on the create path
  (section 5) exists so that a refused genesis against an existing log still
  reaches the lost-race branch, and wallet-core's `create` must map that case to
  the descriptor port's conflict class (section 3), or the edv machinery's
  rebase loop (`was-client/src/edv/recipients.ts:1203-1214`) would see a
  fabrication class for a benign race, invariant 8's own stated failure mode.
- 9, "error names are contracts". No name or `reason` is added or changed. The
  meaning stated for `ResourceLogIntegrityError` in `src/errors.ts` ("a served
  log failed verification") widens: the class is now also thrown about the
  writer's own candidate entry, which was never served and may never be written,
  and its messages stay reader-phrased (the ordinal named is the candidate's
  would-be position). Doc edit in `errors.ts` (section 5). Consumers' predicates
  already receive this class from every write path (read-back verify), so no
  dispatch changes. `ResourceLogClosedError` gains one more throw site (the
  export, section 5) with the same name.
- 10, "sealing is computed from durable state alone; a torn sweep is finished by
  a naive re-run". Amended in who re-runs it. The convergence branch is
  untouched and runs before the pass: `buildState` returns `null` when the
  rebased head already anchors past the removal (`seal.ts:160-164`) and
  `appendResourceLog` returns before building (`append.ts:152-157`). A sweep
  that would actually write is now refused pre-write when the sweeping client is
  the removed member (or a ladder-key signer, section 4), permanently and by
  design; any surviving member's sweep finishes it. Doc edit: "finished by a
  naive re-run by any surviving member".
- New invariant 11, recorded in ARCHITECTURE.md (section 5): the write path
  refuses before the host does. Before `store.append` or `store.create`, the
  candidate entry is verified as the reader would verify it at its ordinal,
  against a controller view at or past the one the head was verified with, so an
  honest writer does not send an entry it would itself refuse on read-back. This
  is self-protection, not an authorization boundary, and it does not replace
  read-back (invariant 7).

Kernel behavior leaned on: `verifyEntryProofs` verifies every proof and throws
on the first failure (the VRL-1 guarantee, now in the kernel's JSDoc). The pass
calls it exactly as the read loop does. New here: the pass is the first
verification in this library that runs over the exact object `store.append` will
serialize, so it must not mutate the candidate. The kernel destructures rather
than mutates (`assertions.js:23, 47`) and this library's `authorize` /
`resolveVM` only read; the contract is stated on the export (section 5) so a
kernel change that normalized in place would be caught by the test in section 7
rather than by other readers.

Library behavior leaned on: `VerifiedResourceLog.headAnchorIndex` is the
verified head's effective anchor (`null` on an unversioned controller), which is
the `headAnchorIndex` the reader passes to the hook for the next entry and the
floor it checks anchor monotonicity against. Both are indexes into the
`versionIds` of the view the head was verified with; comparing them against
another view's `versionIds` is sound only when that list is a prefix of the new
one. A did:webvh controller log is append-only, so this holds for any resolver
that does not regress; it is stated as the export's precondition and as a
`versionIds` precondition on the port (distinct, append-only), since the
reader's first-index-wins map (`verify.ts:414-419`) and the builder's last-
element anchor (`entry.ts:55`) disagree on a repeated `versionId`.

## 3. Consumer enumeration

Method: grep `appendResourceLog`, `createResourceLog`, `sealResourceLog`,
`buildResourceLogEntry`, `buildResourceLogGenesis`, `admitAppend`,
`assertLadderAppendLicensed`, `headAnchorIndex`, and `confirmAppend` over `src/`
and `test/` of this repo, wallet-core, was-client, was-react, and freewallet,
and `app/` and `test/` of dcw. A symbol grep cannot see the two port-level
routes, so they were walked by hand: the descriptor-store port (`store.create` /
`store.replace` from was-client's `casUpdateDescriptor`,
`recipients.ts:1173-1240`, onto wallet-core's `logGovernedDescriptorStore`) and
the sealable-store seam (`store.seal()` from wallet-core's roster drivers).

In this repo:

- `src/verify.ts`: the per-entry body of the step 4+5 loop (parse-once,
  `authorize`, the kernel call with its wrap, the hook drain) and the chain-hash
  step for one entry are extracted into module-level functions the loop and the
  new export share (section 5). `verifyResourceLog`'s behavior is unchanged.
- `src/append.ts` `appendResourceLog`: gains the pass between
  `buildResourceLogEntry` and `store.append`, inside the CAS loop, so every
  attempt re-verifies against the rebased head. `createResourceLog`: gains a
  one-entry `verifyResourceLog` of the genesis before `store.create`, with the
  adoption fallthrough (section 5). `readResourceLog`: unchanged.
- `src/seal.ts` `sealResourceLog`: unchanged code; covered through
  `appendResourceLog`. Its `verified` hint cannot bypass the pass (the append
  path re-reads before building), and its convergence branch still returns
  before the pass runs.
- `src/entry.ts`: unchanged. The builders stay pure: wallet-core's tests use
  them deliberately to mint forged entries against an attacker's controller view
  (`keys-rosterLogStore.test.ts:195`), and a check inside the builder would
  break that and couple construction to the controller port.
- `src/controller.ts`: JSDoc only (hook contract, `versionIds` precondition).
- `src/errors.ts`: JSDoc only (section 2, invariant 9).
- `src/index.ts`: exports the new function; header lists the pass.
- `src/testing.ts`: unchanged. `fakeController` attaches a caller's hook, which
  the new tests use to record pre-write calls.
- `test/node/resourceLog-append.test.ts`: the honest-path cases see one more
  kernel verification, one more `assertionKeysAt` call and, with a hook, one
  more hook call per append; no existing assertion counts them. Header and new
  cases in section 7.
- `test/node/resourceLog-admitAppend.test.ts`: read-path only; its header's
  library-wide claim ("the hook runs after the entry's proofs have verified")
  stays true and gains the write-path clause.

In wallet-core:

- `src/keys/rosterLogStore.ts:246-264` (`replace`): today runs `inventoryAt()`
  plus `assertLadderAppendLicensed` before `log.append`. It adopts the export
  with `head: lastVerified` and the re-resolved `controller`; the inline block
  goes. Two resolutions are mixed here (`read()` set `lastVerified` under one
  `currentController()` call, `replace` makes another); safe under the export's
  precondition because `currentController()` (`:171-184`) only ever returns a
  view at or past the controller floor and the account log is append-only.
  Behavior change: a replace by a signer removed at the controller head is
  refused as `ResourceLogIntegrityError` before the write, where today it is
  written and then refused on `settle`; a license refusal keeps its class and
  lands at the same point.
- `src/keys/rosterLogStore.ts:283-297` (`create`): runs the genesis through
  `verifyResourceLog` as a one-entry log before `log.create`. On a refusal it
  reads; if a log is served it throws the descriptor port's conflict class (the
  lost-race translation already in place), so the edv machinery re-reads and
  adopts the winner; if nothing is served the refusal propagates.
- `src/keys/rosterLogStore.ts:310` (`seal`): covered through `sealResourceLog`
  with no code change.
- The `.seal()` drivers, where a refused sweep lands:
  `clients/rosterPolicy.ts:308-317` rethrows Integrity through `isRosterRefusal`
  (a removed member's login-time converge throws, as it does today from
  read-back) and warns on a license class;
  `keys/userKeyRosterCascade.ts:218-224` reports `{ outcome: 'failed' }`;
  `keys/userKeyCascade.ts:207-209` has no catch. Classes unchanged; timing
  earlier; nothing poisoned.
- `src/resourceLog/controller.ts:283` (`admitAppend`): unchanged; a pure read of
  the view, now called one extra time per write attempt.
- `src/resourceLog/license.ts`: unchanged.
- WC-149 (license refusals as a soft class, draft, discovered-from VRL-1):
  interacts. With the pass, a license-refused sweep by a ladder-key signer warns
  and continues unsealed at `rosterPolicy.ts:313-318`, where today the refusal
  follows a poisoning write. VRL-2 removes the accidental durable signal WC-149
  reasons about; the `touches:` entry names it.
- Tests: `test/node/resourceLog-license.test.ts:429-440` asserts the
  unchanged-document refusal writes nothing; it keeps passing with the check
  moved into the library call. `descriptors.test.ts` drives `appendResourceLog`
  and `createResourceLog` through wallet-core's extended `fakeController`, which
  always attaches `admitAppend` (`test/node/fixtures/resourceLog.ts:99-107`);
  safe because no `ladderKeys` are supplied, so the hook short-circuits.
  `resourceLog-seal.test.ts` and `keys-rosterLogStore.test.ts` use member
  signers and see no class change.
- `ARCHITECTURE.md:574-587`: two passages go false. "Enforced twice from one
  predicate ... and as a pre-append check in the log-governed store's `replace`"
  becomes "enforced through the hook, which the library consults pre-write and
  on read-back"; "which is also why the extension stays on the store types --
  the pre-append check reads it directly" loses its reason (the store types stay
  on `WebvhResourceLogController` because the resolver returns it and the hook
  lives on it; the sentence says that instead).

Parties-table walk (encrypted-collections-spec AGENTS.md):

- was-client: affected through the descriptor-store port, not through any
  symbol. `casUpdateDescriptor` (`src/edv/recipients.ts:1173-1240`) drives
  `rosterLogStore.create` / `replace`; its catch matches only
  `PreconditionFailedError`. After the change a refused roster write surfaces as
  "nothing written, then error" instead of "written, then error", which makes a
  retried `initRecipients` / `addRecipient` idempotent where today it finds a
  poisoned log; the create refusal against an existing log is mapped to the
  conflict class by wallet-core (above) so the loop still rebases. No was-client
  code change; dependency range bump only.
- encrypted-collections-spec: the spec's `#log-append` MUST list
  (`spec.md:1478-1493`) has no pre-write verification step, and
  `#log-authorization` requires a writer to anchor at its verified head, so a
  second implementation written to the published text poisons logs exactly as
  described in section 1. Whether the spec gains a step, and at what strength,
  is the co-editor's call (section 8).
- freewallet: no verifier or write call. It pins `@interop/vh-resource-log`
  `^0.2.0` directly (pin-store types and `memoryResourceLogPinStore` only) and
  `wallet-core` as `link:../wallet-core`, so a wallet-core range bump to
  `^0.3.0` resolves two copies of this library in freewallet's tree (plain data
  crosses the seam; benign, but the two-copies condition of invariants 8/9) and
  breaks freewallet's install until 0.3.0 is on npm. Needs its own range bump,
  in order.
- dcw: no direct dependency; pins wallet-core `^0.45.0` against a current
  `0.51.0`, so it observes nothing until it bumps wallet-core.
- was-react, storage-core, was-teaching-server, was-conformance-suite:
  `unaffected` (no verifier, builder, or write call; no log error dispatch).

## 4. Interaction matrix

Rows are write-path situations; columns are today and after. "Same" means the
outcome and class are identical.

| Situation                                                                   | Today                                                                                                     | After                                                                                                 |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Honest append, signer listed at the head, no hook                           | written, confirmed                                                                                        | same; one extra hash, signature verification, and `assertionKeysAt` call                              |
| Honest append, hook admits                                                  | written, confirmed; hook runs on read-back                                                                | same; hook runs once pre-write and once on read-back, identical input                                 |
| Signer removed at the controller head (the defect)                          | written; `confirmAppend` verify throws Integrity; log poisoned                                            | Integrity before `store.append`; nothing written                                                      |
| Signer not listed at any version (wrong signer passed)                      | written; Integrity on read-back; poisoned                                                                 | Integrity before the write                                                                            |
| Signer seam whose `keyMultibase` and `sign` disagree                        | written; Integrity on read-back (signature); poisoned                                                     | Integrity before the write (the kernel verifies the candidate's signature)                            |
| Caller `versionTime` without the `Z` suffix                                 | written; Integrity on read-back (shape); poisoned                                                         | Integrity before the write (shape check on the candidate)                                             |
| Hook refuses (unlicensed ladder-signed append)                              | written; hook's class on read-back; poisoned                                                              | hook's class before the write; nothing written                                                        |
| Hook throws a bug (`TypeError`)                                             | written; raw `TypeError` on read-back                                                                     | raw `TypeError` before the write; nothing written                                                     |
| `assertionKeysAt` rejects                                                   | written; wrapped as Integrity on read-back                                                                | wrapped as Integrity pre-write, same code (VRL-6 changes both at once)                                |
| CAS conflict, retry, rebased head has a higher floor, non-ladder signer     | attempt 2 writes against the new head                                                                     | attempt 2 re-verifies with the new `headAnchorIndex`, then writes                                     |
| CAS conflict, retry, ladder signer, the winner anchored at the same version | attempt 2 writes; license refuses on read-back (one-shot spent); poisoned                                 | license class out of attempt 2 before the write; `lastConflict` is dropped (the refusal is the cause) |
| `buildState` returns `null` (converged)                                     | nothing built or written                                                                                  | same; the pass does not run                                                                           |
| Closed log / missing validator                                              | refused before build                                                                                      | same                                                                                                  |
| Sealing sweep driven by a removed member, log unsealed                      | sealing entry written; Integrity on read-back; poisoned                                                   | Integrity out of `sealResourceLog`; nothing written; a surviving member's sweep seals                 |
| Sealing sweep driven by a ladder-key signer                                 | written; license refuses on read-back (a verbatim re-append changes no inventory); poisoned               | license class pre-write; wallet-core warns and continues unsealed (WC-149)                            |
| Sealing sweep, surviving member, hook admits                                | written, `sealed: true`                                                                                   | same                                                                                                  |
| Sealing sweep, convergence branch (`buildState` null)                       | nothing written                                                                                           | same; the pass does not run, so a removed member's re-run still converges silently                    |
| Sealing sweep with a stale `verified` hint                                  | append path re-reads, builds, writes                                                                      | append path re-reads, builds, verifies the candidate against the fresh head, writes                   |
| Genesis create by a non-member, no log exists                               | created; Integrity on read-back; an unusable log exists                                                   | Integrity before `store.create`; no log                                                               |
| Genesis create by a non-member, a log already exists (lost race)            | conflict; winner's log verified and pinned; `created: false`                                              | pass refuses; fallthrough reads; winner's log verified and pinned; `created: false`                   |
| Genesis create, hook present                                                | hook exempt on read-back                                                                                  | hook exempt pre-write too (genesis is index 0 of the one-entry verify)                                |
| Lost create race, member signer                                             | winner's log verified and pinned                                                                          | same                                                                                                  |
| Unversioned controller                                                      | anchorless proof, membership at the current document, hook gets `anchorIndex: null`, `headAnchorIndex: 0` | same rules pre-write                                                                                  |
| Head verified under an unversioned view, `controller` now versioned         | written; read-back refuses the old anchorless entries; poisoned                                           | refused pre-write by the explicit view-flip check (section 5)                                         |
| `head` behind the true head (caller-supplied stale head, wallet-core)       | n/a (no pass)                                                                                             | pass admits or refuses on a stale floor; read-back decides; best effort, stated on the export         |
| Versioned controller, anchorless entry (caller-built)                       | written; Integrity on read-back                                                                           | Integrity pre-write                                                                                   |
| Caller-built entry anchored behind the head's floor                         | written; Integrity on read-back                                                                           | Integrity pre-write                                                                                   |
| Caller-built entry whose `versionId` ordinal is not head + 1                | written; Integrity on read-back                                                                           | Integrity pre-write (shape check at the head-derived index)                                           |
| Caller-built entry with `proof: []`                                         | written; Integrity on read-back                                                                           | Integrity pre-write; hook never called                                                                |
| Caller-built terminal entry whose `state` differs from the head's           | written; Integrity on read-back (step 6); poisoned                                                        | Integrity pre-write (the pass runs the terminal rules)                                                |
| Caller-built terminal entry, state equal to the head's                      | written; verified as the closing entry                                                                    | same; the pass admits it                                                                              |
| Export called with a closed `head` (consumer bypassing `appendResourceLog`) | n/a (no pass); read-back refuses "continues past a terminal entry"; poisoned                              | `ResourceLogClosedError` from the export, the class the append path throws                            |
| Head verified under a versioned view, `controller` now unversioned          | written; read-back refuses the old anchored entries; poisoned                                             | refused pre-write by the view-flip check (both directions)                                            |
| Create path, the pass throws a non-Integrity error (port bug)               | n/a                                                                                                       | propagates; no read, no adoption (the fallthrough is Integrity-only)                                  |
| Multi-proof entry, second proof forged (caller co-signed)                   | written; Integrity on read-back                                                                           | Integrity pre-write; hook never called for any proof                                                  |
| Multi-proof entry, both valid                                               | written; each proof authorized and admitted on read-back                                                  | each proof verified, authorized, and admitted pre-write in array order                                |
| Stale controller view (this signer removed after the view was resolved)     | written; read-back passes against the stale view; other readers refuse until the sealing append           | same; residual by design (invariant 5; the spec's revocation window)                                  |
| Pin                                                                         | advanced on every verify                                                                                  | same; the pass touches no pin                                                                         |

Cost: one `deriveHash`, one kernel proof verification per proof, one
`assertionKeysAt` call and, with a hook, one hook call per proof per attempt.
Negligible next to the full read-and-verify every attempt already does.

## 5. Design

`src/verify.ts`:

- Extract from the step 3 loop a function
  `checkEntryChain({ entry, index, predecessorVersionId })` (one `deriveHash`,
  the `buildVersionId` comparison, the existing Integrity throw) and use it in
  the loop.
- Extract the body of the step 4+5 loop into
  `verifyEntryAgainstFloor({ entry, index, controller, anchorFloor, anchorIndexes, versioned })`
  returning the entry's effective anchor index. It holds everything the loop
  body holds today: the parse-once map, the `authorize` closure (controller DID,
  anchor rules, membership, admission-input push), the `verifyEntryProofs` call
  with its Integrity wrap, and the hook drain. The `anchorIndexes` map
  construction moves into a helper both callers use.
- `verifyResourceLog` keeps its phase structure (shape all, genesis, chain all,
  then the per-entry loop) so the order in which failures surface across entries
  is unchanged; the loop body becomes one call.
- New exported function:

  ```ts
  export async function verifyResourceLogAppend({
    entry,
    controller,
    head
  }: {
    entry: ResourceLogEntry
    controller: ResourceLogController
    head: VerifiedResourceLog
  }): Promise<void>
  ```

  Verifies `entry` as the reader would verify it as the next entry of `head`, in
  this order: `head.terminal !== null` throws `ResourceLogClosedError` (the
  class `appendResourceLog` already throws before building); the view
  precondition, checked in both directions (`head.headAnchorIndex === null` with
  a versioned `controller`, or a number with an unversioned one, is refused as
  Integrity, because the head's earlier entries would fail the anchor-presence
  rule on read-back); `checkEntryShape(entry, head.entries.length)` (which
  refuses a wrong ordinal, a bad `versionTime`, non-empty parameters other than
  a terminal `nextLog`, and an empty proof array); `checkEntryChain` against
  `head.head.versionId`; `verifyEntryAgainstFloor` with
  `anchorFloor = head.headAnchorIndex ?? 0` and `index = head.entries.length`
  (so the hook applies, as for every entry past genesis); and, for a terminal
  candidate, the step 6 rule that its `state` canonicalizes equal to
  `head.head.state` (extracted into a helper the read loop shares). Throws
  exactly what the read path throws, from the same code: Integrity for shape,
  chain, signature, authorization, terminal-state, and wrapped controller-port
  failures; the hook's own class for an admission refusal. The JSDoc states the
  contract and the preconditions: `head` is the value `readResourceLog` /
  `verifyResourceLog` returned for the log the CAS validator came from (its
  `entries`, `head`, `headAnchorIndex`, and `terminal` are read as one
  consistent record; a caller-built literal is out of contract), verified
  against a controller view whose `versionIds` is a prefix of
  `controller.versionIds` (an append-only controller log and a resolver that
  does not regress); a staler `head` weakens the pass to best effort in both
  directions and read-back decides. The pass does not mutate `entry` (the object
  is what the store will serialize). The hook obligation (section 2,
  invariant 6) is restated on the port.

`src/append.ts`:

- `appendResourceLog`: after `buildResourceLogEntry`, before the `try` around
  `store.append`:
  `await verifyResourceLogAppend({ entry, controller, head: verified })`. A
  refusal propagates as is; `lastConflict` from an earlier attempt is not
  attached (the refusal is its own cause). The JSDoc names the classes the call
  can throw pre-write (Integrity, the hook's class) beside
  `ResourceLogClosedError`.
- `createResourceLog`: after `buildResourceLogGenesis`, before `store.create`:
  `verifyResourceLog({ entries: [genesis], controller, expectedMethod: method, pin: null })`
  inside a `try`. `pin: null` is deliberate (section 2, invariant 3): the
  candidate is not served history. `expectedMethod: method` and the SCID
  recomputation are self-consistent by construction; the pass's real work on a
  genesis is the shape check and the membership and anchor rules. On a
  `ResourceLogIntegrityError` (matched by name, the cross-package rule), and
  only that class, `store.read()`; if a log is served, take the existing
  lost-race branch (`created = false`, verify, pin, return); if `null`, rethrow
  the refusal. Any other throw propagates with no read, so a port bug cannot
  turn "create my genesis" into "adopt whatever the host serves". The hook is
  exempt on genesis, so no hook class can reach this catch. This keeps the
  adopt-the-winner contract and invariant 3's first-contact pin for a client
  that can read but not write.
- Module header and both JSDocs gain the pre-write sentence.

`src/controller.ts` (JSDoc only): the `admitAppend` contract gains the
write-path clauses (also consulted on the writer's own candidate entry before
the write, after its proofs verify; called on entries that are never written and
twice for a successful append; must be a side-effect-free function of the view
and the input). `versionIds` gains its precondition (distinct, append-only
across resolutions).

`src/errors.ts` (JSDoc only): the taxonomy header's first bullet and the
`ResourceLogIntegrityError` class doc say the class is also thrown about the
writer's own candidate entry that failed the pre-write verification, with
reader-phrased messages whose ordinal is the candidate's would-be position; the
`ResourceLogClosedError` doc names the export as a second throw site.
`VerifiedResourceLog`'s JSDoc notes it is now also an input (to the export) and
must be passed as returned.

`src/index.ts`: export `verifyResourceLogAppend` in the `verify.js` group; the
header lists the pre-write pass in the append-path clause. Adding a required
field to `VerifiedResourceLog` is henceforth a breaking change for any consumer
that constructs one (none does today); the CHANGELOG entry says so.

`src/seal.ts`, `src/entry.ts`, `src/testing.ts`: unchanged code. `seal.ts`'s
header sentence "a torn sweep is finished by a naive re-run" gains "by any
surviving member".

Doc edits, this repo: ARCHITECTURE.md invariant 6 (hook contract clauses),
invariant 7 (clause naming 11 as additive), invariant 10 (healing party), new
invariant 11 (section 2 wording), the layer-map lines for `src/verify.ts` and
`src/append.ts` ("verify-build-verify-CAS-rebase-confirm"), a new ownership
heuristic ("the pre-write verification of a candidate entry, closed-head refusal
included: `verifyResourceLogAppend`; a consumer with its own write path calls it
rather than re-deriving any reader rule");
`test/node/resourceLog-append.test.ts` and `resourceLog-admitAppend.test.ts`
headers; CHANGELOG.md 0.3.0 `TBD` (section "Release"); ROADMAP VRL-2's
`touches:` and acceptance boxes (the review added entries for
encrypted-collections-spec, was-client, freewallet, dcw, and WC-149, and boxes
for the create fallthrough and the wallet-core adoption).

Doc edits, other repos (in-house, in publish order: vh-resource-log 0.3.0 to
npm; then wallet-core's range bump, `replace` / `create` adoption, and the two
ARCHITECTURE.md passages; then freewallet's and was-client's range bumps; dcw
when it next bumps wallet-core). byoe-ecosystem `LEARNINGS.md` gains a lesson
under "Cross-repo invariants and gotchas": on an append-only log where one
refused entry poisons every reader, the writer must run the reader's full
per-entry check before the write, and a consumer with its own write path must
call the same exported check rather than a subset of it.

Release: 0.3.0, labeled breaking, in the 0.2.0 entry's style: no name changes,
but the hook contract gains an obligation (side-effect-free; called on entries
never written), refusals move from after the write to before it on every write
path, and a consumer with its own write path (wallet-core) must adopt the export
to be covered. The breaking-release doc-vs-code audit runs over the parties
table (the walk is in section 3). Consumers on `^0.2.0` need a range bump.

Wire-level decisions: none. No field, encoding, or error name is added; the
hook's input object is unchanged. The export name and the spec text were decided
at approval (section 8).

## 6. Alternatives rejected

- Run only the authorization half pre-write (membership plus hook, no shape,
  chain, or signature check), the first draft of this design. Rejected by the
  review pass: it leaves the same poisoning open one member over (a caller
  `versionTime`, a signer seam mismatch, an empty or forged co-signed proof
  array), and through the public export it hands the hook unverified proof
  metadata, the VRL-1 shape through a new door. The cost it saved is one hash
  and one signature verification per attempt. Do-not-reopen.
- Put the check inside `buildResourceLogEntry` / `buildResourceLogGenesis`.
  Covers every writer with no new export. Rejected: the builders take a
  `ResourceLogEntry` head, not a verified one, so the floor would become a new
  parameter; the builders are what wallet-core's tests use to mint forged
  entries against an attacker's view; and it couples construction to the
  controller port's async calls and the hook. Do-not-reopen unless the builders'
  signature changes for another reason.
- Run the full `verifyResourceLog` over `[...verified.entries, entry]` before
  the write. Rejected: it re-hashes and re-verifies every entry's signature per
  attempt, doubling the append's cost for a check whose only new information is
  the candidate entry's. (For the genesis it is the design: a one-entry log is
  the candidate.)
- Check the inputs before signing, saving one signature on refusal. Rejected: it
  checks what the builder was told, not what the proof carries, so a signer seam
  mismatch and a forged co-signature pass; the reader's checks need the signed
  entry.
- Place the create-path pass after a successful `store.create`. Rejected: it
  forfeits the "no log" outcome for a non-member creator; the adoption
  fallthrough keeps both.
- Make wallet-core's `replace` call `appendResourceLog` and drop its direct
  write path. Out of this item's scope (the roster store's CAS contract is the
  descriptor-store port's `PreconditionFailedError`, translated at its
  boundary); the export gives it the same check without the rewrite.
- Leave create out (the roadmap's acceptance boxes name append and seal).
  Rejected: a genesis by a non-member creates a log no reader accepts, the same
  poisoning shape one ordinal earlier; with the adoption fallthrough the
  lost-race contract is kept.
- Re-resolve the controller inside the pass to close the stale-view residual.
  Rejected outright: invariant 5 forbids the verifier reaching for controller
  material, and the profile anchors a write at the writer's verified head by
  design.

## 7. Test plan

New cases in `test/node/resourceLog-append.test.ts` (the `makeWriter` fixture
plus a two-version controller whose second version drops the signer, and a
recording store wrapper that logs `append` / `create` calls):

- Append by a signer removed at the controller head: rejects with
  `ResourceLogIntegrityError`, the store's entries are unchanged, and the
  message is the reader's membership refusal (the primary acceptance case).
- Append with a hook that refuses: rejects with the hook's class, nothing
  written, and the hook's recorded input equals the reader's for that entry
  (`ordinal`, `keyMultibase`, `anchor`, `anchorIndex`, `headAnchorIndex`).
- Honest append with a recording hook and the recording store: the hook call
  precedes `store.append`, and the hook is called once pre-write and once on
  read-back for the new entry.
- Append with `versionTime: '2026-08-22T00:00:00+00:00'`: Integrity pre-write,
  nothing written.
- CAS conflict whose concurrent writer's entry anchors at a higher version: the
  second attempt's pre-write hook input carries the rebased `headAnchorIndex`.
- `createResourceLog` by a non-member, no log: rejects with Integrity and the
  store still reads `null`.
- `createResourceLog` by a non-member against an existing log: resolves with
  `created: false`, the winner's log verified, the pin written, nothing created
  (the adoption fallthrough).
- `createResourceLog` with a recording hook: the hook is not called pre-write
  for the genesis.
- `sealResourceLog` driven by the removed member on an unsealed log: rejects
  with Integrity and the log is unchanged; then the surviving member's sweep
  seals it (the first `sealResourceLog` cases in this repo; VRL-10 moves the
  rest).
- `createResourceLog` whose controller's `assertionKeysAt` throws a plain
  `Error` against an existing log: the error propagates, nothing is adopted, no
  pin is written (the fallthrough is Integrity-only).
- `verifyResourceLogAppend` directly: a co-signed entry (`coSignEntry`) with the
  second proof's `proofValue` replaced by garbage is refused as Integrity with a
  recording hook never called; `proof: []` is refused with the hook never
  called; a caller-built entry anchored behind the head's floor is refused; an
  entry whose ordinal is not head + 1 is refused; a head verified under an
  unversioned controller passed with a versioned controller is refused, and the
  mirror case too; a closed head is refused with `ResourceLogClosedError`; a
  terminal entry (`buildTerminalEntry`) with the head's state passes and one
  with a changed state is refused as Integrity; an unversioned controller with
  an anchorless entry passes; a valid co-signed entry is admitted proof by proof
  in array order; the candidate is byte-identical (JCS) before and after the
  pass.

Existing suites that must stay green: `resourceLog-append`,
`resourceLog-admitAppend`, and `resourceLog-verify` in full; wallet-core's
`resourceLog-license`, `resourceLog-seal`, `descriptors`, and
`keys-rosterLogStore` suites run against this checkout, before and after its
`replace` / `create` adopt the export. wallet-core's adoption adds one case in
`resourceLog-license.test.ts`: a replace by a signer removed at the head is
refused as Integrity with nothing written, and one in `descriptors.test.ts`:
`initRecipients` against a log-governed store whose log already exists, with a
non-member signer, adopts the existing descriptor.

## 8. Open questions

None open. Answered by the maintainer at approval, 2026-08-22:

1. Export name: `verifyResourceLogAppend`.
2. Spec text: encrypted-collections-spec `#log-append` gains a writer SHOULD
   between step 2 and the write ("verify the built entry as a reader would
   before writing it"), with the poisoning rationale in a note; read-back stays
   the MUST. The maintainer edits the spec; VRL-2's `touches:` entry for the
   spec tracks it.
3. Release label: 0.3.0, labeled breaking, in the 0.2.0 entry's style; the
   parties-table audit runs before publish.

Resolved by the review pass: wallet-core's `replace` and `create` adopt the
export in the same release train (the roster log is the write path the item's
narrative cites; leaving it on the inline license check would close VRL-2 with
the named hazard open). Recorded as an acceptance box on VRL-2. The adoption
touches `logGovernedDescriptorStore`'s `lastVerified` / `controllerFloor` /
`currentController()` lifecycle against was-client's `casUpdateDescriptor` loop;
the completeness critic asked for a ceremony-reviewer pass over that file and
its drivers when the wallet-core change is made, which is recorded in VRL-2's
wallet-core `touches:` entry.
