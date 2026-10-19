import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { removeStagedPackage, runNpmWithCatalogs, stageConcretePackage } from "../../scripts/npm-with-catalogs.mjs";
import { assertPackedManifest } from "../../scripts/ci/verify-npm-package.mjs";

const roots: string[] = [];
const directoryLinks: string[] = [];
afterEach(() => {
  // Unlink real directory links before any fixture teardown can reach them.
  for (const link of directoryLinks.splice(0).reverse()) {
    try { if (lstatSync(link).isSymbolicLink()) unlinkSync(link); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});
const original = '{\r\n  "name": "fixture", "files": ["bin"], "catalog": { "bun": "1.4.3", "alias": "npm:@scope/name@2.0.0" },\r\n'
  + '  "dependencies": { "bun": "catalog:", "alias": "catalog:" }, "catalogs": { "tests": { "bun": "1.4.3" } }, "testRunnerBun": "catalog:tests"\r\n}\r\n';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-npm-catalog-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), original);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/ocx.mjs"), "// fixture launcher\n");
  for (const path of ["README.md", "LICENSE"]) writeFileSync(join(root, path), path);
  return root;
}
function outsideFixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-npm-outside-"));
  roots.push(root);
  writeFileSync(join(root, "canary"), "outside tree must survive");
  return root;
}
function directoryLink(target: string, link: string) {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  directoryLinks.push(link);
}
const manifest = (root: string) => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const unchanged = (root: string) => expect(readFileSync(join(root, "package.json"), "utf8")).toBe(original);

