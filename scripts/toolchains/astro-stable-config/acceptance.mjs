// Behavioral fixtures for the parent's serial lane; no installed modules edited.
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalRelativePath, command, confinedPath, consumerArchiveMembers, consumerCatalog, consumerMembers, consumerPackageMetadata, consumerVersion, json, loadConsumerInputs, loadInputs, ownedTemporaryDirectory, put, read, repo, reportPreparationError, rolldownCatalog, sha256, sourceRoot, stageInputs, verifyConsumerArchive } from './build.mjs';
import { applyPatch, bindConsumerManifest, bindManifest, filePatch, patchRelative, prepareConsumerManifest } from './patch-contract.mjs';

const slash = value => value.replaceAll('\\', '/');
const stableNames = ['createFilesMatcher', 'createPathsMatcher', 'findTsconfig', 'getTsconfig', 'parseTsconfig'];
export const sourceCases = ['stable-parity', 'errors-and-cache', 'exact-sources', 'node-resolution', 'pnp-and-pure'];
export const installedCases = ['watch-and-alias', 'raw-and-errors', 'jsconfig-and-metadata', 'no-compiler-binding'];

async function fixture(run) {
  const temporary = ownedTemporaryDirectory(tmpdir(), 'ocx-config-contract-');
  try { return await run(temporary.path); }
  finally { temporary.remove(); }
}

// Symbols are provider-local. Preserve their descriptions/values and undefined
// when comparing results, including implicit-baseUrl state.
function snapshot(value) {
  if (value && typeof value === 'object') {
    const entries = Reflect.ownKeys(value).map(key => [typeof key === 'symbol' ? 'symbol:' + key.description : key, snapshot(value[key])])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    return Array.isArray(value) ? { array: entries } : entries;
  }
  return value;
}
function outcome(run) {
  try { return { value: snapshot(run()) }; }
  catch (error) { return { error: { class: error.constructor.name, name: error.name, message: error.message } }; }
}
function parity(providers, file) {
  const expected = outcome(() => providers[0].parseTsconfig(file));
  for (const provider of providers.slice(1)) assert.deepEqual(outcome(() => provider.parseTsconfig(file)), expected);
  const actual = providers.at(-1);
  if (expected.error) assert.deepEqual(outcome(() => actual.readTsconfig(file)), expected);
  else assert.deepEqual(snapshot(actual.readTsconfig(file).config), expected.value);
}

function stableParity(providers, root) {
  const file = put(root, 'tsconfig.json', {});
  put(root, 'src/entry.ts', '');
  put(root, 'vendor/entry.ts', '');
  const configDir = '$' + '{configDir}';
  for (const config of [
    {},
    { compilerOptions: { paths: { '@/*': ['./src/*'] } } },
    { compilerOptions: { strict: true, noImplicitAny: false, composite: true, target: 'ESNext', checkJs: true, lib: ['DOM', 'ESNext'] } },
    { compilerOptions: { module: 'NodeNext', outDir: './build', declarationDir: './types', rootDirs: ['./src', './generated'], typeRoots: ['./types'] } },
    { compilerOptions: { baseUrl: configDir + '/src', outDir: configDir + '/out', paths: { '@/*': [configDir + '/src/*'] } }, files: [configDir + '/entry.ts'] },
    { compilerOptions: { baseUrl: './src', paths: { '@/*': ['*'] } }, files: ['./entry.ts'], include: ['src/**/*.ts'], exclude: ['vendor'], watchOptions: { watchFile: 'UseFsEvents', excludeDirectories: ['vendor'] } },
  ]) {
    put(root, 'tsconfig.json', config);
    parity(providers, file);
    const matches = providers.map(provider => {
      const result = { path: file, config: provider.parseTsconfig(file) };
      const matcher = provider.createPathsMatcher(result);
      const files = provider.createFilesMatcher(result, true);
      return [matcher ? matcher('@/entry') : null, Boolean(files(join(root, 'src/entry.ts'))), Boolean(files(join(root, 'vendor/entry.ts')))];
    });
    for (const matched of matches.slice(1)) assert.deepEqual(matched, matches[0]);
  }
  put(root, 'tsconfig.json', '// JSONC\n{"compilerOptions":{"strict":true,},}\n');
  parity(providers, file);
  for (const provider of providers) {
    assert.equal(slash(provider.findTsconfig(join(root, 'src'))), slash(file));
    assert.deepEqual(snapshot(provider.getTsconfig(root).config), snapshot(provider.parseTsconfig(file)));
  }
}

