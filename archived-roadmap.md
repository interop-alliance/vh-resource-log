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