describe("npm package assembly", () => {
  test("the staged artifact has concrete metadata while source stays byte-identical", () => {
    const root = fixture();
    const stage = stageConcretePackage(root);
    expect(stage).not.toBe(root);
    const packed = manifest(stage);
    expect(packed.dependencies).toEqual({ bun: "1.4.3", alias: "npm:@scope/name@2.0.0" });
    expect(packed.testRunnerBun).toBe("1.4.3");
    expect(packed.catalog).toBeUndefined();
    expect(JSON.stringify(packed)).not.toContain("catalog:");
    expect(() => assertPackedManifest(packed, manifest(root))).not.toThrow();
    expect(() => assertPackedManifest(manifest(root), manifest(root))).toThrow("unresolved");
    expect(readFileSync(join(stage, "bin/ocx.mjs"), "utf8")).toBe("// fixture launcher\n");
    unchanged(root);
    removeStagedPackage(root, stage);
  });

  test.each(["pack", "publish"])("%s preserves preparation gates and packs only staged bytes", command => {
    const root = fixture();
    const calls: string[][] = [];
    let stage: string | undefined;
    const status = runNpmWithCatalogs(root, [command, "--dry-run"], (args: string[], hook: boolean) => {
      calls.push(args);
      unchanged(root);
      if (args[1] === "prepare:package:npm") {
        stage = args[3];
        expect(manifest(stage!).catalog).toBeUndefined();
      }
      if (!hook) {
        expect(args).toEqual([command, stage!, "--dry-run", "--ignore-scripts"]);
        expect(manifest(stage!).dependencies.bun).toBe("1.4.3");
      }
      return 0;
    });
    expect(status).toBe(0);
    expect(calls.map(args => args.slice(0, 2))).toEqual([
      ...(command === "publish" ? [["run", "prepublishOnly"]] : []),
      ["run", "prepack"], ["run", "prepare:package:npm"], [command, stage!],
    ]);
    expect(existsSync(stage!)).toBeFalse();
    unchanged(root);
  });

  test("failed prepublish gates prevent assembly and publication", () => {
    const root = fixture();
    const calls: string[][] = [];
    expect(runNpmWithCatalogs(root, ["publish"], (args: string[]) => { calls.push(args); return 17; })).toBe(17);
    expect(calls).toEqual([["run", "prepublishOnly"]]);
    unchanged(root);
  });

  test("npm-only bootstrap installs concrete dependencies without separate Bun setup", () => {
    const root = fixture();
    expect(runNpmWithCatalogs(root, ["install"], (args: string[]) => {
      const stage = args[2]!;
      expect(args).toEqual(["install", "--prefix", stage, "--package-lock=false"]);
      expect(manifest(stage).dependencies.bun).toBe("1.4.3");
      unchanged(root);
      mkdirSync(join(stage, "node_modules"));
      writeFileSync(join(stage, "node_modules/bundled-bun"), "installed fixture");
      return 0;
    })).toBe(0);
    expect(readFileSync(join(root, "node_modules/bundled-bun"), "utf8")).toBe("installed fixture");
    expect(() => runNpmWithCatalogs(root, ["install"], () => { throw new Error("must not run"); })).toThrow("absent root node_modules");
    unchanged(root);
  });

  test("an npm failure cleans only scratch and preserves source", () => {
    const root = fixture();
    let stage: string | undefined;
    expect(runNpmWithCatalogs(root, ["install"], (args: string[]) => { stage = args[2]; return 19; })).toBe(19);
    expect(existsSync(stage!)).toBeFalse();
    unchanged(root);
  });

  test("an intermediate directory link cannot supply outside package assets", () => {
    const root = fixture();
    const outside = outsideFixture();
    mkdirSync(join(outside, "dist"));
    writeFileSync(join(outside, "dist/private.txt"), "outside asset must not be copied");
    directoryLink(outside, join(root, "gui"));
    const pkg = { ...manifest(root), files: ["gui/dist"] };
    const source = JSON.stringify(pkg);
    writeFileSync(join(root, "package.json"), source);
    expect(lstatSync(join(root, "gui/dist")).isDirectory()).toBeTrue();
    expect(() => stageConcretePackage(root)).toThrow(/link|junction|realpath/);
    expect(readdirSync(join(root, ".tmp"))).toEqual([]);
    expect(readFileSync(join(outside, "dist/private.txt"), "utf8")).toBe("outside asset must not be copied");
    expect(readFileSync(join(outside, "canary"), "utf8")).toBe("outside tree must survive");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(source);
    expect(readFileSync(join(root, "bin/ocx.mjs"), "utf8")).toBe("// fixture launcher\n");
  });

  test("a linked .tmp is refused before creating or deleting any outside entries", () => {
    const root = fixture();
    const outside = outsideFixture();
    directoryLink(outside, join(root, ".tmp"));
    expect(() => stageConcretePackage(root)).toThrow(/link|junction|realpath/);
    expect(readdirSync(outside)).toEqual(["canary"]);
    expect(readFileSync(join(outside, "canary"), "utf8")).toBe("outside tree must survive");
    unchanged(root);
  });

  test("cleanup refuses an intermediate .tmp junction substituted during an operation", () => {
    const root = fixture();
    const outside = outsideFixture();
    let stage: string | undefined;
    expect(() => runNpmWithCatalogs(root, ["install"], (args: string[]) => {
      stage = args[2]!;
      renameSync(join(root, ".tmp"), join(root, ".tmp-original"));
      const outsideStage = join(outside, basename(stage));
      mkdirSync(outsideStage);
      writeFileSync(join(outsideStage, "keep"), "do not remove outside stage");
      directoryLink(outside, join(root, ".tmp"));
      return 19;
    })).toThrow(/link|junction|realpath/);
    expect(readFileSync(join(outside, basename(stage!), "keep"), "utf8")).toBe("do not remove outside stage");
    expect(existsSync(join(root, ".tmp-original", basename(stage!), "package.json"))).toBeTrue();
    unchanged(root);
    unlinkSync(join(root, ".tmp"));
    renameSync(join(root, ".tmp-original"), join(root, ".tmp"));
    removeStagedPackage(root, stage!);
    expect(readFileSync(join(outside, "canary"), "utf8")).toBe("outside tree must survive");
  });

  test("cleanup refuses a stage replaced with a real outside directory link", () => {
    const root = fixture();
    const outside = outsideFixture();
    let stage: string | undefined;
    expect(() => runNpmWithCatalogs(root, ["install"], (args: string[]) => {
      stage = args[2]!;
      renameSync(stage, `${stage}.original`);
      directoryLink(outside, stage);
      return 19;
    })).toThrow(/link|junction|realpath/);
    expect(readFileSync(join(outside, "canary"), "utf8")).toBe("outside tree must survive");
    expect(existsSync(join(`${stage}.original`, "package.json"))).toBeTrue();
    unchanged(root);
    unlinkSync(stage!);
    renameSync(`${stage}.original`, stage!);
    removeStagedPackage(root, stage!);
  });

  test("cleanup preserves a different regular directory placed at the owned stage path", () => {
    const root = fixture();
    const stage = stageConcretePackage(root);
    renameSync(stage, `${stage}.original`);
    mkdirSync(stage);
    writeFileSync(join(stage, "keep"), "replacement directory must survive");
    expect(() => removeStagedPackage(root, stage)).toThrow("ownership changed");
    expect(readFileSync(join(stage, "keep"), "utf8")).toBe("replacement directory must survive");
    expect(existsSync(join(`${stage}.original`, "package.json"))).toBeTrue();
    unchanged(root);
  });

  test("owned cleanup unlinks nested directory links while preserving their outside targets", () => {
    const root = fixture();
    const outside = outsideFixture();
    const stage = stageConcretePackage(root);
    directoryLink(outside, join(stage, "nested-link"));
    removeStagedPackage(root, stage);
    expect(existsSync(stage)).toBeFalse();
    expect(readFileSync(join(outside, "canary"), "utf8")).toBe("outside tree must survive");
    unchanged(root);
  });
});