function errorsAndCache(providers, root) {
  const file = put(root, 'tsconfig.json', {});
  parity(providers, join(root, 'missing.json'));
  for (const config of ['"scalar"', 'null', 'false', '[]', '{"compilerOptions":', { extends: './missing.json' }, { extends: './loop.json' }]) {
    put(root, 'loop.json', { extends: './tsconfig.json' });
    put(root, 'tsconfig.json', config);
    parity(providers, file);
  }
  for (const provider of providers) {
    put(root, 'tsconfig.json', { compilerOptions: { strict: true } });
    const cache = new Map();
    const first = provider.parseTsconfig(file, cache);
    const original = snapshot(first);
    first.compilerOptions.strict = false;
    assert.deepEqual(snapshot(provider.parseTsconfig(file, cache)), original, 'Parsed objects must not be cached');
    put(root, 'tsconfig.json', { compilerOptions: { strict: false } });
    assert.deepEqual(snapshot(provider.parseTsconfig(file, cache)), original, 'Caller-owned fs cache retains stable behavior');
    assert.equal(provider.parseTsconfig(file).compilerOptions.strict, false);
    cache.clear();
    assert.equal(provider.parseTsconfig(file, cache).compilerOptions.strict, false);
  }
  // Stable public parsing must continue to read package metadata through its
  // caller-owned cache, without acquiring Node's process-wide package cache.
  for (const [index, provider] of providers.entries()) {
    const project = join(root, 'metadata-' + index);
    const config = put(project, 'tsconfig.json', { extends: '@fixture/cached' });
    const manifest = { name: '@fixture/cached', exports: { '.': './a.json' } };
    put(project, 'node_modules/@fixture/cached/package.json', manifest);
    put(project, 'node_modules/@fixture/cached/a.json', { compilerOptions: { strict: true } });
    put(project, 'node_modules/@fixture/cached/b.json', { compilerOptions: { strict: false } });
    const cache = new Map();
    assert.equal(provider.parseTsconfig(config, cache).compilerOptions.strict, true);
    manifest.exports['.'] = './b.json';
    put(project, 'node_modules/@fixture/cached/package.json', manifest);
    assert.equal(provider.parseTsconfig(config, cache).compilerOptions.strict, true);
    assert.equal(provider.parseTsconfig(config).compilerOptions.strict, false);
    cache.clear();
    assert.equal(provider.parseTsconfig(config, cache).compilerOptions.strict, false);
  }
}

export function graph(root) {
  const raw = { extends: ['./left/a.json', './right/b.json'], references: [{ path: './absent' }] };
  const file = put(root, 'tsconfig.json', raw);
  const a = put(root, 'left/a.json', { extends: '../common.json', compilerOptions: { outDir: './out-a' } });
  const b = put(root, 'right/b.json', { extends: '../common.json', compilerOptions: { baseUrl: './src', paths: { '@/*': ['*'] }, outDir: './out-b' } });
  const common = put(root, 'common.json', { compilerOptions: { strict: true, declarationDir: './types', paths: { '@shared/*': ['./shared/*'] } } });
  return { raw, file, a, b, common, sources: [file, b, common, a] };
}

function exactSources(providers, root) {
  const expected = graph(root);
  parity(providers, expected.file);
  const provider = providers.at(-1);
  const cache = new Map([['caller-sentinel', join(root, 'not-a-config.json')]]);
  for (let call = 0; call < 2; call++) {
    const result = provider.readTsconfig(expected.file, cache);
    assert.equal(result.then, undefined);
    assert.equal(result.path, slash(expected.file));
    assert.deepEqual(result.sources, expected.sources.map(slash));
    assert.deepEqual(snapshot(result.config), snapshot(provider.parseTsconfig(expected.file, cache)));
    result.sources.length = 0;
    result.config.compilerOptions.strict = false;
  }
  const other = put(root, 'other.json', {});
  assert.deepEqual(provider.readTsconfig(other, cache).sources, [slash(other)]);
  put(root, 'common.json', { compilerOptions: { strict: false } });
  assert.equal(provider.readTsconfig(expected.file).config.compilerOptions.strict, false);
  assert.equal(provider.readTsconfig(expected.file, cache).config.compilerOptions.strict, true);
  cache.clear();
  assert.equal(provider.readTsconfig(expected.file, cache).config.compilerOptions.strict, false);
  put(root, 'tsconfig.json', { extends: ['./left/a.json', './right/b.json', './left/a.json'] });
  parity(providers, expected.file);
  assert.deepEqual(provider.readTsconfig(expected.file).sources, [expected.file, expected.a, expected.common, expected.b].map(slash));
  put(root, 'node_modules/@fixture/meta/package.json', { name: '@fixture/meta', main: './index.cjs', tsconfig: './custom.json' });
  put(root, 'node_modules/@fixture/meta/index.cjs', 'module.exports = {};\n');
  const base = put(root, 'node_modules/@fixture/meta/custom.json', { compilerOptions: { baseUrl: './src' } });
  put(root, 'tsconfig.json', { extends: '@fixture/meta' });
  parity(providers, expected.file);
  assert.deepEqual(provider.readTsconfig(expected.file).sources, [expected.file, base].map(slash));
  // Explicit metadata-as-config is included; resolver metadata reads are not.
  const explicit = put(root, 'explicit/package.json', { compilerOptions: { strict: true } });
  put(root, 'tsconfig.json', { extends: './explicit/package.json' });
  assert.deepEqual(provider.readTsconfig(expected.file).sources, [expected.file, explicit].map(slash));
}

