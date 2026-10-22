# Stable-4 Astro provider: parent handoff

Status: source prepared; generation, installation, tests and builds NOT RUN.
Production override/patch registration is NOT APPLIED.

## Active source

- Owning manifest: docs-site/package.json. Catalog get-tsconfig=4.14.3;
  catalog Rolldown=1.2.15 is the only added generator dependency.
- SOURCE.json routes to stable4/SOURCE.json, the immutable complete source,
  registry integrity, Git tree/gitHead, license, helper and original-consumer
  inventory. There are no retained active package.json workspaces.
- stable4/source overlays precisely three upstream modules: index.ts,
  parse-tsconfig/index.ts, parse-tsconfig/resolve-extends-path.ts; the fourth
  file, read-tsconfig-types.ts, owns the additive public result contract.
- build.mjs stages only recorded inputs and those explicit overlays. It uses
  owning docs Rolldown and the existing first-party root TS7 CLI. It never
  imports a TypeScript API, pkgroll or a declaration plugin.
  Its fence covers all source/contract inputs, the toolchain catalog, owning
  manifests, regression file, and actual GUI Node declaration dependency
  closure. Provider declaration generation preserves upstream skipLibCheck=true;
  acceptance of both additive public surfaces uses skipLibCheck=false.
- generate.mjs owns generation, complete patch application parity, source
  concurrency checks and final exact-parent binding. acceptance.mjs owns
  behavioral and installed-consumer contracts. stable4/type-contract.ts is
  compiled against both actual emitted public declaration formats.
- tests/ci-workflows/toolchain-catalogs.test.ts appends these behavioral cases;
  its pre-existing fast-uri work is preserved.

## Semantics

The existing parseTsconfig API retains stable-4 resolution, error, raw-fs cache,
mutable-result isolation, extends merging/rebasing, symbols and defaults.
The new synchronous readTsconfig shares that complete finalization pipeline.
Its request-local Set observes actual recursive config visits, root first in
the existing reversed-extends traversal order. It deduplicates reporting only;
it never skips parsing a repeated branch or derives sources from cache keys.
Metadata-only reads and project references are not watch sources.

Only readTsconfig opts into native Node JSON-entry resolution after the
existing PnP branch and before the existing stable metadata/legacy fallback.
Node's node/require JSON exports and package self references can resolve.
Runtime JS entries are not accepted by this added branch; exports blocks and
types-only/tsconfig-field fallbacks retain their existing treatment. Native
Node package resolution retains Node's own package-cache semantics. The old
parseTsconfig API does not acquire that process-wide cache.

The original Astro 7.4.1 source and historical receipts remain immutable.
Current installed comparison uses the public Astro 7.4.2 archive retained at
upstream/astro-7.4.2.tgz, verified against its exact registry SHA512 before
reading package metadata, license, runtime consumer and declarations to memory.
The archive is a required source input, covered by the generation fence.
The standard tar executable must support listing and named-member reads;
generation never extracts or installs an upstream package workspace.
The new public consumer source and API must be inspected and qualified in the
parent serial lane before adopting this update; version metadata alone is
insufficient. Installed JS and declarations are never rewritten.
The generator stages the exact 7.4.1 to 7.4.2 parent catalog transition in
memory. Its final atomic manifest write publishes the new catalog selection
and exact stable provider override together, after every generation check.
An unsuccessful generation leaves the previous parent and binding intact.
Its root-only tsconfig/jsconfig choice, strict raw JSONC validation, error
envelope, rawConfig round-trip and sources-to-watchFiles path remain intact.
No new TS5 or TS6 binding, peer relaxation, prerelease relabel or exception is
part of this plan. Archived TypeScript/version declarations in SOURCE.json
are immutable metadata, never installable manifests.

## Required parent sequence (capped serial lane only)

