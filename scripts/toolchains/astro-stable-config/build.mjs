// Canonical inputs and isolated generation support. No compiler API is loaded.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, isAbsolute, join, parse, posix, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const sourceRoot = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(sourceRoot, '../../..');
const overlays = ['index.ts', 'read-tsconfig-types.ts', 'parse-tsconfig/index.ts', 'parse-tsconfig/resolve-extends-path.ts'];
export const read = path => readFileSync(path, 'utf8');
export const json = path => JSON.parse(read(path));
export const sha256 = value => createHash('sha256').update(value).digest('hex');

const publicErrors = new WeakMap();
const diagnosticCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EINVAL', 'ELOOP', 'ENOSPC', 'ENAMETOOLONG', 'EROFS', 'ETIMEDOUT', 'ENOBUFS', 'ENOMEM', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']);
export function preparationError(message) {
  const error = new Error(message);
  publicErrors.set(error, message);
  return error;
}
export function reportPreparationError(error, write = message => console.error(message)) {
  // Only messages constructed in this owner are public. Never forward raw
  // compiler output, filesystem/spawn errors, assertion diffs or error stacks.
  const code = diagnosticCodes.has(error?.code) ? ' (' + error.code + ')' : '';
  const message = publicErrors.has(error) ? publicErrors.get(error) : 'Preparation failed' + code + '; check the owning toolchain, declared inputs and resource limits.';
  write(message);
  return message;
}

export function canonicalRelativePath(file) {
  if (typeof file !== 'string' || !file || posix.isAbsolute(file) || win32.isAbsolute(file) ||
      /[\\\u0000-\u001f\u007f<>:"|?*]/.test(file) || posix.normalize(file) !== file) {
    throw preparationError('Expected a canonical relative POSIX input path');
  }
  for (const part of file.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw preparationError('Expected a portable relative input path');
    }
  }
  return file;
}

const contains = (root, target) => {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};
export function confinedPath(root, file) {
  canonicalRelativePath(file);
  if (typeof root !== 'string' || !isAbsolute(root)) throw preparationError('Confinement root must be absolute');
  const base = resolve(root);
  const target = resolve(base, ...file.split('/'));
  if (!contains(base, target) || relative(base, target) === '') throw preparationError('Destination escapes its owning directory');
  // Inspect ancestors, including missing-root parents and dangling links.
  // Temporary roots are canonicalized by the caller for macOS /var aliases.
  let current = parse(target).root;
  let anchor;
  const parts = target.slice(current.length).split(sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw preparationError('Confined path contains a link or junction');
    if (index < parts.length - 1 && !stat.isDirectory()) throw preparationError('Confined parent must be a directory');
    if (relative(base, current) === '') anchor = realpathSync(current);
    if (anchor && contains(base, current) && !contains(anchor, realpathSync(current))) throw preparationError('Physical destination escapes its owning directory');
  }
  return target;
}

