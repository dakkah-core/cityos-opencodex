// Behavioral contracts run later by the existing toolchain-catalogs Bun suite.
// No compiler API and no installed package is modified by these fixtures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindManifest, filePatch, loadInputs, sourceRoot } from './generate.mjs';

const repo = resolve(sourceRoot, '../../..');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

function put(root, path, value) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'ocx-config-contract-'));
  try { return await run(root); }
  finally {
    if (dirname(root) !== tmpdir() || !root.startsWith(join(tmpdir(), 'ocx-config-contract-'))) throw new Error('Fixture ownership changed');
    rmSync(root, { recursive: true, force: true });
  }
}

async function sourceProvider(root) {
  loadInputs();
  const stage = join(root, 'provider');
  put(stage, 'package.json', { private: true, type: 'module' });
  for (const file of ['cache.js', 'find.js', 'to-json.js', 'util.js']) {
    mkdirSync(join(stage, 'src'), { recursive: true });
    copyFileSync(join(sourceRoot, 'upstream/tsconfck/src', file), join(stage, 'src', file));
  }
  copyFileSync(join(sourceRoot, 'source/tsconfck/parse.js'), join(stage, 'src/parse.js'));
  const { parse } = await import(pathToFileURL(join(stage, 'src/parse.js')).href);
  const { TSConfckCache } = await import(pathToFileURL(join(stage, 'src/cache.js')).href);
  return { parse, TSConfckCache, stage };
}

const sources = (result) => [...new Set((result.extended ?? [result]).map((entry) => normalize(entry.tsconfigFile)))];

export async function patchFormatContract() {
  return fixture(async (root) => {
    for (const [before, after] of [
      ['first\nlast', 'first\ncorrected\n'],
      ['same', 'same\n'],
      ['first\nlast\n', 'changed\nlast\n'],
    ]) {
      const file = put(root, 'sample.js', before);
      const patch = filePatch('sample.js', before, after);
      const result = spawnSync('git', ['apply', '-'], { cwd: root, input: patch, encoding: 'utf8', windowsHide: true });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(file, 'utf8'), after);
    }
  });
}

