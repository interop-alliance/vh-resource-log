# Verifiable-History Resource Log _(@interop/vh-resource-log)_

[![Node.js CI](https://github.com/interop-alliance/vh-resource-log/workflows/CI/badge.svg)](https://github.com/interop-alliance/vh-resource-log/actions?query=workflow%3A%22CI%22)
[![NPM Version](https://img.shields.io/npm/v/@interop/vh-resource-log.svg)](https://npm.im/@interop/vh-resource-log)

> The Resource Log Profile's generic client side: strict JSON Lines codec, store
> and pin ports, chain verification, append/create with compare-and-swap rebase,
> and the sealing sweep. For the browser, Node.js, and React Native.

## Table of Contents

- [Background](#background)
- [Security](#security)
- [Install](#install)
- [Usage](#usage)
- [Contribute](#contribute)
- [License](#license)

## Background

A resource log is a hash-linked, signed history of one JSON resource's state,
stored as JSON Lines and co-managed between a wallet's clients and a storage
server that is not trusted with the history's integrity. This library owns the
profile's generic client side: parsing and serializing the log, building and
signing entries, verifying a served log end to end (shape, SCID, chain hashes,
proofs, external authorization against a caller-supplied verified controller
view), refusing rollbacks and forks against a durable chain-head pin, appending
through a compare-and-swap store port with rebase-and-retry and read-back
confirmation, and the sealing sweep that carries a log's controller version
forward after a controller-membership removal.

What deliberately lives elsewhere: the wire types in `@interop/storage-core`;
the hashing and proof kernel in `@interop/did-method-webvh`; the WAS binding of
the store port in `@interop/was-client/log`; and the wallet-domain admission
policy (the did:webvh controller adapter and the ceremony-tail license on
ladder-signed appends) in `@interop/wallet-core`, reached through the controller
port's optional `admitAppend` hook. The placement is recorded in
[decisions/0001](decisions/0001-profile-client-side-placement.md).

The log format is profiled on did:webvh by reference: entry hashing, `versionId`
construction, SCID derivation, and proof verification are the did:webvh log
kernel's, consumed from `@interop/did-method-webvh` by named import. That
coupling is a design property, not an accident -- the kernel's outputs are fixed
by the did:webvh spec and must be bit-identical everywhere, so extracting a
separately versioned "hash log kernel" was rejected (two resolved kernel copies
would fail as a silent hash mismatch; see decision 0001's rejected alternatives
for the revisit criteria).

## Security

The verifier assumes an adversarial host: nothing served beside the log -- a
stated head, a digest, a count, a controller document -- is ever accepted in
place of recomputation. The controller view the caller supplies must be resolved
and verified independently of the channel the log came from. A controller
document that can list ladder-shaped verification methods (any wallet account
did:webvh document) must supply the `admitAppend` hook; a hook-less read of such
a log admits appends the wallet-side license refuses.

Cross-package error matching is by `err.name` rather than `instanceof`; every
error class here assigns its `name` explicitly and keeps the string stable (see
`src/errors.ts` for the ratified contract).

## Install

- Node.js 24+ is recommended.

### PNPM

To install via PNPM:

```
pnpm install @interop/vh-resource-log
```

### Development

To install locally (for development):

```
git clone https://github.com/interop-alliance/vh-resource-log.git
cd vh-resource-log
pnpm install
```

## Usage

```ts
import {
  createResourceLog,
  appendResourceLog,
  readResourceLog,
  memoryResourceLogPinStore,
  resourceLogPinId
} from '@interop/vh-resource-log'

// A ResourceLogStore (e.g. was-client's resourceLogStore over a WAS
// Resource), a verified controller view, a signer, and a durable pin store
// are the caller's to supply.
const pinStore = memoryResourceLogPinStore()
const logId = resourceLogPinId({
  spaceId,
  collectionId: 'key-map',
  resourceId: 'user-key.jsonl'
})

await createResourceLog({
  store,
  controller,
  method: 'resource-log:0.1',
  pinStore,
  logId,
  signer,
  state: { type: 'MyState', value: 1 }
})

await appendResourceLog({
  store,
  controller,
  expectedMethod: 'resource-log:0.1',
  pinStore,
  logId,
  signer,
  // Called with the verified head on every CAS attempt; return null when the
  // head already carries the change.
  buildState: verified => ({ type: 'MyState', value: 2 })
})

const current = await readResourceLog({
  store,
  controller,
  expectedMethod: 'resource-log:0.1',
  pinStore,
  logId
})
```

Test fixtures (a fake controller and an in-memory store) ship on the
`@interop/vh-resource-log/testing` subpath. They are for tests only: the fakes
neuter authorization and durability while appearing to work, so keep the subpath
out of production import globs.

## Contribute

PRs accepted. See [CONTRIBUTING.md](CONTRIBUTING.md) for editor setup (Prettier,
ESLint, and EditorConfig) and how it maps to CI.

If editing the Readme, please conform to the
[standard-readme](https://github.com/RichardLitt/standard-readme) specification.

## License

[MIT License](LICENSE.md) © 2026 Interop Alliance.