export function put(root, file, value) {
  const target = confinedPath(root, file);
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  mkdirSync(dirname(target), { recursive: true });
  confinedPath(root, file);
  const pendingFile = file + '.' + randomUUID() + '.tmp';
  const pending = confinedPath(root, pendingFile);
  let owned = false;
  try {
    const fd = openSync(pending, 'wx');
    owned = true;
    try { writeFileSync(fd, content); }
    finally { closeSync(fd); }
    confinedPath(root, file);
    confinedPath(root, pendingFile);
    renameSync(pending, target);
    owned = false;
  } finally {
    if (owned) {
      confinedPath(root, pendingFile);
      try { unlinkSync(pending); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return target;
}

function packageIdentity(key, entry) {
  const name = entry?.name;
  if (typeof name !== 'string' || name.length > 214 ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
      ['node_modules', 'favicon.ico'].includes(name)) throw preparationError('Invalid retained package identity');
  canonicalRelativePath(name);
  if (key !== name || entry.manifest?.value?.name !== name ||
      typeof entry.version !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(entry.version) ||
      entry.version !== entry.manifest?.value?.version) {
    throw preparationError('Retained package identity disagrees with its manifest');
  }
}

export function validateReceipt(receipt) {
  if (receipt?.provider !== 'get-tsconfig@4.14.3' || receipt.packages?.['get-tsconfig']?.version !== '4.14.3' ||
      receipt.gitHead !== receipt.packages?.['get-tsconfig']?.gitHead) throw preparationError('Unexpected stable provider identity');
  for (const [file, hash] of Object.entries(receipt.inputSha256)) {
    canonicalRelativePath(file);
    if (!file.startsWith('stable4/upstream/') || /(?:^|\/)package\.json$/i.test(file) || !/^[a-f0-9]{64}$/.test(hash)) throw preparationError('Invalid immutable input path or hash');
  }
  for (const [key, entry] of Object.entries(receipt.packages)) packageIdentity(key, entry);
  for (const [file, hash] of Object.entries(receipt.consumer.inputs)) {
    canonicalRelativePath(file);
    if (!file.startsWith('upstream/astro/') || !/^[a-f0-9]{64}$/.test(hash)) throw preparationError('Invalid original consumer input path or hash');
  }
  return receipt;
}

export function loadInputs() {
  const receipt = validateReceipt(json(confinedPath(sourceRoot, 'stable4/SOURCE.json')));
  for (const [file, hash] of Object.entries(receipt.inputSha256)) {
    if (sha256(readFileSync(confinedPath(sourceRoot, file))) !== hash) throw preparationError('Immutable input drift: ' + file);
  }
  for (const entry of Object.values(receipt.canonical)) {
    if (entry.text !== undefined && sha256(entry.text) !== entry.sha256) throw preparationError('Canonical build metadata drift');
  }
  for (const entry of Object.values(receipt.packages)) {
    if (sha256(entry.manifest.text) !== entry.manifest.sha256 || JSON.stringify(JSON.parse(entry.manifest.text)) !== JSON.stringify(entry.manifest.value)) throw preparationError('Registry manifest drift');
  }
  for (const [file, hash] of Object.entries(receipt.consumer.inputs)) {
    if (sha256(readFileSync(confinedPath(sourceRoot, file))) !== hash) throw preparationError('Original consumer input drift');
  }
  return receipt;
}

export function sourceState(receipt) {
  validateReceipt(receipt);
  const owned = ['SOURCE.json', 'stable4/SOURCE.json', 'build.mjs', 'generate.mjs', 'acceptance.mjs', 'patch-contract.mjs',
    'stable4/type-contract.ts', ...overlays.map(file => 'stable4/source/' + file)];
  const files = [...owned, ...Object.keys(receipt.inputSha256), ...Object.keys(receipt.consumer.inputs)];
  const canonical = ['config/toolchains/node-typescript.json', 'package.json', 'gui/package.json',
    'docs-site/package.json', 'tests/ci-workflows/toolchain-catalogs.test.ts'];
  const { compiler, cli, nodeTypes } = declarationTools();
  const installed = [compiler, cli];
  // Fence actual GUI Node declarations and their type dependency closure too.
  const packages = new Set();
  const visit = manifest => {
    if (packages.has(manifest)) return;
    packages.add(manifest);
    if (packages.size > 32) throw preparationError('Unbounded declaration dependency closure');
    const walk = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules') walk(file);
        else if (entry.isFile() && /(?:\.d\.[cm]?ts|package\.json)$/.test(entry.name)) installed.push(file);
      }
    };
    walk(dirname(manifest));
    const owner = createRequire(manifest);
    for (const name of Object.keys(json(manifest).dependencies ?? {}).sort()) visit(owner.resolve(name + '/package.json'));
  };
  visit(nodeTypes);
  const entries = [...files.map(file => [file, join(sourceRoot, file)]),
    ...canonical.map(file => [file, join(repo, file)]), ...installed.map(file => [file, file])];
  return sha256(JSON.stringify(entries.map(([label, path]) => [label, sha256(readFileSync(path))])));
}

export function runtime() {
  const catalog = json(join(repo, 'config/toolchains/node-typescript.json'));
  if (process.release.name !== 'node' || process.version !== 'v' + catalog.node) throw preparationError('Select the exact owning catalog Node runtime before generation');
  return catalog;
}

export function command(file, args, cwd, input, run = spawnSync) {
  const executable = typeof file === 'string' ? file.replaceAll('\\', '/').split('/').at(-1).toLowerCase() : '';
  const entry = typeof args?.[0] === 'string' ? args[0].replaceAll('\\', '/').split('/').at(-1) : '';
  const tool = entry === 'tsc' ? 'TypeScript CLI' : ['node', 'node.exe'].includes(executable) ? 'Node' : ['git', 'git.exe'].includes(executable) ? 'Git' : 'Child process';
  let result;
  try { result = run(file, args, { cwd, input, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }); }
  catch (error) { result = { error }; }
  if (result.error) {
    const code = diagnosticCodes.has(result.error.code) ? result.error.code : 'SPAWN_ERROR';
    throw preparationError(tool + ' could not complete (' + code + '); check the owning toolchain and resource limits.');
  }
  if (result.status !== 0) {
    const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGINT', 'SIGILL', 'SIGBUS']);
    const status = Number.isInteger(result.status) ? 'exit ' + result.status : signals.has(result.signal) ? result.signal : 'interrupted';
    const output = [result.stdout, result.stderr].filter(value => typeof value === 'string').join('\n');
    const codes = [...new Set(output.match(/\bTS\d{3,5}\b/g) ?? [])].slice(0, 8);
    throw preparationError(tool + ' failed (' + status + ')' + (codes.length ? '; diagnostics ' + codes.join(', ') : '') + '; check the declared inputs in the serial validation lane.');
  }
  return result.stdout;
}

export function stageInputs(stage, receipt, corrected) {
  validateReceipt(receipt); // Reject the entire receipt before the first write.
  put(stage, 'package.json', { private: true, type: 'module' });
  for (const [file] of Object.entries(receipt.inputSha256)) {
    const prefix = 'stable4/upstream/get-tsconfig/src/';
    if (file.startsWith(prefix)) {
      const local = file.slice(prefix.length);
      const input = corrected && overlays.includes(local) ? confinedPath(sourceRoot, 'stable4/source/' + local) : confinedPath(sourceRoot, file);
      put(stage, 'src/' + local, read(input));
    }
  }
  if (corrected) put(stage, 'src/read-tsconfig-types.ts', read(confinedPath(sourceRoot, 'stable4/source/read-tsconfig-types.ts')));
  // Ephemeral identities retain original module/type resolution. Historical
  // scripts, toolchains, dependencies and peers are never activated.
  for (const entry of Object.values(receipt.packages)) {
    if (entry.name === 'get-tsconfig') continue;
    const original = entry.manifest.value;
    const identity = Object.fromEntries(['name', 'version', 'type', 'main', 'module', 'types', 'typings', 'exports'].filter(key => original[key] !== undefined).map(key => [key, original[key]]));
    put(stage, 'node_modules/' + entry.name + '/package.json', identity);
  }
  for (const file of Object.keys(receipt.inputSha256)) {
    const prefix = 'stable4/upstream/npm/';
    if (file.startsWith(prefix + 'get-tsconfig/')) continue;
    if (file.startsWith(prefix)) put(stage, 'node_modules/' + file.slice(prefix.length), read(confinedPath(sourceRoot, file)));
  }
}

export async function bundle(stage, pkg, receipt) {
  const owner = createRequire(join(repo, 'docs-site/package.json'));
  const tool = json(owner.resolve('rolldown/package.json'));
  if (pkg.devDependencies?.rolldown !== 'catalog:' || tool.version !== pkg.catalog.rolldown || tool.version !== '1.2.14') throw preparationError('Install the owning catalog Rolldown 1.2.14 before generation');
  const { rolldown } = await import(pathToFileURL(owner.resolve('rolldown')).href);
  const helpers = {
    slash: 'slash/index.js',
    'jsonc-parser': 'jsonc-parser/lib/esm/main.js',
    'is-fs-case-sensitive': 'is-fs-case-sensitive/dist/index.mjs',
  };
  const banner = ['get-tsconfig', ...Object.keys(helpers)].map(name => {
    const prefix = 'stable4/upstream/npm/' + name + '/';
    const licenses = Object.keys(receipt.inputSha256).filter(file => file.startsWith(prefix) && /\/license[^/]*$/i.test(file));
    if (!licenses.length) throw preparationError('Missing bundled helper license: ' + name);
    return name + '@' + receipt.packages[name].version + '\n' + licenses.map(file => read(join(sourceRoot, file))).join('\n');
  }).join('\n\n');
  const outputs = {};
  for (const format of ['esm', 'cjs']) {
    const build = await rolldown({
      input: join(stage, 'src/index.ts'), cwd: stage, platform: 'node',
      tsconfig: false, treeshake: false,
      transform: { target: 'node' + runtime().nodeMajor },
      plugins: [{
        name: 'retained-upstream-helpers',
        resolveId(id) {
          if (id === 'resolve-pkg-maps' || id.startsWith('node:') || builtinModules.includes(id)) return { id, external: true };
          if (helpers[id]) return join(stage, 'node_modules', helpers[id]);
          if (!id.startsWith('.') && !isAbsolute(id)) throw preparationError('Undeclared bundle dependency; inspect canonical source imports');
          return null;
        },
      }],
      onLog(level, log) {
        if (level === 'warn') throw preparationError('Rolldown reported a warning; check retained source and helper inputs');
      },
    });
    try {
      const { output } = await build.generate({ format, exports: 'named', minify: true, sourcemap: false, banner: '/*!\n' + banner.replaceAll('*/', '* /') + '\n*/' });
      if (output.length !== 1 || output[0].type !== 'chunk' || output[0].dynamicImports.length) throw preparationError('Expected one complete runtime bundle');
      if (output[0].imports.some(id => id !== 'resolve-pkg-maps' && !id.startsWith('node:') && !builtinModules.includes(id))) throw preparationError('Unexpected generated runtime dependency');
      outputs['dist/index.' + (format === 'esm' ? 'mjs' : 'cjs')] = output[0].code;
    } finally { await build.close(); }
  }
  for (const [file, value] of Object.entries(outputs)) put(stage, file, value);
  return outputs;
}

function declarationTools() {
  const catalog = runtime();
  const root = createRequire(join(repo, 'package.json'));
  const gui = createRequire(join(repo, 'gui/package.json'));
  const rootManifest = json(join(repo, 'package.json'));
  const guiManifest = json(join(repo, 'gui/package.json'));
  if (rootManifest.devDependencies?.typescript !== 'catalog:' || rootManifest.catalog?.typescript !== catalog.typescript) throw preparationError('Root TS7 CLI is not bound to its owning catalog');
  if (guiManifest.devDependencies?.['@types/node'] !== 'catalog:' || guiManifest.catalog?.['@types/node'] !== catalog.nodeTypes) throw preparationError('GUI Node declarations are not bound to the current canonical catalog');
  const compiler = root.resolve('typescript/package.json');
  const nodeTypes = gui.resolve('@types/node/package.json');
  if (json(compiler).name !== 'typescript' || json(compiler).version !== catalog.typescript || !catalog.typescript.startsWith('7.')) throw preparationError('Install owning first-party TS7 CLI');
  if (json(nodeTypes).name !== '@types/node' || json(nodeTypes).version !== catalog.nodeTypes) throw preparationError('Install owning GUI catalog Node declarations');
  return { compiler, cli: join(dirname(compiler), 'bin/tsc'), nodeTypes };
}

export function typeDeclarations(stage, receipt) {
  const { cli, nodeTypes } = declarationTools();
  const npm = join(sourceRoot, 'stable4/upstream/npm');
  const options = {
    target: 'ESNext', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    esModuleInterop: true, declaration: true, emitDeclarationOnly: true, noEmitOnError: true,
    // Match upstream's library-check policy, while checking all provider source.
    skipLibCheck: true,
    types: ['node'], typeRoots: [dirname(dirname(nodeTypes)), join(stage, 'node_modules/@types')],
    rootDir: join(stage, 'src'), outDir: join(stage, 'declarations'),
  };
  if (!/"skipLibCheck":\s*true/.test(receipt.canonical['tsconfig.json'].text)) throw preparationError('Unexpected upstream declaration-check policy');
  const config = put(stage, 'tsconfig.declarations.json', { compilerOptions: options, include: ['src/**/*.ts'] });
  command(process.execPath, [cli, '--checkers', '1', '--project', config], stage);
  const types = read(join(stage, 'declarations/read-tsconfig-types.d.ts'));
  const parser = read(join(stage, 'declarations/parse-tsconfig/index.d.ts'));
  const imports = /^import type \{ TsConfigResult \} from ['"]\.\/types\.js['"];\r?\n/;
  if (!imports.test(types)) throw preparationError('Unexpected canonical additive declaration imports');
  const readSignature = parser.match(/^export declare const readTsconfig: [^\r\n]+;$/m);
  if (!readSignature || !readSignature[0].includes('=> TsconfigResult;')) throw preparationError('Missing TS7-emitted synchronous public contract');
  const addition = types.replace(imports, '').replaceAll('\r\n', '\n') + '\n' + readSignature[0] + '\n';
  const outputs = {};
  for (const suffix of ['mts', 'cts']) {
    const file = 'dist/index.d.' + suffix;
    outputs[file] = read(join(npm, 'get-tsconfig', file)) + '\n' + addition;
    put(stage, file, outputs[file]);
  }
  // Compile the exact emitted ESM and CJS surfaces against canonical source.
  const contract = read(join(sourceRoot, 'stable4/type-contract.ts'));
  for (const suffix of ['mts', 'cts']) put(stage, 'contract.' + suffix, contract.replaceAll('__PROVIDER__', './dist/index.' + (suffix === 'mts' ? 'mjs' : 'cjs')));
  const check = put(stage, 'tsconfig.contract.json', {
    compilerOptions: { ...options, skipLibCheck: false, declaration: false, emitDeclarationOnly: false, noEmit: true, rootDir: stage },
    files: ['contract.mts', 'contract.cts'],
  });
  command(process.execPath, [cli, '--checkers', '1', '--project', check], stage);
  return outputs;
}