export async function sourceContract(name) {
  return fixture(async (root) => {
    const { parse, TSConfckCache, stage } = await sourceProvider(root);
    const project = join(root, 'project');
    if (name === 'pure-without-ts-api') {
      const receipt = loadInputs();
      assert.deepEqual(receipt.packages.tsconfck.manifest.peerDependencies, { typescript: '^5.0.0' });
      assert.deepEqual(receipt.packages.tsconfck.manifest.peerDependenciesMeta, { typescript: { optional: true } });
      const docs = read(join(repo, 'docs-site/package.json'));
      const bound = bindManifest(docs, receipt);
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        assert.equal(bound[field]?.typescript, docs[field]?.typescript);
        assert.equal(bound[field]?.typescript, undefined, 'This migration must not add a compiler dependency to docs');
      }
      assert.equal(bound.overrides.typescript, undefined);
      assert.equal(bound.overrides['astro@7.4.1'].typescript, undefined);
      assert.equal(bound.overrides.tsconfck, undefined);
      const file = put(project, 'tsconfig.json', { compilerOptions: { paths: { '@/*': ['./src/*'] } } });
      assert.equal((await parse(file, { ignoreReferences: true })).tsconfigFile, file);
      // A deliberate fixture poison, not an installed compiler or toolchain pin.
      put(stage, 'node_modules/typescript/package.json', { name: 'typescript', type: 'module', exports: './index.js' });
      put(stage, 'node_modules/typescript/index.js', "throw new Error('Pure parser loaded a TypeScript compiler API');\n");
      assert.equal((await parse(file, { ignoreReferences: true })).tsconfigFile, file);
      return;
    }
    if (name === 'references') {
      const file = put(project, 'tsconfig.json', { references: [{ path: './absent' }], compilerOptions: { paths: { '@/*': ['./src/*'] } } });
      const cache = new TSConfckCache();
      await assert.rejects(parse(file, { cache }), { code: 'PARSE_FILE' });
      const result = await parse(file, { cache, ignoreReferences: true });
      assert.equal(result.tsconfigFile, file);
      assert.equal(result.referenced, undefined);
      assert.deepEqual(result.tsconfig.compilerOptions.paths, { '@/*': ['./src/*'] });
      put(project, 'absent/tsconfig.json', { compilerOptions: { baseUrl: './src' } });
      const normal = await parse(file);
      assert.equal(normal.referenced.length, 1);
      return;
    }
    if (name === 'package-metadata') {
      const file = put(project, 'tsconfig.json', { extends: '@fixture/config' });
      put(project, 'node_modules/@fixture/config/package.json', { name: '@fixture/config', main: './index.js', tsconfig: './configs/base.json' });
      put(project, 'node_modules/@fixture/config/index.js', 'module.exports = {};\n');
      const base = put(project, 'node_modules/@fixture/config/configs/base.json', { compilerOptions: { baseUrl: './lib', paths: { '@pkg/*': ['*'] } } });
      put(project, 'node_modules/@fixture/config/tsconfig.json', { compilerOptions: { baseUrl: './wrong' } });
      const result = await parse(file, { ignoreReferences: true });
      assert.equal(normalize(result.tsconfig.compilerOptions.baseUrl), join(dirname(base), 'lib'));
      assert.deepEqual(sources(result), [file, base].map(normalize));
      // Metadata cannot override an exports map, even if package.json is public.
      const blocked = put(project, 'blocked.json', { extends: '@fixture/blocked' });
      put(project, 'node_modules/@fixture/blocked/package.json', {
        name: '@fixture/blocked', tsconfig: './configs/base.json',
        exports: { '.': './index.js', './package.json': './package.json', './tsconfig.json': null },
      });
      put(project, 'node_modules/@fixture/blocked/index.js', 'module.exports = {};\n');
      put(project, 'node_modules/@fixture/blocked/configs/base.json', {});
      await assert.rejects(parse(blocked, { ignoreReferences: true }), { code: 'EXTENDS_RESOLVE' });
      return;
    }
    if (name === 'extends-graph') {
      const file = put(project, 'tsconfig.json', '// raw JSONC\n{"extends":["./a.json","./nested/b.json"],"references":[{"path":"./absent"}],}\n');
      const a = put(project, 'a.json', { extends: './shared.json', compilerOptions: { paths: { '@/*': ['left/*'] } } });
      const b = put(project, 'nested/b.json', { extends: '../shared.json', compilerOptions: { baseUrl: './src', paths: { '@/*': ['right/*'] } } });
      const shared = put(project, 'shared.json', { compilerOptions: { strict: true } });
      const result = await parse(file, { ignoreReferences: true });
      assert.deepEqual(sources(result), [file, b, shared, a].map(normalize));
      assert.deepEqual(result.tsconfig.compilerOptions.paths, { '@/*': ['right/*'] });
      assert.equal(normalize(result.tsconfig.compilerOptions.baseUrl), join(project, 'nested/src'));
      put(project, 'shared.json', { compilerOptions: { strict: false } });
      assert.equal((await parse(file, { ignoreReferences: true })).tsconfig.compilerOptions.strict, false);
      put(project, 'a.json', { extends: './tsconfig.json' });
      await assert.rejects(parse(file, { ignoreReferences: true }), { code: 'EXTENDS_CIRCULAR' });
      put(project, 'a.json', '"not a config object"');
      await assert.rejects(parse(file, { ignoreReferences: true }), { code: 'PARSE_FILE' });
      return;
    }
    throw new Error(`Unknown provider contract: ${name}`);
  });
}

async function installedConsumer() {
  const docs = read(join(repo, 'docs-site/package.json'));
  const bound = bindManifest(docs, loadInputs());
  assert.deepEqual(docs, bound, 'Generate BOTH patches and register the exact-parent alias before installed acceptance');
  const owner = createRequire(join(repo, 'docs-site/package.json'));
  const astro = owner.resolve('astro/package.json');
  assert.equal(read(astro).version, docs.catalog.astro);
  const entry = join(dirname(astro), 'dist/core/config/tsconfig.js');
  if (!globalThis.Bun?.resolveSync) throw new Error('Run this installed-consumer helper through the owning Bun test runner');
  const providerEntry = Bun.resolveSync('get-tsconfig', dirname(entry));
  let directory = dirname(providerEntry);
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Resolved provider has no package identity');
    directory = parent;
  }
  const providerManifest = read(join(directory, 'package.json'));
  assert.equal(providerManifest.name, 'tsconfck');
  assert.equal(providerManifest.version, '3.1.6');
  assert.deepEqual(providerManifest.peerDependencies, { typescript: '^5.0.0' });
  assert.deepEqual(providerManifest.peerDependenciesMeta, { typescript: { optional: true } });
  const provider = await import(pathToFileURL(providerEntry).href);
  assert.equal(typeof provider.parse, 'function');
  assert.equal(provider.readTsconfig, undefined);
  const consumer = await import(pathToFileURL(entry).href);
  return { load: consumer.loadTSConfig, providerEntry, astro };
}

