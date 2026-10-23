// Source-local preparation only. This never installs, edits node_modules or locks,
// accepts evidence, or grants security/release approval.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const sourceRoot = dirname(fileURLToPath(import.meta.url));
const repo = resolve(sourceRoot, '../../..');
const docsManifest = join(repo, 'docs-site/package.json');
const text = (path) => readFileSync(path, 'utf8');
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readJSON = (path) => JSON.parse(text(path));

export function loadInputs() {
  const receipt = readJSON(join(sourceRoot, 'SOURCE.json'));
  for (const [path, expected] of Object.entries(receipt.inputSha256)) {
    if (!path.startsWith('upstream/') || path.split('/').includes('..')) throw new Error('Invalid retained input path');
    if (sha256(readFileSync(join(sourceRoot, path))) !== expected) throw new Error(`Retained source drift: ${path}`);
  }
  return receipt;
}

export function parseOptionsInterface(source) {
  const start = source.indexOf('export interface TSConfckParseOptions extends TSConfckFindOptions {');
  const end = source.indexOf('\n}', start);
  if (start < 0 || end < start) throw new Error('Missing canonical parse options interface');
  return source.slice(start, end + 2);
}

export function providerDeclaration() {
  const original = parseOptionsInterface(text(join(sourceRoot, 'upstream/tsconfck/src/public.d.ts')));
  const corrected = parseOptionsInterface(text(join(sourceRoot, 'source/tsconfck/public.d.ts')));
  const indent = (value) => value.split('\n').map((line) => `\t${line}`).join('\n');
  const published = text(join(sourceRoot, 'upstream/tsconfck/types/index.d.ts'));
  const needle = indent(original);
  if (published.split(needle).length !== 2) throw new Error('Published declaration no longer matches its canonical interface');
  // Project the changed canonical interface. An external module also types the
  // npm alias correctly; a named ambient 'tsconfck' module only types that name.
  // No stale upstream source map is advertised for this generated projection.
  const projected = published.replace(needle, indent(corrected));
  const opening = "declare module 'tsconfck' {\n";
  const closing = projected.lastIndexOf('\n}\n');
  if (!projected.startsWith(opening) || closing < opening.length) throw new Error('Unexpected published declaration wrapper');
  return projected.slice(opening.length, closing).split('\n').map((line) => {
    if (line && !line.startsWith('\t')) throw new Error('Unexpected declaration indentation');
    return line.startsWith('\t') ? line.slice(1) : line;
  }).join('\n') + '\n';
}

export function filePatch(path, original, corrected) {
  if (original === corrected) return '';
  if ([original, corrected].some((value) => value.includes('\r'))) {
    throw new Error(`Patch inputs must use LF line endings: ${path}`);
  }
  const oldNewline = original.endsWith('\n');
  const newNewline = corrected.endsWith('\n');
  const before = (oldNewline ? original.slice(0, -1) : original).split('\n');
  const after = (newNewline ? corrected.slice(0, -1) : corrected).split('\n');
  let prefix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  if (oldNewline !== newNewline && prefix === Math.min(before.length, after.length)) prefix = Math.max(0, prefix - 1);
  let suffix = 0;
  while (oldNewline === newNewline && suffix < Math.min(before.length, after.length) - prefix && before.at(-suffix - 1) === after.at(-suffix - 1)) suffix++;
  const start = Math.max(0, prefix - 3);
  const trailing = Math.min(3, suffix);
  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  const lines = (values, start, end, marker, newline) => values.slice(start, end).flatMap((line, offset) => [
    `${marker}${line}`, ...(!newline && start + offset === values.length - 1 ? ['\\ No newline at end of file'] : []),
  ]);
  return [
    `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
    `@@ -${start + 1},${oldEnd + trailing - start} +${start + 1},${newEnd + trailing - start} @@`,
    ...lines(before, start, prefix, ' ', oldNewline),
    ...lines(before, prefix, oldEnd, '-', oldNewline),
    ...lines(after, prefix, newEnd, '+', newNewline),
    ...lines(before, oldEnd, oldEnd + trailing, ' ', oldNewline), '',
  ].join('\n');
}

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < start) throw new Error('Pinned upstream build source changed');
  return source.slice(start, end);
}

async function upstreamTranspiler(pkg, receipt) {
  const owner = createRequire(docsManifest);
  const compilerManifest = readJSON(owner.resolve('rolldown/package.json'));
  if (pkg.devDependencies?.rolldown !== 'catalog:' || pkg.catalog.rolldown !== receipt.compiler.version || compilerManifest.version !== pkg.catalog.rolldown) {
    throw new Error('Install the owning docs catalog Rolldown before generation');
  }
  const compilerURL = pathToFileURL(owner.resolve('rolldown/utils')).href;
  const build = text(join(sourceRoot, 'upstream/astro/build.js'));
  // Execute the unchanged, hash-checked upstream per-file generator, including
  // its node20 target and output/error handling. No TypeScript compiler API.
  const getLang = section(build, 'function getLang(', '/**\n * Transpile a single file');
  const transpile = section(build, 'async function transpileFile(', 'export default async function build');
  const moduleSource = `import fs from 'node:fs/promises';\nimport path from 'node:path';\nimport { transform } from ${JSON.stringify(compilerURL)};\n${getLang}\nexport ${transpile}`;
  return (await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`)).transpileFile;
}

