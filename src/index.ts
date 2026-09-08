/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The `@interop/vh-resource-log` entry: the Resource Log Profile's generic
 * client side -- strict JSON Lines parse/serialize, the log-store port and
 * the read-back `confirmAppend`, full chain verification against an
 * adversarial host (parse shape, SCID and entry-hash recomputation, entry
 * proofs, the external-authorization rule against a caller-supplied verified
 * controller view, the per-proof `admitAppend` admission hook, terminal
 * entries), the chain-head pin with its continuity rules, the append path
 * (verified-head build, the pre-write pass `verifyResourceLogAppend` over the
 * candidate, CAS with rebase-and-retry, read-back confirmation),
 * and the sealing sweep (the idempotent backstop append that advances a
 * log's head past the controller's latest membership change).
 *
 * The wire types come from `@interop/storage-core`; the hashing and proof
 * kernel from `@interop/did-method-webvh`. The WAS binding of the store port
 * lives in `@interop/was-client/log`; the did:webvh controller adapter and
 * the ceremony-tail license (the wallet-domain admission policy supplied
 * through the hook) live in `@interop/wallet-core`. Test fixtures live on
 * the `./testing` subpath, never here.
 */
export type { ResourceLogController } from './controller.js'
export {
  isResourceLogConflictError,
  isResourceLogRefusal,
  LogNotConfirmedError,
  ResourceLogClosedError,
  ResourceLogConflictError,
  ResourceLogContinuityError,
  ResourceLogIntegrityError
} from './errors.js'
export {
  parseResourceLog,
  serializeResourceLog,
  serializeResourceLogEntry
} from './jsonl.js'
export { confirmAppend, type ResourceLogStore } from './store.js'
export {
  buildResourceLogEntry,
  buildResourceLogGenesis,
  type ResourceLogSigner
} from './entry.js'
export {
  collectionLogPinId,
  memoryResourceLogPinStore,
  resourceLogPinId,
  type ResourceLogHeadPin,
  type ResourceLogPinStore
} from './pin.js'
export {
  isTerminalResourceLogEntry,
  verifyResourceLog,
  verifyResourceLogAppend,
  verifyResourceLogHandover,
  type VerifiedResourceLog
} from './verify.js'
export {
  appendResourceLog,
  createResourceLog,
  readResourceLog
} from './append.js'
export { latestAssertionRemovalIndex, sealResourceLog } from './seal.js'
export {
  buildVersionedVm,
  parseVersionedVm,
  vmFragmentOf
} from './vmFragment.js'
