# 0002: An entry carries one controller versionId, by distinct signing keys

- Status: accepted
- Date: 2026-08-22
- Driving work: closing a verifier defect where a multi-proof entry's proofs
  were each checked at their own controller version against the predecessors'
  head, letting a removed member's proof ride on a co-signer's controller
  version.
- Affects: vh-resource-log (`src/verify.ts`, the admission-hook input);
  encrypted-collections-spec (`#log-proof`, `#log-authorization`,
  `#log-verification`, `#log-append`); wallet-core
  (`src/resourceLog/license.ts`); app-connect-spec
  (`decisions/0003-ladder-authority-clauses.md`)

## Context

The spec writes the controller-version rule per entry ("the entry's controller
version"), but defines the controller versionId per proof (the `versionId` DID
parameter on a proof's `verificationMethod`), and never states how a multi-proof
entry's per-proof versionIds reduce to one entry value. The kernel that verifies
each proof's signature loops over the proof array in order and throws on the
first failure; a call for one proof has no lookahead into the next, so any
reduction has to be computed before the kernel runs, from the parsed
`verificationMethod` strings alone.

The proof array is not integrity-bound. The hash input omits `proof`, and each
proof signs the entry minus the array plus its own options, so a host can
duplicate or reorder proofs without touching a `versionId`, the pin, or any
signature. A reduction rule that trusts array position or count is therefore
something a host can manipulate.

The spec's append procedure is single-writer: one party builds an entry, its
controller versionId, and its proof against its own verified head. Nothing in
the spec defines a co-signing procedure in which two parties assemble one entry
against two different verified heads.

## Decision

An entry carries one controller versionId, by distinct signing keys. Every proof
of an entry must carry the same controller versionId (or none, under an
unversioned controller); proofs that disagree refuse the log, and so does a
signing key that appears twice in one entry's proof array. That one controller
versionId is checked for presence and monotonicity once per entry, every signing
key is checked for `assertionMethod` membership at it, and it becomes the head
controller version for the next entry.

The canonical statement of this rule is the spec text in
encrypted-collections-spec's `#log-proof`, `#log-authorization`,
`#log-verification`, and `#log-append`. This record holds the rejection of the
alternative reductions; it does not restate the rule.

The admission hook's input carries the entry's controller versionId (not each
proof's own) for every proof, plus a new `proofKeys` member: every proof's
signing-key multibase, in array order, one per proof, distinct. wallet-core's
ladder license admits at most one ladder-key proof per entry; a rotation
co-signed by a member stays licensed.

## Rejected Alternatives

- **Maximum over the proofs.** Effective controller version is the highest
  versionId among the entry's proofs; every key is checked for membership at
  that maximum. Closes the removed-member scenario but checks a key at a version
  its own `verificationMethod` URL does not name, so dereferencing the URL as
  written can return a document that does not list the key. It also gives an
  entry with divergent controller versionIds a meaning the spec never gave it,
  at no benefit: since the spec's append procedure is single-writer, any
  multi-proof entry is assembled by one party at one time against one verified
  view, so a co-signer has no defined assembly step and divergence is not a
  shape the spec anticipates. Refusing it costs nothing. Do-not-reopen: see
  Revisit Criteria.
- **Minimum over the proofs.** Rejected outright: a removed member's low
  controller versionId would drag the head controller version behind the seal.
- **Advance the head controller version within one entry**, so a later proof of
  the same entry is checked against the earlier proof's controller versionId,
  and a one-shot ladder license spends itself on the second ladder proof.
  Rejected: array-order dependent (a member proof ahead of a ladder proof would
  see the advanced head controller version, and the ladder proof would then be
  refused on version grounds instead of on policy), and it puts ladder policy
  inside the library. `proofKeys` gives the hook the whole-entry view instead.
- **One hook call per entry**, all proofs at once. Rejected: the library's
  existing per-proof hook contract requires that a later-position proof not be
  admitted by an earlier one's call.
- **Two kernel passes**, one to collect controller versionIds and one to verify
  signatures. Rejected: it doubles signature verification. The reduction only
  needs the parsed `verificationMethod` strings, available before any signature
  check.
- **Refuse any multi-proof entry outright.** Rejected: the spec permits
  multi-proof entries, and the admission-hook contract is written and tested
  against them.

## Consequences

- A durable log that already carries an entry with divergent controller
  versionIds (only buildable by hand; no library writer emits multi-proof
  entries) is refused from genesis, and the pin stays held at whatever it read
  before. There is no in-library heal for that shape.
- The admission hook must be order-insensitive over `proofKeys`: proof order is
  not integrity-bound, so a hook that returns a different verdict for a
  reordered but otherwise identical `proofKeys` set is itself a bug.
- The verifier makes one `assertionKeysAt` call per entry instead of one per
  proof.
- The library still carries no ladder policy; `proofKeys` only gives a
  controller-domain hook the entry-level view it needs to apply one.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. The spec gains a defined multi-party assembly step for one entry, in which
   co-signers assemble proofs against different verified heads. If that lands,
   the reduction must be redesigned as a spec change, not by reinstating the
   maximum-over-proofs rule in the verifier.
2. The profile makes the proof array integrity-bound (hashed or signed as a
   whole). That would let order-dependent hook semantics be reconsidered, since
   a host could no longer duplicate or reorder proofs undetected.

Either kind of revisit is a new profile rule, not an in-place loosening of this
one.