export async function buildPatches(pkg) {
  const receipt = loadInputs();
  const transpile = await upstreamTranspiler(pkg, receipt);
  const stage = mkdtempSync(join(tmpdir(), 'ocx-astro-stable-'));
  try {
    const outputs = [];
    for (const [mode, source] of [
      ['pristine', text(join(sourceRoot, 'upstream/astro/tsconfig.ts'))],
      ['corrected', text(join(sourceRoot, 'source/astro/tsconfig.ts'))],
    ]) {
      const base = join(stage, mode, 'src');
      const entry = join(base, 'core/config/tsconfig.ts');
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(entry, source);
      const outdir = join(stage, mode, 'dist');
      await transpile(entry, { outdir, outbase: base, isDev: false, define: {} });
      outputs.push(text(join(outdir, 'core/config/tsconfig.js')));
    }
    const baseline = text(join(sourceRoot, 'upstream/astro/tsconfig.published.js'));
    if (outputs[0] !== baseline) {
      throw new Error('STOP: pinned upstream source/build tool does not reproduce the published Astro module; no artifacts or binding were written');
    }
    const patches = {
      'astro@7.4.1': filePatch('dist/core/config/tsconfig.js', baseline, outputs[1]),
      'tsconfck@3.1.6': [
        filePatch('src/parse.js', text(join(sourceRoot, 'upstream/tsconfck/src/parse.js')), text(join(sourceRoot, 'source/tsconfck/parse.js'))),
        filePatch('src/public.d.ts', text(join(sourceRoot, 'upstream/tsconfck/src/public.d.ts')), text(join(sourceRoot, 'source/tsconfck/public.d.ts'))),
        filePatch('types/index.d.ts', text(join(sourceRoot, 'upstream/tsconfck/types/index.d.ts')), providerDeclaration()),
      ].join(''),
    };
    if (Object.values(patches).some((patch) => !patch)) throw new Error('Missing generated consumer/provider patch');
    return { receipt, patches };
  } finally {
    // Only the exact temporary directory created by this invocation is removed.
    if (dirname(stage) !== tmpdir() || !stage.startsWith(join(tmpdir(), 'ocx-astro-stable-'))) throw new Error('Temporary directory ownership changed');
    rmSync(stage, { recursive: true, force: true });
  }
}

export function bindManifest(pkg, receipt) {
  const { selector, dependency, catalogKey, specifier } = receipt.productionBinding;
  if (pkg.catalog?.astro !== receipt.packages.astro.version || pkg.dependencies?.astro !== 'catalog:' || pkg.catalog?.[catalogKey] !== specifier) {
    throw new Error('Docs catalog no longer selects the inspected consumer/provider pair');
  }
  const bound = structuredClone(pkg);
  bound.overrides ??= {};
  const existing = bound.overrides[selector];
  if (existing !== undefined && (typeof existing !== 'object' || Array.isArray(existing) || existing === null)) throw new Error('Conflicting exact-parent override');
  if (existing?.[dependency] !== undefined && existing[dependency] !== 'catalog:') throw new Error('Conflicting provider override');
  bound.overrides[selector] = { ...existing, [dependency]: 'catalog:' };
  bound.patchedDependencies ??= {};
  for (const [owner, output] of Object.entries(receipt.outputs)) {
    const path = output.replace(/^docs-site\//, '');
    if (bound.patchedDependencies[owner] !== undefined && bound.patchedDependencies[owner] !== path) throw new Error('Conflicting package patch registration');
    bound.patchedDependencies[owner] = path;
  }
  return bound;
}

function assertOwnedPath(path) {
  if (lstatSync(repo).isSymbolicLink()) throw new Error('Owning checkout is a link or junction');
  const rel = relative(repo, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Output escapes the owning checkout');
  let current = repo;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Output contains a link or junction');
  }
}

function atomicWrite(path, content) {
  assertOwnedPath(path);
  mkdirSync(dirname(path), { recursive: true });
  const pending = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(pending, content, { flag: 'wx' });
    renameSync(pending, path);
  } finally {
    if (existsSync(pending)) rmSync(pending);
  }
}

export async function generate(mode) {
  if (!['--write', '--check'].includes(mode)) throw new Error('Specify --write or --check');
  const runtime = readJSON(join(repo, 'config/toolchains/node-typescript.json'));
  if (process.release.name !== 'node' || process.version !== `v${runtime.node}`) throw new Error('Select the exact owning canonical Node runtime first');
  const before = text(docsManifest);
  const pkg = JSON.parse(before);
  const { receipt, patches } = await buildPatches(pkg);
  const bound = bindManifest(pkg, receipt);
  if (text(docsManifest) !== before) throw new Error('Docs manifest changed during generation; retry after the owner finishes');
  for (const [owner, patch] of Object.entries(patches)) {
    const output = join(repo, receipt.outputs[owner]);
    if (mode === '--check') {
      if (!existsSync(output) || text(output) !== patch) throw new Error(`Generated patch drift: ${owner}`);
    } else atomicWrite(output, patch);
  }
  if (mode === '--check') {
    if (JSON.stringify(pkg) !== JSON.stringify(bound)) throw new Error('Generated patches are not bound to the exact Astro catalog slot');
  } else {
    // Register production wiring last, only after BOTH complete artifacts exist.
    if (text(docsManifest) !== before) throw new Error('Docs manifest changed before activation');
    atomicWrite(docsManifest, `${JSON.stringify(bound, null, 2)}\n`);
  }
  return { scope: 'source-local-generation-only', patches: Object.fromEntries(Object.entries(patches).map(([owner, value]) => [owner, sha256(value)])), aliasAndPatchApplication: 'UNVERIFIED', securityReview: 'PENDING' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await generate(process.argv[2]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
