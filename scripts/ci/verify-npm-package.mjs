import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { materializePackageManifest, resolveBunVersion } from "../../bin/version-catalog.cjs";

export function assertPackedManifest(packed, source) {
  if (packed.catalog || packed.catalogs || JSON.stringify(packed).includes("catalog:")) {
    throw new Error("npm artifact contains unresolved source catalog metadata");
  }
  const expected = materializePackageManifest(source);
  const ordered = value => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, ordered(entry)])) : value;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"]) {
    if (JSON.stringify(ordered(packed[field])) !== JSON.stringify(ordered(expected[field]))) throw new Error(`Packed ${field} differs from the source catalog`);
  }
  if (resolveBunVersion(packed) !== resolveBunVersion(source)) throw new Error("Packed Bun runtime pin differs");
  if (source.testRunnerBun !== undefined && resolveBunVersion(packed, "test-runner") !== resolveBunVersion(source, "test-runner")) {
    throw new Error("Packed Bun test-runner pin differs");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [artifact] = JSON.parse(readFileSync("pack.json", "utf8"));
  if (!artifact || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/.test(artifact.filename)) throw new Error("Invalid local npm tarball name");
  for (const required of ["gui/dist/index.html", "bin/version-catalog.cjs"]) {
    if (!artifact.files?.some(file => file.path === required)) throw new Error(`Missing ${required} in npm package`);
  }
  const result = spawnSync("tar", ["-xOf", artifact.filename, "package/package.json"], {
    encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("Unable to inspect packed package.json");
  assertPackedManifest(JSON.parse(result.stdout), JSON.parse(readFileSync("package.json", "utf8")));
}
