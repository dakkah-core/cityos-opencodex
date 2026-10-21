// Source-local provider preparation. No install, lock rewrite or approval claim.
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundle, confinedPath, loadInputs, ownedTemporaryDirectory, preparationError, put, read, repo, reportPreparationError, runtime, sha256, sourceRoot, sourceState, stageInputs, typeDeclarations } from './build.mjs';

export { loadInputs, sha256, sourceRoot } from './build.mjs';
import { applyPatch, bindManifest, filePatch, patchRelative } from './patch-contract.mjs';
export { bindManifest, filePatch, patchRelative } from './patch-contract.mjs';
const manifestPath = join(repo, 'docs-site/package.json');

export async function buildPatches(pkg) {
  runtime();
  const receipt = loadInputs();
  const before = sourceState(receipt);
  if (pkg.catalog?.['get-tsconfig'] !== '4.14.3' || pkg.catalog?.astro !== '7.4.1' || pkg.dependencies?.astro !== 'catalog:') throw preparationError('Unexpected owning catalog consumer/provider pair');
  const temporary = ownedTemporaryDirectory(tmpdir(), 'ocx-stable4-');
  const stage = temporary.path;
  try {
    const { qualifyBuild } = await import('./acceptance.mjs');
    const passes = [];
    for (const pass of ['first', 'second']) {
      const base = join(stage, pass);
      const published = join(base, 'published');
      stageInputs(published, receipt, false);
      for (const file of ['dist/index.mjs', 'dist/index.cjs', 'dist/index.d.mts', 'dist/index.d.cts']) {
        put(published, file, read(join(sourceRoot, 'stable4/upstream/npm/get-tsconfig', file)));
      }
      const pristine = join(base, 'pristine');
      stageInputs(pristine, receipt, false);
      const pristineOutputs = await bundle(pristine, pkg, receipt);
      const corrected = join(base, 'corrected');
      stageInputs(corrected, receipt, true);
      const outputs = { ...await bundle(corrected, pkg, receipt), ...typeDeclarations(corrected, receipt) };
      const cases = await qualifyBuild({ published, pristine, corrected });
      passes.push({ outputs, pristineOutputs, cases, published });
    }
    if (JSON.stringify(passes[0].outputs) !== JSON.stringify(passes[1].outputs) ||
        JSON.stringify(passes[0].pristineOutputs) !== JSON.stringify(passes[1].pristineOutputs)) throw preparationError('Non-deterministic bundled/declaration output');
    const { outputs, cases, published } = passes[0];
    const patch = Object.entries(outputs).map(([file, value]) =>
      filePatch(file, read(join(sourceRoot, 'stable4/upstream/npm/get-tsconfig', file)), value)).join('');
    if (!patch || patch.split('diff --git ').length !== 5) throw preparationError('Expected the complete four-file provider patch');
    // Prove the complete generated patch applies to the registry baseline.
    applyPatch(published, patch, true);
    applyPatch(published, patch);
    for (const [file, value] of Object.entries(outputs)) {
      if (read(join(published, file)) !== value) throw preparationError('Generated patch application mismatch: ' + file);
    }
    if (sourceState(loadInputs()) !== before) throw preparationError('Canonical source changed during generation');
    return { receipt, patch, outputs, cases };
  } finally {
    temporary.remove();
  }
}

export async function generate(mode) {
  if (!['--write', '--check', '--verify-source'].includes(mode)) throw preparationError('Specify --write, --check or --verify-source');
  runtime();
  confinedPath(repo, 'docs-site/package.json');
  const before = read(manifestPath);
  const pkg = JSON.parse(before);
  const { patch, cases, outputs } = await buildPatches(pkg);
  if (read(manifestPath) !== before) throw preparationError('Docs manifest changed during preparation');
  if (mode === '--verify-source') return { cases, patchSha256: sha256(patch), outputSha256: Object.fromEntries(Object.entries(outputs).map(([file, value]) => [file, sha256(value)])), emitted: false, bound: false };
  const output = confinedPath(repo, 'docs-site/' + patchRelative);
  confinedPath(repo, 'docs-site/package.json');
  if (mode === '--write') put(repo, 'docs-site/' + patchRelative, patch);
  else if (!existsSync(output) || read(output) !== patch) throw preparationError('Generated provider patch drift');
  const bound = bindManifest(pkg, patch);
  if (mode === '--check') {
    if (JSON.stringify(bound) !== JSON.stringify(pkg)) throw preparationError('Generated patch is not bound to exact Astro parent');
  } else {
    if (read(manifestPath) !== before) throw preparationError('Docs manifest changed before binding');
    // Production binding is the final write, after every generation gate.
    put(repo, 'docs-site/package.json', bound);
  }
  return { scope: 'source-local-generation-only', patchSha256: sha256(patch), cases, installedApplication: 'UNVERIFIED', securityReview: 'PENDING' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await generate(process.argv[2]))); }
  catch (error) { reportPreparationError(error); process.exitCode = 1; }
}