export async function installedContract(name) {
  const { load, providerEntry, astro } = await installedConsumer();
  return fixture(async (root) => {
    if (name === 'no-compiler-binding') {
      let compiler;
      try { compiler = Bun.resolveSync('typescript', dirname(providerEntry)); }
      catch (error) {
        if (!['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error;
      }
      if (compiler) {
        let directory = dirname(compiler);
        while (!existsSync(join(directory, 'package.json'))) {
          const parent = dirname(directory);
          if (parent === directory) throw new Error('Resolved TypeScript API has no package identity');
          directory = parent;
        }
        const manifest = join(directory, 'package.json');
        assert.equal(read(manifest).version, read(join(repo, 'config/toolchains/node-typescript.json')).typescript);
        assert.equal(realpathSync(manifest), realpathSync(join(repo, 'node_modules/typescript/package.json')), 'Provider must not acquire a separate compiler binding');
      }
      const jsonc = createRequire(astro)('jsonc-parser');
      const errors = [];
      const lock = jsonc.parse(readFileSync(join(repo, 'docs-site/bun.lock'), 'utf8'), errors, { allowTrailingComma: true });
      assert.equal(errors.length, 0);
      assert.equal(typeof lock.packages, 'object');
      for (const record of Object.values(lock.packages)) {
        assert.equal(typeof record[0], 'string');
        assert.doesNotMatch(record[0], /(?:^|npm:)(?:typescript@[56]\.|@typescript\/typescript6@)/, 'Docs installation introduced an unapproved compiler');
      }
      put(root, 'tsconfig.json', { references: [{ path: './absent' }], compilerOptions: { paths: { '@/*': ['./src/*'] } } });
      assert.equal((await load(root)).error, undefined);
      return;
    }
    if (name === 'watch-and-alias') {
      const raw = { extends: ['./a.json', './nested/b.json'], references: [{ path: './absent' }] };
      const file = put(root, 'tsconfig.json', raw);
      const a = put(root, 'a.json', { extends: './shared.json' });
      const b = put(root, 'nested/b.json', { extends: '../shared.json', compilerOptions: { baseUrl: './src', paths: { '@/*': ['*'] } } });
      const shared = put(root, 'shared.json', { compilerOptions: { strict: true } });
      const promise = load(root);
      assert.equal(typeof promise.then, 'function');
      const result = await promise;
      assert.equal(result.error, undefined);
      assert.equal(result.tsconfigFile, file);
      assert.deepEqual(result.rawConfig, raw);
      assert.deepEqual(result.sources, [file, b, shared, a].map(normalize));
      // Same path interpretation used by Astro's actual alias consumer.
      assert.equal(resolve(dirname(result.tsconfigFile), result.tsconfig.compilerOptions.baseUrl, result.tsconfig.compilerOptions.paths['@/*'][0].replace('*', 'entry.ts')), join(root, 'nested/src/entry.ts'));
      put(root, 'shared.json', { compilerOptions: { strict: false } });
      assert.equal((await load(root)).tsconfig.compilerOptions.strict, false);
      return;
    }
    if (name === 'raw-and-errors') {
      assert.deepEqual(await load(root), { error: 'missing-config' });
      put(root, 'jsconfig.json', {});
      put(root, 'tsconfig.json', '{"compilerOptions":');
      assert.match((await load(root)).message, /^Failed to parse .*Malformed JSONC/);
      put(root, 'tsconfig.json', { extends: './absent.json' });
      const invalid = await load(root);
      assert.equal(invalid.error, 'invalid-config');
      assert.match(invalid.message, /^Failed to resolve /);
      put(root, 'tsconfig.json', '"not an object"');
      assert.equal((await load(root)).error, 'invalid-config');
      return;
    }
    if (name === 'jsconfig-and-metadata') {
      const raw = { extends: '@fixture/config' };
      const file = put(root, 'jsconfig.json', raw);
      put(root, 'node_modules/@fixture/config/package.json', { name: '@fixture/config', tsconfig: './custom.json' });
      const base = put(root, 'node_modules/@fixture/config/custom.json', { compilerOptions: { baseUrl: './lib', paths: { '@pkg/*': ['*'] } } });
      const result = await load(root);
      assert.equal(result.error, undefined);
      assert.equal(result.tsconfigFile, file);
      assert.deepEqual(result.rawConfig, raw);
      assert.deepEqual(result.sources, [file, base].map(normalize));
      assert.equal(normalize(result.tsconfig.compilerOptions.baseUrl), join(dirname(base), 'lib'));
      return;
    }
    throw new Error(`Unknown installed contract: ${name}`);
  });
}
