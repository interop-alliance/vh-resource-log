/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The controller-document view a resource-log verifier authorizes against:
 * the profile's root of authority, resolved and verified by the reader
 * independently of the host serving the log. The interface is the seam.
 * Verification consumes only the account DID, the ordered controller-log
 * version list, the controller document at a version, and an optional
 * per-proof admission hook for controller-domain append policy. The verifier
 * reads the document's `assertionMethod` members through the shared readers
 * in `document.ts`. The caller builds the view from an already-verified
 * controller document, answering controller-version lookups from that
 * verified history rather than from any wire fetch. Handing the verifier a
 * view instead of a resolver is what enforces the profile's rule that
 * controller-document material never comes from the channel the log came
 * from. The did:webvh adapter over an account log lives in
 * `@interop/wallet-core` (`webvhResourceLogController`), which also supplies
 * the hook.
 */
import type { ControllerDocument } from './document.js'

/**
 * What log verification consumes of the independently verified controller
 * document: the DID the entry proofs must sign under, the verified controller
 * log's `versionId` list in order, the controller document at a given
 * version, and the optional {@link ResourceLogController.admitAppend}
 * admission hook. An empty version list marks an unversioned static
 * controller and degrades every controller-version rule to current-document
 * verification. The verifier dereferences each proof's verification method
 * against the document's `assertionMethod` members, so membership there is
 * the whole authorization rule. `keyAgreement`-only recovery keys and
 * `authentication`-only convenience keys are excluded structurally.
 */
export interface ResourceLogController {
  did: string
  /**
   * The verified controller log's `versionId` list in order. Precondition:
   * distinct entries, and append-only across resolutions -- a later view's
   * list extends an earlier one's, never rewrites it -- because the
   * verifier's controller version indexes (`headControllerVersionIndex`, the
   * hook's `controllerVersionIndex`) are positions in this list and are
   * compared across views by the pre-write pass.
   */
  versionIds: string[]
  /**
   * The verified controller document at a controller-log version
   * (`undefined`: the current document, the unversioned-controller
   * degradation). The verifier reads its `assertionMethod` relation through
   * the shared document readers: a proof's verification-method DID URL names
   * the member `${did}#${fragment}`, and the key the proof is verified under
   * is that member's resolved `publicKeyMultibase`. The fragment itself is
   * an opaque selector, as in DID Core, and a relative member id resolves
   * against the document's `id`. A view answers with the document and
   * applies no key rule of its own. A version the verified history does not
   * carry rejects (reported as Integrity, VRL-6).
   *
   * @param [versionId] {string}
   * @returns {Promise<ControllerDocument>}
   */
  documentAt(versionId?: string): Promise<ControllerDocument>
  /**
   * The admission hook: controller-domain append policy the generic verifier
   * cannot know, consulted per PROOF (multi-proof entries are legal, so a
   * per-entry call would admit an unadmitted proof in a later array
   * position), after `assertionMethod` membership passes, after the entry's
   * proofs verify, and before the head controller version advances, for
   * every entry
   * past genesis. A throw refuses the append (or the served log) with the
   * hook's own error class, propagated intact by the verifier. The hook is not
   * called for any proof of an entry that fails verification; an
   * implementation must not depend on being called.
   *
   * The hook is also consulted on the writer's own candidate entry before
   * the write (`verifyResourceLogAppend`, which `appendResourceLog` runs on
   * every compare-and-swap attempt), after the candidate's proofs verify. It
   * is therefore called on entries that then lose the race or are refused
   * and never written, and twice for a successful append (pre-write and on
   * read-back) with identical input. It must be a side-effect-free function
   * of the controller view and the input; a call is not evidence that an
   * entry was or will be written.
   *
   * The obligation the seam creates: a controller port over a document that
   * can list ladder-shaped verification methods (any wallet account
   * did:webvh document) MUST supply this hook, carrying wallet-core's
   * ceremony-tail license -- a bare view does not lack ladder keys, it lacks
   * the ability to recognize them, and a hook-less read would admit the
   * silent-rekey shape the license exists to refuse. Absent hook: no
   * admission step, the right shape only for a controller document that
   * cannot list such methods.
   *
   * The input is per proof, but its controller version is the entry's: every
   * proof of an entry carries the same controller versionId (the verifier
   * refuses an entry whose proofs disagree, and one that repeats a signing
   * key), so `controllerVersionId` and `controllerVersionIndex` are identical
   * across the calls for one entry. `proofKeys` is the entry-level view a
   * per-proof hook otherwise lacks: every proof's signing key, distinct, each
   * of which verified and passed membership. Read it as a set: the proof
   * array is host-mutable in order and multiplicity, in both directions. A
   * host can reorder, duplicate, or delete proofs without touching a
   * signature, since each proof signs the entry minus the array, so
   * `proofKeys` is a lower bound on the entry's proofs, not the full set. A
   * hook must return the same verdict for any ordering of `proofKeys`; a
   * count policy binds an honest host and the writer's own pre-write pass,
   * and read-back confirmation catches a deleted proof for the writer's own
   * entry. The identical-input promise above holds up to `proofKeys` order.
   *
   * @param input {object}
   * @param input.ordinal {number}   the entry's 1-based position in the log
   * @param input.keyMultibase {string}   the proof's signing-key multibase
   * @param [input.controllerVersionId] {string}   the entry's controller
   *   versionId, as a `versionId` (absent on an unversioned controller)
   * @param input.controllerVersionIndex {number | null}   the entry's
   *   controller versionId as an index into `versionIds` (`null` on an
   *   unversioned controller)
   * @param input.headControllerVersionIndex {number}   the head controller
   *   version before this entry -- the verified predecessors' effective
   *   controller version
   * @param input.proofKeys {string[]}   every proof's signing-key multibase
   *   in array order, one per proof, distinct; the calling proof's key is
   *   among them at its position
   * @returns {Promise<void>}
   */
  admitAppend?(input: {
    ordinal: number
    keyMultibase: string
    controllerVersionId?: string
    controllerVersionIndex: number | null
    headControllerVersionIndex: number
    proofKeys: string[]
  }): Promise<void>
}