1. Select Node exactly from config/toolchains/node-typescript.json in the
   parent environment; use its existing runtime setup. Ensure existing owning
   catalog installations provide root TS7, GUI catalog Node declarations and
   docs Rolldown. Preserve Bun 1.4.3 and all independent lock domains.
   Current GUI catalog Node declarations are 26.6.5. Both TS7 CLI invocations
   use --checkers 1. Register generation/parity under the parent's 1 GiB Job
   cap with at least 2 GiB free, GOMAXPROCS=2 and GOMEMLIMIT=768MiB. These are
   inherited parent execution settings; no generation runs during source prep.
2. From the OpenCodex root run:
   node scripts/toolchains/astro-stable-config/generate.mjs --write
   Or run the owning docs prepare:astro-stable-config script with that Node.
   This performs two isolated builds, TS7 source/declaration checking, ESM/CJS
   behavioral qualification against published stable4 and a pristine source
   build, byte determinism, and real four-file git patch application parity.
   It must stop on any failure. No artifact or binding may be synthesized.
3. Success emits ONLY docs-site/patches/get-tsconfig@4.14.3.patch, covering
   dist/index.mjs, dist/index.cjs, dist/index.d.mts and dist/index.d.cts.
   Only then the generator registers patchedDependencies get-tsconfig@4.14.3
   and overrides["astro@7.4.2"]["get-tsconfig"]="catalog:" in the docs owner.
   It retires only the sole owned get-tsconfig entry under astro@7.4.1;
   a prior-parent row containing unrelated rules fails without discarding them.
   There is no Astro patch or npm package alias. No lock metadata is emitted.
4. Run the normal docs-domain Bun 1.4.3 install in the parent's serial lane.
   Bun's actual exact-parent catalog override plus patch application is an
   acceptance gate. If it fails, stop and retain the real diagnostics; never
   repair by inventing lock metadata or renaming a dependency.
5. Run:
   node scripts/toolchains/astro-stable-config/generate.mjs --check
   bun test tests/ci-workflows/toolchain-catalogs.test.ts
   The Bun source cases delegate to guarded canonical Node --verify-source;
   --verify-source generates only in temporary directories and writes no
   production patch or manifest. An installed old/beta provider must fail.
6. Run the docs build and the parent's required TS7/consumer checks. Exercise
   relevant Windows/Linux lanes before claiming cross-platform acceptance.
   Existing security/release review remains separate from source-local proof.

## Acceptance coverage

- Published stable4 vs pristine Rolldown vs corrected parse: JSONC, empty/null/
  scalar/array input behavior, defaults, compiler flags, configDir, implicit
  baseUrl symbols, file/path matchers, root discovery, missing/invalid/cyclic
  extends, exact errors, caller fs caches, fresh reads, result mutation, and
  package export-metadata changes with cache reuse and clear.
- New read contract: synchronous return/throws, exact diamond/duplicate graph
  sources and ordering, references ignored, metadata excluded, explicit
  package.json-as-config included, repeated cached calls and request isolation.
- Node JSON conditions/subpaths, blocked exports, types-only fallback and PnP
  precedence; pure ESM/CJS parsing with a poisoned provider-local TS API slot.
- TS7 checks canonical source, emits additive types, then strictly checks both
  self-contained public surfaces against canonical emitted declarations,
  including negative Promise/missing-sources/cache-value contracts.
- Installed actual Astro consumer: byte-identical original caller/declarations,
  actual get-tsconfig@4.14.3 resolution, exact canonical generated artifact
  hashes, ESM/CJS agreement, raw/error/jsconfig/default/alias/watch behavior.
- Installed provider has only its original resolve-pkg-maps runtime dependency
  and no TS peer. Resolution/lock checks reject new TS5/TS6 bindings; unrelated
  approved root/GUI compiler consumers remain untouched.

## Retained historical proposal

inert/tsconfck/ contains unchanged prior generator/helper/receipt snapshots.
source/astro/, source/tsconfck/ and upstream/tsconfck/ remain inert historical
inputs. They are not imported by the active generator or tests. The original
upstream/astro/ published consumer/license inputs remain immutable comparison
evidence. No deprecated tsconfck production alias or patch is activated.
All historical SOURCE.json records, including stable4/SOURCE.json and its
recorded Astro 7.4.1/Rolldown 1.2.14 provenance, retain their exact bytes.
