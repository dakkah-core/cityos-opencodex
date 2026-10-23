import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath } from "../helpers/repo-root";

const docsManifest = repoPath("docs-site/package.json");
const starlightDist = repoPath("docs-site/node_modules/@astrojs/starlight/dist");
type Yaml = { load(source: string, options?: { filename: string }): unknown; dump(value: unknown): string };
let consumers: Array<{ name: string; yaml: Yaml }>;
let frontmatterPath: string;

test("docs register exact upstream YAML patches and select js-yaml 5", () => {
  const pkg = JSON.parse(readFileSync(docsManifest, "utf8"));
  expect(pkg.catalog["js-yaml"]).toBe("5.5.0");
  expect(pkg.overrides["js-yaml"]).toBe("catalog:");
  expect(pkg.catalogs?.["compat-starlight-yaml4"]).toBeUndefined();
  for (const [owner, file] of [
    ["@astrojs/starlight@0.42.6", "@astrojs%2Fstarlight@0.42.6.patch"],
    ["@astrojs/internal-helpers@0.11.0", "@astrojs%2Finternal-helpers@0.11.0.patch"],
  ]) {
    expect(pkg.patchedDependencies[owner]).toBe(`patches/${file}`);
    expect(existsSync(repoPath("docs-site", "patches", file))).toBeTrue();
  }
});

// Root-only CI does not install the independent docs domain. When it is present,
// missing patches or an old YAML installation must fail rather than skip.
describe.skipIf(!existsSync(join(starlightDist, "utils/translations-fs.js")))("installed docs YAML consumers", () => {
  beforeAll(async () => {
    const docsRequire = createRequire(docsManifest);
    expect(docsRequire("js-yaml/package.json").version).toBe("5.5.0");
    const markdownRequire = createRequire(docsRequire.resolve("@astrojs/markdown-satteri"));
    frontmatterPath = markdownRequire.resolve("@astrojs/internal-helpers/frontmatter");
    expect(createRequire(frontmatterPath)("../package.json").version).toBe("0.11.0");
    consumers = await Promise.all([
      { name: "Starlight", path: join(starlightDist, "utils/yaml.js") },
      { name: "Astro internal helpers", path: join(dirname(frontmatterPath), "yaml.js") },
    ].map(async ({ name, path }) => ({ name, yaml: await import(pathToFileURL(path).href) as Yaml })));
  });

  test("both consumers preserve v4 scalar rules, timestamps and binary values", () => {
    const source = "word: yes\nswitch: off\nflag: true\ndecimal: 012\nbinary: 0b101\nhex: -0x2\nzero: -0\nfloat: .5\ntext: -.5\ndate: 2026-10-20\nbytes: !!binary SGk=\n";
    for (const { yaml } of consumers) {
      expect(yaml.load(source)).toEqual({
        word: "yes", switch: "off", flag: true, decimal: 12, binary: 5, hex: -2,
        zero: 0, float: 0.5, text: "-.5", date: new Date("2026-10-20T00:00:00.000Z"),
        bytes: new Uint8Array([72, 105]),
      });
    }
  });

  test("merge keys preserve precedence while quoted merge keys remain ordinary keys", () => {
    const source = "first: &first {a: 1, b: 2}\nsecond: &second {a: 3, c: 4}\nmerged: {<<: [*first, *second], b: 9}\nquoted: {'<<': literal}\n";
    for (const { yaml } of consumers) {
      expect(yaml.load(source)).toEqual({
        first: { a: 1, b: 2 }, second: { a: 3, c: 4 },
        merged: { a: 1, b: 9, c: 4 }, quoted: { "<<": "literal" },
      });
    }
  });

  test("legacy collection tags and complex keys keep their v4 JavaScript shapes", () => {
    const source = "set: !!set {one: null}\nordered: !!omap [{one: 1}, {two: 2}]\npairs: !!pairs [{one: 1}, {one: 2}]\ncomplex: {? [a, b]: value}\n";
    for (const { yaml } of consumers) {
      expect(yaml.load(source)).toEqual({
        set: { one: null }, ordered: [{ one: 1 }, { two: 2 }],
        pairs: [["one", 1], ["one", 2]], complex: { "a,b": "value" },
      });
      expect(() => yaml.load("!!set {one: non-null}")).toThrow();
      const object = yaml.load("__proto__: {yaml5Canary: true}\n") as Record<string, unknown>;
      expect(Object.hasOwn(object, "__proto__")).toBeTrue();
      expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).yaml5Canary).toBeUndefined();
    }
  });

  test("empty input remains accepted without truncating multiple documents or hiding malformed YAML", () => {
    for (const { yaml } of consumers) {
      expect(yaml.load("")).toBeUndefined();
      expect(yaml.load(" \n# comment\n")).toBeNull();
      expect(yaml.load("---\n")).toBeNull();
      expect(() => yaml.load("first: 1\n---\nsecond: 2\n")).toThrow("expected a single document");
      expect(() => yaml.load("bad: [\n", { filename: "locale.yaml" })).toThrow("locale.yaml");
      expect(() => yaml.load("duplicate: 1\nduplicate: 2\n")).toThrow();
      const values = {
        word: "yes", date: "2026-10-20", timestamp: "2026-10-20T01:02:03Z",
        positiveOctal: "+0o12", negativeOctal: "-0o12", binary: "0b101", float: "-.5",
      };
      expect(yaml.load(yaml.dump(values))).toEqual(values);
    }
  });

  test("the actual frontmatter parser accepts empty YAML and retains content modes and TOML", async () => {
    const { parseFrontmatter } = await import(pathToFileURL(frontmatterPath).href);
    for (const source of ["---\n---\nBody", "---\r\n \r\n# comment\r\n---\r\nBody"]) {
      expect(parseFrontmatter(source).frontmatter).toEqual({});
      expect(parseFrontmatter(source).content).toContain("Body");
      expect(parseFrontmatter(source, { frontmatter: "preserve" }).content).toBe(source);
      expect(parseFrontmatter(source, { frontmatter: "empty-with-spaces" }).content.length).toBe(source.length);
      expect(parseFrontmatter(source, { frontmatter: "empty-with-lines" }).content).toContain("Body");
    }
    expect(parseFrontmatter("+++\ntitle = \"Keep TOML\"\n+++\nBody").frontmatter).toEqual({ title: "Keep TOML" });
    expect(parseFrontmatter("---\nbase: &base {title: Docs}\npage: {<<: *base}\n---\nBody").frontmatter.page).toEqual({ title: "Docs" });
  });

  test("the actual Starlight head schema emits a YAML correction through the v5 named dump export", async () => {
    const { HeadConfigSchema } = await import(pathToFileURL(join(starlightDist, "schemas/head.js")).href);
    const result = HeadConfigSchema({ source: "frontmatter" }).safeParse([{ tag: "meta", content: "description" }]);
    expect(result.success).toBeFalse();
    expect(result.error.issues[0].message).toContain("tag: meta");
    expect(result.error.issues[0].message).toContain("content: description");
    // Exercise the filesystem translation consumer's static imports as well.
    const translations = await import(pathToFileURL(join(starlightDist, "utils/translations-fs.js")).href);
    expect(typeof translations.createTranslationSystemFromFs).toBe("function");
  });
});