function nodeResolution(providers, root) {
  put(root, 'package.json', { name: '@fixture/self', exports: { '.': './self.json' } });
  const self = put(root, 'self.json', { compilerOptions: { strict: true } });
  const file = put(root, 'tsconfig.json', { extends: '@fixture/node' });
  put(root, 'node_modules/@fixture/node/package.json', {
    name: '@fixture/node', exports: { '.': { node: './base.json' }, './sub': { node: './sub.json' }, './private.json': null },
    tsconfig: './private.json',
  });
  const base = put(root, 'node_modules/@fixture/node/base.json', { compilerOptions: { strict: true } });
  const sub = put(root, 'node_modules/@fixture/node/sub.json', { compilerOptions: { checkJs: true } });
  put(root, 'node_modules/@fixture/node/private.json', {});
  // The stable parse API stays unchanged. Only readTsconfig adds Node exports.
  for (const provider of providers) assert.throws(() => provider.parseTsconfig(file), /not found/);
  const corrected = providers.at(-1);
  assert.deepEqual(corrected.readTsconfig(file).sources, [file, base].map(slash));
  put(root, 'tsconfig.json', { extends: '@fixture/node/sub' });
  assert.deepEqual(corrected.readTsconfig(file).sources, [file, sub].map(slash));
  put(root, 'tsconfig.json', { extends: '@fixture/node/private.json' });
  parity(providers, file);
  assert.throws(() => corrected.readTsconfig(file), /not found/);
  put(root, 'node_modules/@fixture/types/package.json', { name: '@fixture/types', exports: { '.': { types: './base.json' } } });
  put(root, 'node_modules/@fixture/types/base.json', { compilerOptions: { outDir: './out' } });
  put(root, 'tsconfig.json', { extends: '@fixture/types' });
  parity(providers, file);
  put(root, 'tsconfig.json', { extends: '@fixture/self' });
  for (const provider of providers) assert.throws(() => provider.parseTsconfig(file), /not found/);
  assert.deepEqual(corrected.readTsconfig(file).sources, [file, self].map(slash));
}

function pnpAndPure(providers, root) {
  const original = Module.findPnpApi;
  const file = put(root, 'tsconfig.json', { extends: '@fixture/pnp' });
  const manifest = put(root, 'pnp/package.json', { tsconfig: './base.json' });
  const base = put(root, 'pnp/base.json', {});
  try {
    Module.findPnpApi = () => ({ resolveRequest: () => manifest });
    parity(providers, file);
    assert.deepEqual(providers.at(-1).readTsconfig(file).sources, [file, base].map(slash));
  } finally {
    if (original === undefined) delete Module.findPnpApi;
    else Module.findPnpApi = original;
  }
  put(root, 'tsconfig.json', { references: [{ path: './missing-reference' }], compilerOptions: { paths: { '@/*': ['./src/*'] } } });
  parity(providers, file);
  assert.deepEqual(providers.at(-1).readTsconfig(file).sources, [slash(file)]);
}

export async function qualifyBuild({ published, pristine, corrected }) {
  // Poison before loading either runtime, so pure parsing cannot bind TS APIs.
  put(corrected, 'node_modules/typescript/package.json', { name: 'typescript', type: 'module', exports: './index.js' });
  put(corrected, 'node_modules/typescript/index.js', "throw new Error('Provider loaded a TypeScript API');\n");
  for (const format of ['mjs', 'cjs']) {
    const providers = [];
    for (const stage of [published, pristine, corrected]) {
      const entry = join(stage, 'dist/index.' + format);
      providers.push(format === 'mjs' ? await import(pathToFileURL(entry).href) : createRequire(import.meta.url)(entry));
    }
    for (const provider of providers) for (const name of stableNames) assert.equal(typeof provider[name], 'function');
    for (const run of [stableParity, errorsAndCache, exactSources, nodeResolution, pnpAndPure]) await fixture(root => run(providers, root));
  }
  return [...sourceCases, 'ts7-type-contract', 'esm-cjs', 'determinism'];
}

let prepared;
async function prepareSource() {
  // The Bun runner delegates to parent-selected Node, whose child guard checks
  // the exact catalog version before any stateful operation.
  prepared ??= Promise.resolve().then(() => JSON.parse(command('node', [join(sourceRoot, 'generate.mjs'), '--verify-source'], repo)));
  return await prepared;
}
export async function sourceContract(name) {
  const result = await prepareSource();
  assert.ok(result.cases.includes(name), 'Missing executed behavioral acceptance: ' + name);
}

export async function patchFormatContract() {
  await fixture(root => {
    for (const [before, after] of [['first\nlast', 'first\ncorrected\n'], ['same', 'same\n'], ['first\nlast\n', 'changed\nlast\n']]) {
      const file = put(root, 'sample.js', before);
      applyPatch(root, filePatch('sample.js', before, after));
      assert.equal(read(file), after);
    }
  });
}

