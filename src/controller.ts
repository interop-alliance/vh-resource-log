/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The controller-document view a resource-log verifier authorizes against:
 * the profile's root of authority, resolved and verified by the reader
 * independently of the host serving the log. The interface is the seam --
 * verification consumes only the account DID, the ordered controller-log
 * version list, per-version `assertionMethod` membership, and (optionally)
 * a per-proof admission hook for controller-domain append policy -- and the
 * caller builds it from an already-verified controller document, answering
 * controller-version lookups from that verified history rather than from any
 * wire fetch. Handing the verifier a view instead of a resolver is what
 * enforces the profile's rule that controller-document material never comes
 * from the channel the log came from. The did:webvh adapter over an account
 * log lives in `@interop/wallet-core` (`webvhResourceLogController`), which
 * also supplies the hook.
 */

/**
 * What log verification consumes of the independently verified controller
 * document: the DID the entry proofs must sign under, the verified controller
 * log's `versionId` list in order (empty for an unversioned static
 * controller, degrading every controller-version rule to current-document
 * verification),
 * the set of `assertionMethod` key multibases at a given version --
 * membership there is the whole authorization rule, so `keyAgreement`-only
 * recovery keys and `authentication`-only convenience keys are excluded
 * structurally -- and the optional {@link ResourceLogController.admitAppend}
 * admission hook.
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
   * Resolves the `assertionMethod` public-key multibases at a controller-log
   * version (`undefined`: the current document, the unversioned-controller
   * degradation).
   *
   * @param [versionId] {string}
   * @returns {Promise<Set<string>>}
   */
  assertionKeysAt(versionId?: string): Promise<Set<string>>
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
   * @param input {object}
   * @param input.ordinal {number}   the entry's 1-based position in the log
   * @param input.keyMultibase {string}   the proof's signing-key multibase
   * @param [input.controllerVersionId] {string}   the proof's entry
   *   controller versionId (absent on an unversioned controller)
   * @param input.controllerVersionIndex {number | null}   the controller
   *   versionId as an index into `versionIds` (`null` on an unversioned
   *   controller)
   * @param input.headControllerVersionIndex {number}   the head controller
   *   version before this entry -- the verified predecessors' effective
   *   controller version
   * @returns {Promise<void>}
   */
  admitAppend?(input: {
    ordinal: number
    keyMultibase: string
    controllerVersionId?: string
    controllerVersionIndex: number | null
    headControllerVersionIndex: number
  }): Promise<void>
}
