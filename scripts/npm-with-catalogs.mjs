// npm receives an isolated concrete manifest. Source catalogs and all four Bun
// lock domains remain untouched, including during npm-only bootstrap and pack.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { materializePackageManifest } from "../bin/version-catalog.cjs";
import { npmInvocation } from "../src/update/npm-invocation.mjs";

const ownedStages = new Map();

function contains(root, path) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function directoryIdentity(path) {
  path = resolve(path);
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Package directory must not be a link or junction");
  return { path, real: realpathSync.native(path), dev: stat.dev, ino: stat.ino };
}

function assertDirectoryIdentity(expected) {
  const actual = directoryIdentity(expected.path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || relative(expected.real, actual.real) !== "") {
    throw new Error("Package directory ownership changed; refusing to use or remove it");
  }
}

function assertContainedPath(root, path, { allowMissing = false } = {}) {
  assertDirectoryIdentity(root);
  path = resolve(path);
  if (!contains(root.path, path)) throw new Error("Package path escapes its owning directory");
  let current = root.path;
  let stat;
  const parts = relative(root.path, path).split(sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try { stat = lstatSync(current); }
    catch (error) { if (allowMissing && error.code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink()) throw new Error("Package path contains a link or junction component");
    if (!contains(root.real, realpathSync.native(current))) throw new Error("Package realpath escapes its owning directory");
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Package parent is not a directory");
  }
  return stat;
}

// Also used by the separate Bun process that generates staged identity metadata.
export function assertPackagePath(root, path) {
  return assertContainedPath(directoryIdentity(root), path);
}

function assertOwnedStage(root, stage) {
  const owned = ownedStages.get(resolve(stage));
  if (!owned || relative(owned.root.path, resolve(root)) !== "") throw new Error("Package scratch directory is not owned by this operation");
  assertContainedPath(owned.root, owned.scratch.path);
  assertDirectoryIdentity(owned.scratch);
  assertContainedPath(owned.scratch, owned.stage.path);
  assertDirectoryIdentity(owned.stage);
  return owned;
}

function scratchDirectory(root) {
  assertDirectoryIdentity(root);
  const scratchPath = join(root.path, ".tmp");
  try {
    const existing = lstatSync(scratchPath);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error("Package scratch must not be a link or junction");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { mkdirSync(scratchPath, { mode: 0o700 }); }
    catch (creationError) { if (creationError.code !== "EEXIST") throw creationError; }
  }
  assertContainedPath(root, scratchPath);
  const scratch = directoryIdentity(scratchPath);
  const stage = directoryIdentity(mkdtempSync(join(scratch.path, "npm-catalog-")));
  ownedStages.set(stage.path, { root, scratch, stage });
  assertOwnedStage(root.path, stage.path);
  return stage.path;
}

export function removeStagedPackage(root, stage) {
  const owned = assertOwnedStage(root, stage);
  // Recheck both ancestor identities and realpaths immediately before removal.
  // rm removes links within the owned tree without traversing their targets.
  rmSync(owned.stage.path, { recursive: true, force: true });
  ownedStages.delete(owned.stage.path);
}

function assertRegularTree(root, path) {
  const stat = assertContainedPath(root, path);
  if (!stat || (!stat.isFile() && !stat.isDirectory())) throw new Error("Package inputs must be regular files or directories");
  if (stat.isDirectory()) for (const name of readdirSync(path)) assertRegularTree(root, join(path, name));
}

export function stageConcretePackage(root, { assets = true } = {}) {
  root = resolve(root);
  const rootIdentity = directoryIdentity(root);
  assertContainedPath(rootIdentity, join(root, "package.json"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const concrete = materializePackageManifest(pkg);
  const stage = scratchDirectory(rootIdentity);
  try {
    const owned = assertOwnedStage(root, stage);
    writeFileSync(join(stage, "package.json"), `${JSON.stringify(concrete, null, 2)}\n`);
    if (assets) for (const path of new Set([...(pkg.files ?? []), "README.md", "LICENSE"])) {
      if (typeof path !== "string" || !path || isAbsolute(path) || path.split(/[\\/]/).includes("..") || /[*?\[\]{}]/.test(path)) {
        throw new Error("Package files must be explicit paths within the source clone");
      }
      const source = join(root, path);
      if (relative(root, source) === "" || contains(owned.scratch.path, source)) throw new Error("Package inputs must exclude the root and package scratch space");
      assertRegularTree(rootIdentity, source);
      const destination = join(stage, path);
      assertOwnedStage(root, stage);
      assertContainedPath(owned.stage, destination, { allowMissing: true });
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, {
        recursive: true, dereference: false,
        filter: (input, output) => {
          assertContainedPath(rootIdentity, input);
          assertOwnedStage(root, stage);
          assertContainedPath(owned.stage, output, { allowMissing: true });
          return true;
        },
      });
    }
    return stage;
  } catch (error) {
    removeStagedPackage(root, stage);
    throw error;
  }
}

export function runNpmWithCatalogs(root, args, run = (argv, hook = false) => {
  const invocation = npmInvocation(argv);
  if (!invocation) throw new Error("A trusted npm executable could not be resolved");
  const result = spawnSync(invocation.file, invocation.args, {
    ...invocation.options, cwd: root, windowsHide: true,
    // Keep npm pack --json stdout machine-readable, including preparation logs.
    stdio: hook ? ["inherit", 2, 2] : "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}) {
  root = resolve(root);
  const [command, ...options] = args;
  if (!["install", "pack", "publish"].includes(command)) throw new Error("Expected install, pack or publish");
  const modules = join(root, "node_modules");
  if (command === "install" && existsSync(modules)) {
    throw new Error("npm-only bootstrap requires an absent root node_modules; use the owning Bun lock for an existing installation");
  }
  if (command === "pack" || command === "publish") {
    if (command === "publish") {
      const status = run(["run", "prepublishOnly"], true);
      if (status !== 0) return status;
    }
    const status = run(["run", "prepack"], true);
    if (status !== 0) return status;
  }
  const stage = stageConcretePackage(root, { assets: command !== "install" });
  try {
    assertOwnedStage(root, stage);
    if (command === "install") {
      const status = run(["install", "--prefix", stage, "--package-lock=false", ...options]);
      if (status !== 0) return status;
      // The npm-only CI lane begins without dependencies or a separate Bun.
      // Transfer its own fresh installation; never replace existing user work.
      if (existsSync(modules)) throw new Error("Root node_modules appeared during npm-only bootstrap");
      assertOwnedStage(root, stage);
      const installed = lstatSync(join(stage, "node_modules"));
      if (!installed.isDirectory() || installed.isSymbolicLink()) throw new Error("Bootstrap node_modules must be an owned directory");
      renameSync(join(stage, "node_modules"), modules);
      return 0;
    }
    // The staged package.json differs from source bytes, so regenerate its
    // compatibility identity through the owning generator before assembly.
    const status = run(["run", "prepare:package:npm", "--", stage], true);
    if (status !== 0) return status;
    assertOwnedStage(root, stage);
    return run([command, stage, ...options, "--ignore-scripts"]);
  } finally {
    removeStagedPackage(root, stage);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  try { process.exitCode = runNpmWithCatalogs(root, process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