function packageIdentity(entry) {
  let directory = dirname(entry);
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Resolved module has no package identity');
    directory = parent;
  }
  return { directory, manifest: json(join(directory, 'package.json')) };
}

async function installedConsumer() {
  const receipt = loadInputs();
  const consumer = loadConsumerInputs();
  const docs = json(join(repo, 'docs-site/package.json'));
  const patch = read(join(repo, 'docs-site', patchRelative));
  const expected = await prepareSource();
  assert.equal(sha256(patch), expected.patchSha256, 'Installed binding must use the current canonical generated patch');
  assert.deepEqual(bindManifest(docs, patch), docs, 'Generate and bind the real provider patch before installed acceptance');
  const owner = createRequire(join(repo, 'docs-site/package.json'));
  const astro = owner.resolve('astro/package.json');
  assert.equal(json(astro).version, consumerVersion);
  assert.equal(read(astro), consumer.inputs['package/package.json'], 'Preserve the exact public Astro package metadata');
  assert.equal(read(join(dirname(astro), 'LICENSE')), consumer.inputs['package/LICENSE'], 'Preserve the public consumer license');
  const entry = join(dirname(astro), 'dist/core/config/tsconfig.js');
  assert.equal(read(entry), consumer.inputs['package/dist/core/config/tsconfig.js'], 'Preserve the exact public Astro 7.4.2 runtime consumer');
  assert.equal(read(join(dirname(entry), 'tsconfig.d.ts')), consumer.inputs['package/dist/core/config/tsconfig.d.ts'], 'Preserve the exact public Astro 7.4.2 declarations');
  if (!globalThis.Bun?.resolveSync) throw new Error('Run installed contracts through owning Bun test runner');
  const providerEntry = Bun.resolveSync('get-tsconfig', dirname(entry));
  const { directory, manifest } = packageIdentity(providerEntry);
  assert.equal(manifest.name, 'get-tsconfig');
  assert.equal(manifest.version, '4.14.3');
  assert.deepEqual(manifest.dependencies, receipt.packages['get-tsconfig'].manifest.value.dependencies);
  assert.equal(manifest.peerDependencies?.typescript, undefined);
  for (const file of ['dist/index.mjs', 'dist/index.cjs', 'dist/index.d.mts', 'dist/index.d.cts']) {
    assert.equal(sha256(readFileSync(join(directory, file))), expected.outputSha256[file], 'Installed provider differs from canonical generated output');
  }
  const provider = await import(pathToFileURL(providerEntry).href);
  const common = createRequire(entry)('get-tsconfig');
  assert.equal(typeof provider.readTsconfig, 'function');
  assert.equal(typeof common.readTsconfig, 'function');
  const { loadTSConfig } = await import(pathToFileURL(entry).href);
  assert.equal(typeof loadTSConfig, 'function', 'Qualify the actual public consumer API');
  return { load: loadTSConfig, provider, common, providerEntry, astro };
}

