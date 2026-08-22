# Agent Guidelines

## Project Overview

`@interop/vh-resource-log` is the Resource Log Profile's generic client side:
the strict JSON Lines codec, the log-store and chain-head-pin ports, full chain
verification against an adversarial host, the append/create path with
compare-and-swap rebase and read-back confirmation, and the sealing sweep. It
was extracted from `@interop/wallet-core` (`src/resourceLog/`) and
`@interop/was-client` (`src/log/`) so that both, plus the wallets, share one
verifier; the placement and its boundaries are recorded in
[decisions/0001](decisions/0001-profile-client-side-placement.md) and the
current shape in [ARCHITECTURE.md](ARCHITECTURE.md) -- read both before making
changes.

What does NOT belong here: wire types (`@interop/storage-core`), the did:webvh
hashing/proof kernel (`@interop/did-method-webvh`), the WAS store adapter
(`@interop/was-client/log`), and wallet-domain admission policy -- the did:webvh
controller adapter and the ceremony-tail license (`@interop/wallet-core`),
reached only through the controller port's `admitAppend` hook.

The `./testing` subpath (`src/testing.ts`) is test fixtures only; never import
it from production code, and keep its fakes faithful to the ports' contracts
(consumers use them as the reference implementations).

## Toolchain & Project Layout

### Package Manager

Use `pnpm` (not `npm` or `yarn`). The lockfile is `pnpm-lock.yaml`. Install deps
with `pnpm install`; run scripts with `pnpm run <script>` or `pnpm <script>`.

### Build

The library is built with `tsc` (not `vite build`). `vite.config.ts` exists only
to configure Vitest and to run `vite dev` as a server for Playwright. Running
`pnpm run build` compiles `src/` to `dist/` via `tsconfig.json`.

### Two tsconfigs

- `tsconfig.json` — library build only; includes `src/**/*`
- `tsconfig.dev.json` — extends the above with `noEmit: true`; adds `test/**/*`,
  `vite.config.ts`, and `playwright.config.ts` so ESLint's type-aware rules
  cover all files

Do not add test files to `tsconfig.json` — they would be emitted into `dist/`.

### Tests

- `test/node/` — Vitest unit tests (`pnpm run test:node`); run in Node. The
  adversarial suites (verify, append, admission hook) run against the published
  fixtures from `src/testing.ts` plus the signer fixture in
  `test/node/fixtures/log.ts`.
- `test/browser/` — Playwright smoke test (`pnpm run test:browser`); verifies a
  fixture log in real Chromium via a Vite dev server (`pnpm run dev`), covering
  the kernel and `@noble/curves` under the browser build.

The `dev` script exists solely to give Playwright a server that can serve and
transform TypeScript source files on the fly. There is no browser app.

### ESM & import paths

The package is ESM-only (`"type": "module"`). Local imports must use the `.js`
extension even though source files are `.ts` — e.g.
`import { verifyResourceLog } from '../../src/index.js'`. TypeScript's
`moduleResolution: Bundler` resolves these to the `.ts` source at compile time.

## Architecture

The current shape of the library lives in [ARCHITECTURE.md](./ARCHITECTURE.md),
rationale inline, updated in the same change set that alters the shape. It is
load-bearing for the conventions below: the design gate scopes on the invariants
it documents, `touches:` entries name it as a deliverable, and the
breaking-release audit checks it against the code.

## Roadmap & Task Conventions

All roadmap tracking lives in [ROADMAP.md](./ROADMAP.md): narrative context plus
structured `### VRL-N` work items, following the item structure shared across
the `@interop/*` repos (canonical in isomorphic-lib-template's AGENTS.md,
"Roadmap & Task Conventions" -- item schema, `touches:`, the design gate, and
the archive rule). Never create a parallel task list elsewhere. Completed items
move verbatim to [archived-roadmap.md](./archived-roadmap.md).

## Decision Records

Cross-repo decisions get a durable record in `decisions/NNNN-slug.md`; the
convention and template are canonical in isomorphic-lib-template's `decisions/`
directory. Design-gate design docs live in `designs/` per the same template
repo's `designs/` convention.

## Releasing

The `@interop/*` publish convention is canonical in isomorphic-lib-template's
AGENTS.md ("Releasing"): the CHANGELOG's top entry names the version, `TBD`
becomes the release date at publish time, and a breaking release runs the
doc-vs-code audit over the consumers in the affected contract's "Parties to this
contract" tables (this library is a party in encrypted-collections-spec's
table). Error-class `name` strings are wire-like contracts here (ARCHITECTURE.md
invariant 9); changing one is breaking.

## Conventions

Code style, refactoring, JSDoc, comment, and error-handling conventions live in
@CONTRIBUTING.md -- follow them. That file's marked conventions block is the
canonical shared core copied across `@interop/*` repos; edit it in
isomorphic-lib-template, not here.

## Ecosystem conventions

- Cross-repo lessons (invariants, gotchas, and process recipes that span repos)
  live in the ecosystem learnings file,
  [byoe-ecosystem/LEARNINGS.md](https://github.com/interop-alliance/byoe-ecosystem/blob/main/LEARNINGS.md)
  (usually checked out beside this repo as `../byoe-ecosystem`); read it at the
  start of any cross-repo task, and write a lesson produced by a task here into
  it in the same working session.