export async function installedContract(name) {
  const { load, provider, common, providerEntry, astro } = await installedConsumer();
  await fixture(async root => {
    if (name === 'watch-and-alias') {
      const expected = graph(root);
      const promise = load(root);
      assert.equal(typeof promise.then, 'function');
      const result = await promise;
      assert.equal(result.error, undefined);
      assert.equal(result.tsconfigFile, normalize(expected.file));
      assert.deepEqual(result.rawConfig, expected.raw);
      assert.deepEqual(result.sources, expected.sources.map(normalize));
      assert.deepEqual(provider.createPathsMatcher({ path: result.tsconfigFile, config: result.tsconfig })('@/entry'), [slash(join(root, 'right/src/entry'))]);
      assert.deepEqual(snapshot(common.readTsconfig(expected.file).config), snapshot(result.tsconfig));
      put(root, 'common.json', { compilerOptions: { strict: false } });
      assert.equal((await load(root)).tsconfig.compilerOptions.strict, false);
      return;
    }
    if (name === 'raw-and-errors') {
      put(root, 'tsconfig.json', {});
      mkdirSync(join(root, 'child'));
      assert.deepEqual(await load(join(root, 'child')), { error: 'missing-config' });
      put(root, 'jsconfig.json', {});
      put(root, 'tsconfig.json', '{"compilerOptions":');
      assert.match((await load(root)).message, /^Failed to parse .*Malformed JSONC/);
      put(root, 'tsconfig.json', { extends: './missing.json' });
      assert.equal((await load(root)).error, 'invalid-config');
      assert.match((await load(root)).message, /^Failed to resolve /);
      put(root, 'tsconfig.json', '"scalar"');
      assert.equal((await load(root)).error, 'invalid-config');
      return;
    }
    if (name === 'jsconfig-and-metadata') {
      const raw = { extends: '@fixture/config' };
      const file = put(root, 'jsconfig.json', raw);
      put(root, 'node_modules/@fixture/config/package.json', { name: '@fixture/config', main: './entry.cjs', tsconfig: './custom.json' });
      put(root, 'node_modules/@fixture/config/entry.cjs', 'module.exports = {};\n');
      const base = put(root, 'node_modules/@fixture/config/custom.json', { compilerOptions: { baseUrl: './lib', paths: { '@pkg/*': ['*'] } } });
      const result = await load(root);
      assert.equal(result.error, undefined);
      assert.equal(result.tsconfigFile, normalize(file));
      assert.deepEqual(result.rawConfig, raw);
      assert.deepEqual(result.sources, [file, base].map(normalize));
      assert.deepEqual(provider.createPathsMatcher({ path: file, config: result.tsconfig })('@pkg/entry'), [slash(join(dirname(base), 'lib/entry'))]);
      return;
    }
    if (name === 'no-compiler-binding') {
      const local = createRequire(providerEntry);
      let compiler;
      try { compiler = local.resolve('typescript/package.json'); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
      if (compiler) {
        assert.equal(json(compiler).version, json(join(repo, 'config/toolchains/node-typescript.json')).typescript);
        assert.equal(realpathSync(compiler), realpathSync(join(repo, 'node_modules/typescript/package.json')), 'No new provider compiler binding');
      }
      const maps = packageIdentity(local.resolve('resolve-pkg-maps')).manifest;
      assert.equal(maps.name, 'resolve-pkg-maps');
      assert.equal(maps.version, '1.0.0');
      assert.deepEqual(maps.dependencies ?? {}, {});
      assert.equal(maps.peerDependencies?.typescript, undefined);
      const errors = [];
      const lock = createRequire(astro)('jsonc-parser').parse(read(join(repo, 'docs-site/bun.lock')), errors, { allowTrailingComma: true });
      assert.equal(errors.length, 0);
      for (const record of Object.values(lock.packages)) assert.doesNotMatch(record[0], /(?:^|npm:)(?:typescript@[56]\.|@typescript\/typescript6@)/, 'Docs introduced an unapproved compiler');
      const file = put(root, 'tsconfig.json', { references: [{ path: './absent' }] });
      assert.equal(provider.readTsconfig(file).then, undefined);
      assert.equal(common.readTsconfig(file).then, undefined);
      assert.equal((await load(root)).error, undefined);
      return;
    }
    throw new Error('Unknown installed contract: ' + name);
  });
}

// Lowest-layer security regressions use only isolated fixtures and injected
// process results. They never execute a child, compiler, generator or Git.
export const securityCases = ['canonical-inputs', 'receipt-confinement', 'link-confinement', 'cleanup-ownership', 'command-diagnostics', 'consumer-parent-binding', 'consumer-public-inputs', 'consumer-rolldown-catalog'];

export async function securityContract(name) {
  if (name === 'consumer-parent-binding') {
    const docs = {
      catalog: { astro: '7.4.2', 'get-tsconfig': '4.14.3', rolldown: '1.2.15' },
      dependencies: { astro: 'catalog:' }, devDependencies: { rolldown: 'catalog:' },
      overrides: {
        'astro@7.4.1': { 'get-tsconfig': 'catalog:' },
        postcss: { '.': 'catalog:', nanoid: 'catalog:' },
        'astro@7.4.2': { svgo: 'catalog:' },
      },
      patchedDependencies: { '@fixture/other@1.0.0': 'patches/other.patch' },
    };
    const original = structuredClone(docs);
    const previousParent = structuredClone(docs);
    previousParent.catalog.astro = '7.4.1';
    const unchanged = JSON.stringify(previousParent);
    const staged = prepareConsumerManifest(previousParent);
    assert.equal(staged.catalog.astro, '7.4.2');
    assert.equal(JSON.stringify(previousParent), unchanged, 'Staging cannot publish or mutate the active parent');
    assert.deepEqual(staged.overrides, previousParent.overrides, 'Catalog and binding are published together after generation');
    for (const mutate of [
      pkg => { delete pkg.overrides['astro@7.4.1']; },
      pkg => { pkg.catalog.astro = '7.4.0'; },
      pkg => { pkg.catalog.astro = '7.4.2-beta.1'; },
    ]) {
      const candidate = structuredClone(previousParent);
      mutate(candidate);
      assert.throws(() => prepareConsumerManifest(candidate));
    }
    const bound = bindConsumerManifest(docs);
    assert.deepEqual(docs, original, 'Binding must not mutate caller-owned metadata');
    assert.equal(bound.overrides['astro@7.4.1'], undefined);
    assert.deepEqual(bound.overrides['astro@7.4.2'], { svgo: 'catalog:', 'get-tsconfig': 'catalog:' });
    assert.deepEqual(bound.overrides.postcss, original.overrides.postcss);
    assert.equal(bound.patchedDependencies['@fixture/other@1.0.0'], 'patches/other.patch');
    assert.equal(bound.patchedDependencies['get-tsconfig@4.14.3'], patchRelative);
    assert.deepEqual(bindConsumerManifest(bound), bound, 'Final generator binding is idempotent');
    const fresh = structuredClone(docs);
    delete fresh.overrides['astro@7.4.1'];
    assert.deepEqual(bindConsumerManifest(fresh), bound);
    const rejected = (mutate, expression) => {
      const candidate = structuredClone(docs);
      mutate(candidate);
      const snapshot = structuredClone(candidate);
      assert.throws(() => bindConsumerManifest(candidate), expression);
      assert.deepEqual(candidate, snapshot, 'Rejected binding must preserve all input rules');
    };
    rejected(pkg => { pkg.catalog.astro = '7.4.1'; }, /owning Astro/);
    rejected(pkg => { pkg.catalog.astro = '^7.4.2'; }, /owning Astro/);
    rejected(pkg => { pkg.catalog['get-tsconfig'] = '5.0.0-beta.6'; }, /owning Astro/);
    rejected(pkg => { pkg.dependencies.astro = '7.4.2'; }, /owning Astro/);
    rejected(pkg => { pkg.overrides['astro@7.4.1'].svgo = 'catalog:'; }, /prior Astro/);
    rejected(pkg => { pkg.overrides['astro@7.4.1']['get-tsconfig'] = '5.0.0-beta.6'; }, /prior Astro/);
    rejected(pkg => { pkg.overrides['astro@7.4.2'] = 'catalog:'; }, /exact Astro/);
    rejected(pkg => { pkg.overrides['astro@7.4.2']['get-tsconfig'] = '5.0.0-beta.6'; }, /stable provider/);
    rejected(pkg => { pkg.patchedDependencies['get-tsconfig@4.14.3'] = 'foreign.patch'; }, /provider patch/);
    for (const selector of ['astro@7.4.1', 'astro@7.4.2', 'tsconfck@3.1.6']) {
      rejected(pkg => { pkg.patchedDependencies[selector] = 'retired.patch'; }, /remain inactive/);
    }
    for (const selector of ['tsconfck', 'tsconfck@3.1.6']) {
      rejected(pkg => { pkg.overrides[selector] = 'catalog:'; }, /remain inactive/);
    }
    return;
  }
  if (name === 'consumer-public-inputs') {
    consumerArchiveMembers([...consumerMembers, 'package/other-public-file.js']);
    for (const members of [undefined, [], consumerMembers.slice(1), [...consumerMembers, consumerMembers[0]], [...consumerMembers, 42]]) {
      assert.throws(() => consumerArchiveMembers(members), /missing or duplicated/);
    }
    // Metadata fixtures describe observed registry identity, not an invented
    // consumer API or a replacement for the actual installed contracts.
    const original = { name: 'astro', version: '7.4.2', type: 'module', dependencies: { 'get-tsconfig': '5.0.0-beta.6' } };
    assert.equal(consumerPackageMetadata(original), original);
    for (const mutate of [
      pkg => { pkg.name = 'other'; }, pkg => { pkg.version = '7.4.1'; },
      pkg => { pkg.type = 'commonjs'; }, pkg => { pkg.dependencies['get-tsconfig'] = '4.14.3'; },
    ]) {
      const candidate = structuredClone(original);
      mutate(candidate);
      assert.throws(() => consumerPackageMetadata(candidate), /public Astro/);
    }
    for (const bytes of [undefined, '', Buffer.alloc(0), Buffer.from('PRIVATE_ARCHIVE_SENTINEL'), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
      let failure;
      assert.throws(() => verifyConsumerArchive(bytes), error => { failure = error; return true; });
      const messages = [];
      reportPreparationError(failure, message => messages.push(message));
      assert.equal(messages.length, 1);
      assert.match(messages[0], /integrity-verified public Astro 7\.4\.2/);
      assert.doesNotMatch(messages[0], /PRIVATE_ARCHIVE_SENTINEL/);
    }
    // Missing archive must fail before staging; valid-archive extraction and
    // the new consumer API remain real-input gates for the serial controller.
    return;
  }
  if (name === 'consumer-rolldown-catalog') {
    const pkg = { catalog: { astro: '7.4.2', 'get-tsconfig': '4.14.3', rolldown: '1.2.15' }, dependencies: { astro: 'catalog:' }, devDependencies: { rolldown: 'catalog:' } };
    consumerCatalog(pkg);
    rolldownCatalog(pkg, { name: 'rolldown', version: '1.2.15' });
    for (const tool of [{ name: 'rolldown', version: '1.2.14' }, { name: 'other', version: '1.2.15' }]) {
      assert.throws(() => rolldownCatalog(pkg, tool), /owning catalog Rolldown/);
    }
    for (const mutate of [
      candidate => { candidate.catalog.rolldown = '1.2.14'; },
      candidate => { candidate.catalog.rolldown = '^1.2.15'; },
      candidate => { candidate.devDependencies.rolldown = '1.2.15'; },
    ]) {
      const candidate = structuredClone(pkg);
      mutate(candidate);
      assert.throws(() => rolldownCatalog(candidate, { name: 'rolldown', version: '1.2.15' }), /owning Astro/);
    }
    return;
  }
  if (name === 'cleanup-ownership') {
    await fixture(async outer => {
      const original = ownedTemporaryDirectory(outer, 'original-');
      const foreign = ownedTemporaryDirectory(outer, 'foreign-');
      const parked = join(outer, 'parked-original');
      put(original.path, 'owned.txt', 'OWNED_DIRECTORY_SENTINEL\n');
      put(foreign.path, 'foreign.txt', 'FOREIGN_DIRECTORY_SENTINEL\n');
      renameSync(original.path, parked);
      renameSync(foreign.path, original.path);
      try {
        // Match the generator's awaited-work boundary before cleanup.
        await Promise.resolve();
        assert.throws(() => original.remove(), /ownership changed.*refused/);
        assert.equal(read(join(original.path, 'foreign.txt')), 'FOREIGN_DIRECTORY_SENTINEL\n');
        assert.equal(read(join(parked, 'owned.txt')), 'OWNED_DIRECTORY_SENTINEL\n');
      } finally {
        // Restore both identities before asking their own cleaners to remove.
        renameSync(original.path, foreign.path);
        renameSync(parked, original.path);
        foreign.remove();
        original.remove();
      }
      assert.equal(existsSync(original.path), false);
      assert.equal(existsSync(foreign.path), false);
    });
    return;
  }
  if (name === 'canonical-inputs') {
    const receipt = loadInputs();
    assert.equal(Object.keys(receipt.inputSha256).length, 305);
    for (const file of [...Object.keys(receipt.inputSha256), ...Object.keys(receipt.consumer.inputs)]) assert.equal(canonicalRelativePath(file), file);
    for (const file of [
      '../outside', 'a/../../outside', 'a/./b', 'a//b', 'a\\..\\marker', 'a/..\\marker',
      '/outside', 'C:\\outside', 'C:outside', '\\\\server\\share\\marker', '//server/share/marker',
      'a/marker:stream', 'a/NUL', 'a/dir.', 'a/dir ', 'a/\u0000marker', 'a/b\nmarker',
    ]) assert.throws(() => canonicalRelativePath(file), /canonical|portable/);
    await fixture(root => {
      const stage = join(root, 'stage');
      stageInputs(stage, receipt, false);
      assert.equal(json(join(stage, 'package.json')).type, 'module');
      assert.equal(json(join(stage, 'node_modules/@yarnpkg/pnp/package.json')).name, '@yarnpkg/pnp');
      assert.equal(json(join(stage, 'node_modules/slash/package.json')).version, receipt.packages.slash.version);
      assert.equal(read(join(stage, 'src/index.ts')), read(confinedPath(sourceRoot, 'stable4/upstream/get-tsconfig/src/index.ts')));
    });
    return;
  }
  if (name === 'receipt-confinement') {
    const original = loadInputs();
    await fixture(root => {
      const marker = put(root, 'package.json', 'OUTSIDE_STAGE_SENTINEL\n');
      let sequence = 0;
      const rejected = receipt => {
        const stage = join(root, 'stage-' + sequence++);
        assert.throws(() => stageInputs(stage, receipt, false), /identity|canonical|portable|immutable/);
        assert.equal(existsSync(stage), false, 'Validate the whole receipt before creating the stage');
        assert.equal(read(marker), 'OUTSIDE_STAGE_SENTINEL\n');
      };
      for (const badName of ['../..', 'x\\..\\..', '@scope/../escape', '@scope/name/extra',
        'C:outside', 'Other', 'node_modules', 'favicon.ico', '@scope/nul', 'foo.', 'x'.repeat(215), 'another-package']) {
        const receipt = structuredClone(original);
        receipt.packages.slash.name = badName;
        rejected(receipt);
      }
      for (const field of ['name', 'version']) {
        const receipt = structuredClone(original);
        receipt.packages.slash.manifest.value[field] = 'disagrees';
        rejected(receipt);
      }
      {
        const receipt = structuredClone(original);
        receipt.packages.slash.version = '../..';
        receipt.packages.slash.manifest.value.version = '../..';
        rejected(receipt);
      }
      {
        const receipt = structuredClone(original);
        receipt.packages.renamed = receipt.packages.slash;
        delete receipt.packages.slash;
        rejected(receipt);
      }
      for (const file of [
        'stable4/upstream/npm/x/..\\..\\..\\marker',
        'stable4/upstream/npm/x/../marker',
        'stable4/upstream/npm/x/PACKAGE.JSON',
      ]) {
        const receipt = structuredClone(original);
        receipt.inputSha256[file] = '0'.repeat(64);
        rejected(receipt);
      }
      {
        const receipt = structuredClone(original);
        receipt.consumer.inputs['upstream/astro/..\\..\\marker'] = '0'.repeat(64);
        rejected(receipt);
      }
      for (const file of ['../package.json', '..\\package.json', 'a/../../package.json', 'C:\\outside', '/outside']) {
        const stage = join(root, 'direct-' + sequence++);
        assert.throws(() => put(stage, file, 'changed'), /canonical|portable|escapes/);
        assert.equal(existsSync(stage), false);
        assert.equal(read(marker), 'OUTSIDE_STAGE_SENTINEL\n');
      }
    });
    return;
  }
  if (name === 'link-confinement') {
    await fixture(async outer => {
      const marker = put(outer, 'outside/sentinel.txt', 'OUTSIDE_LINK_SENTINEL\n');
      await fixture(stage => {
        const link = join(stage, 'linked');
        symlinkSync(dirname(marker), link, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => confinedPath(stage, 'linked/sentinel.txt'), /link|junction/);
        assert.throws(() => put(stage, 'linked/sentinel.txt', 'changed'), /link|junction/);
        assert.throws(() => put(link, 'sentinel.txt', 'changed'), /link|junction/);
        assert.throws(() => put(join(link, 'new-root'), 'sentinel.txt', 'changed'), /link|junction/);
        assert.equal(existsSync(join(dirname(marker), 'new-root')), false);
        assert.equal(read(marker), 'OUTSIDE_LINK_SENTINEL\n');
        const absent = join(outer, 'dangling-target');
        mkdirSync(absent);
        symlinkSync(absent, join(stage, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
        rmSync(absent, { recursive: true });
        assert.throws(() => put(stage, 'dangling/sentinel.txt', 'changed'), /link|junction/);
        assert.equal(existsSync(absent), false);
      });
      // Removing the inner owned fixture must not traverse the junction target.
      assert.equal(read(marker), 'OUTSIDE_LINK_SENTINEL\n');
    });
    return;
  }
  if (name === 'command-diagnostics') {
    const privatePosix = '/PRIVATE_PATH_SENTINEL/project/source.ts';
    const privateWindows = 'C:\\PRIVATE_PATH_SENTINEL\\temp\\source.ts';
    const messages = [];
    const render = error => {
      const lines = [];
      const message = reportPreparationError(error, line => lines.push(line));
      assert.deepEqual(lines, [message]);
      assert.doesNotMatch(message, /PRIVATE_PATH_SENTINEL|PRIVATE_SPAWN_MESSAGE|PRIVATE_CHILD_TEXT/);
      assert.equal(message.includes(privatePosix), false);
      assert.equal(message.includes(privateWindows), false);
      messages.push(message);
      return message;
    };
    const failed = (file, args, result) => {
      let failure;
      assert.throws(() => command(file, args, sourceRoot, undefined, () => result), error => { failure = error; return true; });
      return render(failure);
    };
    const compiler = failed('/PRIVATE_PATH_SENTINEL/bin/node', ['/PRIVATE_PATH_SENTINEL/typescript/bin/tsc'], {
      status: 2, stdout: privatePosix + ' PRIVATE_CHILD_TEXT TS2345\n', stderr: privateWindows + ' PRIVATE_CHILD_TEXT TS2322\n',
    });
    assert.match(compiler, /TypeScript CLI failed \(exit 2\)/);
    assert.match(compiler, /TS2345/);
    assert.match(compiler, /TS2322/);
    assert.match(failed('node', ['input'], { status: 7, stdout: privatePosix, stderr: '' }), /Node failed \(exit 7\)/);
    assert.match(failed('git', ['apply', '-'], { status: 1, stdout: '', stderr: privateWindows }), /Git failed \(exit 1\)/);
    const spawnError = Object.assign(new Error('PRIVATE_SPAWN_MESSAGE ' + privatePosix + privateWindows), {
      code: 'ENOENT', path: privateWindows, spawnargs: [privatePosix],
    });
    assert.match(failed('node', [], { error: spawnError }), /Node could not complete \(ENOENT\)/);
    {
      let failure;
      assert.throws(() => command('git', [], sourceRoot, undefined, () => { throw spawnError; }), error => { failure = error; return true; });
      assert.match(render(failure), /Git could not complete \(ENOENT\)/);
    }
    assert.match(failed('git', [], { status: null, signal: 'SIGTERM', stdout: privatePosix, stderr: privateWindows }), /SIGTERM/);
    failed('git', [], { status: null, signal: privateWindows, stdout: privatePosix, stderr: privateWindows });
    failed('node', [], { error: Object.assign(new Error(privatePosix), { code: privateWindows }) });
    render(Object.assign(new Error(privatePosix + privateWindows), { code: 'EACCES' }));
    const success = '{"ok":true}';
    assert.equal(command('node', [], sourceRoot, undefined, () => ({ status: 0, stdout: success, stderr: privateWindows })), success);
    assert.ok(messages.length >= 9);
    return;
  }
  throw new Error('Unknown security contract');
}
