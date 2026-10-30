import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { materializePackageManifest, resolveBunVersion, resolveCatalogSpecifier, resolveDependency } from "../../bin/version-catalog.cjs";

const read = (path: string) => JSON.parse(readFileSync(repoPath(path), "utf8"));
const catalog = read("config/toolchains/node-typescript.json");

describe("installed dependency API migrations", () => {
  test.each(["root", "gui"])("%s Ajv resolves catalog URI references and rejects invalid data", domain => {
    const parent = domain === "root"
      ? createRequire(repoPath("node_modules/@modelcontextprotocol/sdk/package.json"))
      : createRequire(createRequire(repoPath("gui/node_modules/react-doctor/package.json")).resolve("conf"));
    const owner = createRequire(parent.resolve("ajv"));
    const manifest = readFileSync(join(dirname(owner.resolve("fast-uri")), "package.json"), "utf8");
    expect(JSON.parse(manifest).version).toBe(read(domain === "root" ? "package.json" : "gui/package.json").catalog["fast-uri"]);
    const Ajv = parent("ajv") as new (options: { allErrors: boolean }) => {
      addSchema(schema: object): unknown;
      compile(schema: object): (data: unknown) => boolean;
    };
    const ajv = new Ajv({ allErrors: true });
    ajv.addSchema({ $id: "https://catalog.example.test/value.json", type: "string" });
    const validate = ajv.compile({
      $id: "https://catalog.example.test/input.json", type: "object",
      properties: { value: { $ref: "value.json" } }, required: ["value"], additionalProperties: false,
    });
    expect(validate({ value: "accepted" })).toBe(true);
    expect(validate({ value: 42 })).toBe(false);
    expect(validate({})).toBe(false);
    const uri = owner("fast-uri") as { resolve(base: string, reference: string): string };
    expect(() => uri.resolve("https://catalog.example.test/", "\u0000invalid")).toThrow();
  });

  test.each(["gui", "docs-site"])("%s PostCSS uses the catalog Nano ID API", domain => {
    const parent = createRequire(repoPath(domain, "package.json"));
    const owner = createRequire(parent.resolve("postcss"));
    const manifest = readFileSync(join(dirname(owner.resolve("nanoid/non-secure")), "../package.json"), "utf8");
    expect(JSON.parse(manifest).version).toBe(read(`${domain}/package.json`).catalog.nanoid);
    const postcss = parent("postcss") as { parse(css: string): { toString(): string; source?: { input: { id: string } } } };
    const css = "a { color: red }";
    const parsed = postcss.parse(css);
    expect(parsed.toString()).toBe(css);
    expect(parsed.source?.input.id).toMatch(/^<input css [\w-]{6}>$/);
  });
});

describe("catalog resolution before installation", () => {
  const pkg = {
    catalog: { bun: "1.4.2", typescript: "7.0.2", alias: "npm:@vendor/compiler@6.0.2" },
    catalogs: { tests: { bun: "1.4.3" } },
    dependencies: { bun: "catalog:", alias: "catalog:" },
    devDependencies: { typescript: "catalog:default" }, testRunnerBun: "catalog:tests",
  };

  test("source and packed manifests select the same distinct Bun roles", () => {
    for (const manifest of [pkg, materializePackageManifest(pkg)]) {
      expect(resolveBunVersion(manifest)).toBe("1.4.2");
      expect(resolveBunVersion(manifest, "test-runner")).toBe("1.4.3");
    }
    expect(() => resolveBunVersion(pkg, "other")).toThrow("Unknown Bun role");
    expect(() => resolveBunVersion({ dependencies: { bun: "npm:other@1.4.2" } })).toThrow();
  });

  test("npm aliases retain their registry identity and install specifier", () => {
    expect(resolveDependency(pkg, "alias")).toEqual({ name: "@vendor/compiler", version: "6.0.2", specifier: "npm:@vendor/compiler@6.0.2" });
    expect(materializePackageManifest(pkg).dependencies.alias).toBe("npm:@vendor/compiler@6.0.2");
    expect(resolveDependency({ dependencies: { alias: "npm:compiler@6.0.2" } }, "alias").name).toBe("compiler");
    expect(() => resolveDependency({ dependencies: { alias: "npm:compiler" } }, "alias")).toThrow();
  });

  test("workspace and top-level catalogs resolve without combining lock domains", () => {
    expect(resolveCatalogSpecifier({ workspaces: { catalog: { x: "1.2.3" } } }, "x", "catalog:default")).toBe("1.2.3");
    expect(resolveCatalogSpecifier({ catalogs: { default: { x: "1.2.3" } } }, "x", "catalog:")).toBe("1.2.3");
    expect(() => resolveCatalogSpecifier({ catalog: { x: "1.2.3" }, catalogs: { default: { x: "2.0.0" } } }, "x", "catalog:")).toThrow("ambiguous");
  });

  test("missing, circular, non-string and unpinned runtime inputs fail closed", () => {
    for (const manifest of [
      { dependencies: { bun: "catalog:" } },
      { catalog: { bun: "catalog:" }, dependencies: { bun: "catalog:" } },
      { dependencies: { bun: null } }, { dependencies: { bun: "^1.4.2" } },
      { dependencies: { bun: "1.4.2\nversion=1.4.3" } },
    ]) expect(() => resolveBunVersion(manifest)).toThrow();
  });
});

describe("fork tooling sources", () => {
  test("matching stable Bun candidates retain independent roles and a pending unified gate", () => {
    const pkg = read("package.json");
    expect(resolveBunVersion(pkg, "runtime")).toBe("1.4.4");
    expect(resolveBunVersion(pkg, "test-runner")).toBe("1.4.4");
    expect(pkg.dependencies.bun).toBe("catalog:");
    expect(pkg.testRunnerBun).toBe("catalog:test-runner");
    expect(catalog.bunRoles.candidateStatus).toBe("source-candidate");
    expect(catalog.bunRoles.unifiedLaneStatus).toBe("pending");
    const changed = { ...pkg, catalog: { ...pkg.catalog, bun: "1.5.0" } };
    expect(resolveBunVersion(changed, "runtime")).toBe("1.5.0");
    expect(resolveBunVersion(changed, "test-runner")).toBe("1.4.4");
    const docker = readFileSync(repoPath("Dockerfile"), "utf8");
    const image = /^ARG BUN_IMAGE=oven\/bun:(\d+\.\d+\.\d+)@sha256:[a-f0-9]{64}$/m.exec(docker);
    expect(image?.[1]).toBe(resolveBunVersion(pkg));
    expect(docker).toContain("gate is PENDING");
  });

  test("migrated third-party APIs resolve through their default catalogs", () => {
    const root = read("package.json");
    const gui = read("gui/package.json");
    const docs = read("docs-site/package.json");
    expect(root.catalog["fast-uri"]).toBe("4.2.3");
    expect(gui.catalog.nanoid).toBe("6.0.2");
    expect(docs.catalog.nanoid).toBe("6.0.2");
    expect(docs.catalog["js-yaml"]).toBe("5.5.0");
    for (const pkg of [root, gui]) {
      expect(materializePackageManifest(pkg).overrides["ajv@^8"]["fast-uri"]).toBe(pkg.catalog["fast-uri"]);
      expect(pkg.catalogs["compat-ajv8"]).toBeUndefined();
    }
    for (const pkg of [gui, docs]) {
      const prepared = materializePackageManifest(pkg);
      expect(prepared.overrides.postcss).toEqual({ ".": pkg.catalog.postcss, nanoid: pkg.catalog.nanoid });
      expect(pkg.catalogs?.["compat-postcss8"]).toBeUndefined();
      expect(pkg.overrides.nanoid).toBeUndefined();
    }
    expect(root.overrides["fast-uri"]).toBeUndefined();
    expect(docs.overrides["js-yaml"]).toBe("catalog:");
    expect(materializePackageManifest(docs).overrides["js-yaml"]).toBe(docs.catalog["js-yaml"]);
    expect(catalog.dependencyApiMigrations.bindings).toHaveLength(6);
    for (const binding of catalog.dependencyApiMigrations.bindings) {
      const pkg = read(binding.manifest);
      expect(binding.catalog).toBe("default");
      const selected = pkg.overrides[binding.selector];
      const prepared = materializePackageManifest(pkg).overrides[binding.selector];
      expect(typeof selected === "string" ? selected : selected[binding.dependency]).toBe("catalog:");
      expect(typeof prepared === "string" ? prepared : prepared[binding.dependency]).toBe(pkg.catalog[binding.dependency]);
      expect(binding.parentDeclaredRange).toStartWith("^");
    }
  });

  test("four catalog and lock domains remain independent and use Node 26", () => {
    expect(catalog.lockDomains).toEqual([".", "gui", "docs-site", "desktop"]);
    for (const domain of catalog.lockDomains) {
      const prefix = domain === "." ? "" : `${domain}/`;
      const pkg = read(`${prefix}package.json`);
      // Bun activates native catalog parsing only for a workspace owner. Empty
      // members preserve four independent locks rather than enrolling siblings.
      expect(pkg.workspaces).toEqual({ packages: [] });
      expect(pkg.engines.node).toBe(catalog.nodeEngine);
      expect(readFileSync(repoPath(`${prefix}bun.lock`), "utf8")).not.toBeEmpty();
      const materialized = materializePackageManifest(pkg);
      expect(materialized.catalog).toBeUndefined();
      expect(materialized.catalogs).toBeUndefined();
      expect(JSON.stringify(materialized)).not.toContain("catalog:");
    }
  });

  test("first-party root and GUI use the stable TS7 compiler and Node types", () => {
    const root = read("package.json");
    const gui = read("gui/package.json");
    expect(resolveDependency(root, "typescript", "devDependencies").version).toBe(catalog.typescript);
    expect(resolveDependency(gui, "typescript", "devDependencies").version).toBe(catalog.typescript);
    expect(resolveDependency(gui, "@types/node", "devDependencies").version).toBe(catalog.nodeTypes);
    expect(gui.scripts.typecheck).toBe("tsc -b");
    expect(gui.scripts.build).toContain("bun run typecheck");
    expect(gui.scripts.doctor).toStartWith("react-doctor ");
    expect(materializePackageManifest(gui).overrides["react-doctor"].typescript).toBe("npm:@typescript/typescript6@6.0.2");
    expect(gui.overrides.typescript).toBeUndefined();
  });

  test("root and GUI typecheck scripts use local catalog TypeScript without fetch wrappers", () => {
    const root = read("package.json");
    const gui = read("gui/package.json");
    expect(root.scripts.typecheck).toBe("tsc --noEmit");
    expect(gui.scripts.typecheck).toBe("tsc -b");
    for (const pkg of [root, gui]) {
      expect(pkg.devDependencies.typescript).toBe("catalog:");
      expect(resolveDependency(pkg, "typescript", "devDependencies").name).toBe("typescript");
      expect(pkg.scripts.typecheck).not.toMatch(/\b(?:bun\s+x|bunx|npx|npm\s+exec|pnpm\s+dlx)\b/);
    }
    expect(root.scripts.start).toBe("bun run src/cli/index.ts start");
  });

  test("explicit workflow Node versions come from the fork selector", () => {
    for (const file of readdirSync(repoPath(".github/workflows")).filter(file => file.endsWith(".yml"))) {
      const source = readFileSync(repoPath(".github/workflows", file), "utf8");
      expect(source).not.toMatch(/node-version:\s*["']?\d/);
      expect(source).not.toContain("uses: actions/setup-node@");
    }
    const action = readFileSync(repoPath(".github/actions/setup-project-node/action.yml"), "utf8");
    expect(action).toContain("require('./config/toolchains/node-typescript.json')");
    expect(action).toContain("node-version: ${{ steps.resolve.outputs.version }}");
    expect(action).toContain("process.version !==");
    for (const file of ["issue-triage.yml", "enforce-issue-quality.yml"]) {
      const workflow = Bun.YAML.parse(readFileSync(repoPath(".github/workflows", file), "utf8")) as any;
      for (const job of Object.values(workflow.jobs) as any[]) {
        if (!job.steps.some((step: any) => step.uses === "./.github/actions/setup-project-node")) continue;
        const checkout = job.steps.find((step: any) => step.uses?.startsWith("actions/checkout@"));
        expect(checkout.with["sparse-checkout"]).toContain(".github/actions/setup-project-node");
        expect(checkout.with["sparse-checkout"]).toContain("config/toolchains");
      }
    }
  });

  test("the global-install lane retains the bundled-Bun bootstrap boundary", () => {
    const ci = Bun.YAML.parse(readFileSync(repoPath(".github/workflows/ci.yml"), "utf8")) as any;
    const steps = ci.jobs["npm-global-smoke"].steps as Array<{ uses?: string; run?: string }>;
    expect(steps.some(step => step.uses?.includes("setup-bun") || step.uses?.includes("setup-project-bun"))).toBeFalse();
    expect(steps.some(step => step.run === "node scripts/npm-with-catalogs.mjs install")).toBeTrue();
    expect(steps.some(step => step.run === "node scripts/ci/verify-npm-package.mjs")).toBeTrue();
    expect(steps.some(step => step.run === "npm install -g ./bitkyc08-opencodex-*.tgz")).toBeTrue();
  });

  test("standalone installer projections match the canonical Node major", () => {
    const posix = readFileSync(repoPath("scripts/install.sh"), "utf8");
    const powershell = readFileSync(repoPath("scripts/install.ps1"), "utf8");
    expect(posix).toContain(`if [ "$NODE_MAJOR" -ne ${catalog.nodeMajor} ]; then`);
    expect(powershell).toContain(`if ($nodeMajor -ne ${catalog.nodeMajor}) {`);
  });
});

describe("OpenTelemetry compatible GUI parent", () => {
  type Locked = [string, string, {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalPeers?: string[];
  }, string];

  // Parse real lock tuples as data, preserving the canonical catalog resolver.
  const packages = (): Record<string, Locked> => Object.fromEntries(
    readFileSync(repoPath("gui/bun.lock"), "utf8").split("\n").flatMap(line => {
      const match = /^    ("(?:[^"\\]|\\.)+"): (\[.*\]),?$/.exec(line);
      return match ? [[JSON.parse(match[1]), JSON.parse(match[2])]] : [];
    }),
  );
  const version = (tuple: Locked) => tuple[0].slice(tuple[0].lastIndexOf("@") + 1);
  const parents = [
    ["@opentelemetry/core", ">=1.0.0 <1.10.0"],
    ["@opentelemetry/resources", ">=1.3.0 <1.10.0"],
    ["@opentelemetry/sdk-trace", ">=1.3.0 <1.10.0"],
    ["@opentelemetry/sdk-trace-base", ">=1.3.0 <1.10.0"],
  ] as const;

  test("the real named parent selector materializes with TS6 and Bun roles intact", () => {
    const gui = read("gui/package.json");
    const prepared = materializePackageManifest(gui);
    expect(gui.catalogs["third-party-api"]["@sentry/node"]).toBe("10.78.0");
    expect(gui.overrides["react-doctor"]["@sentry/node"]).toBe("catalog:third-party-api");
    expect(resolveCatalogSpecifier(gui, "@sentry/node", gui.overrides["react-doctor"]["@sentry/node"])).toBe("10.78.0");
    expect(prepared.overrides["react-doctor"]).toEqual({
      "@sentry/node": "10.78.0", typescript: "npm:@typescript/typescript6@6.0.2",
    });
    expect(gui.catalogs["third-party-api"].typescript).toBe("npm:@typescript/typescript6@6.0.2");
    expect(gui.catalog.typescript).toBe(catalog.typescript);
    expect(gui.devDependencies["react-doctor"]).toBe("catalog:");
    expect(gui.catalog["react-doctor"]).toBe("0.9.18");
    expect(gui.catalog["@sentry/node"]).toBeUndefined();
    expect(gui.overrides["@opentelemetry/api"]).toBeUndefined();
    expect(gui.workspaces).toEqual({ packages: [] });
    expect(resolveBunVersion(read("package.json"), "runtime")).toBe("1.4.4");
    expect(resolveBunVersion(read("package.json"), "test-runner")).toBe("1.4.4");
  });

  // Each case reads the actual lock. Its captured API 1.10.0 fails all four
  // unchanged required peers; normal resolution must supply a compatible API.
  test.each(parents)("%s accepts the resolved API with its required peer intact", (name, range) => {
    const locked = packages();
    const parent = locked[name];
    expect(parent[0]).toBe(name + "@2.12.0");
    expect(parent[2].peerDependencies?.["@opentelemetry/api"]).toBe(range);
    expect(parent[2].optionalPeers ?? []).not.toContain("@opentelemetry/api");
    expect(Bun.semver.satisfies(version(locked["@opentelemetry/api"]), range)).toBe(true);
    expect(Bun.semver.satisfies("1.10.0", range)).toBe(false);
  });

  test("all actual GUI API consumers accept the compatible resolved API", () => {
    const locked = packages();
    const api = version(locked["@opentelemetry/api"]);
    expect(api).toBe("1.9.1");
    const consumers = Object.entries(locked).flatMap(([parent, tuple]) =>
      (["dependencies", "optionalDependencies", "peerDependencies"] as const).flatMap(field => {
        const range = tuple[2][field]?.["@opentelemetry/api"];
        return range ? [{ parent, field, range }] : [];
      }),
    );
    expect(consumers).toHaveLength(9);
    for (const consumer of consumers) expect(Bun.semver.satisfies(api, consumer.range)).toBe(true);
    const range = locked["@sentry/node"][2].dependencies!["@opentelemetry/api"];
    expect(range).toBe(">=1.9.1 <1.10.0");
    expect(Bun.semver.satisfies("1.9.0", range)).toBe(false);
  });

  test("the real doctor parent and exact Sentry companions stay coherent", () => {
    const locked = packages();
    expect(version(locked["react-doctor"])).toBe("0.9.18");
    const declared = locked["react-doctor"][2].dependencies!["@sentry/node"];
    expect(declared).toBe("^10.54.0");
    expect(Bun.semver.satisfies("10.78.0", declared)).toBe(true);
    expect(Bun.semver.satisfies("11.10.0", declared)).toBe(false);
    expect(version(locked["@sentry/node"])).toBe("10.78.0");
    for (const name of ["@sentry/core", "@sentry/node-core", "@sentry/opentelemetry", "@sentry/server-utils"]) {
      expect(locked["@sentry/node"][2].dependencies?.[name]).toBe("10.78.0");
      expect(version(locked[name])).toBe("10.78.0");
    }
    expect(locked["react-doctor/typescript"][0]).toBe("@typescript/typescript6@6.0.2");
    expect(version(locked["@opentelemetry/instrumentation"])).toBe("0.220.0");
    expect(version(locked["@opentelemetry/api-logs"])).toBe("0.220.0");
  });
});

// Source contracts run actual isolated compilation and behavior through catalog
// Node. Generation and docs installation precede installed consumer acceptance.
import { existsSync as hasStableConfigConsumer } from "node:fs";
import { installedContract, installedCases, patchFormatContract, securityContract, securityCases, sourceContract, sourceCases } from "../../scripts/toolchains/astro-stable-config/acceptance.mjs";

describe("Astro stable config provider canonical source", () => {
  test("patch generation preserves upstream files without an EOF newline", async () => {
    await patchFormatContract();
  });
  test.each([...sourceCases, "ts7-type-contract", "esm-cjs", "determinism"])("%s", async name => {
    await sourceContract(name);
  }, 120_000);
});

describe.skipIf(!hasStableConfigConsumer(repoPath("docs-site/node_modules/astro/dist/core/config/tsconfig.js")))("installed Astro stable config consumer", () => {
  test.each(installedCases)("%s", async name => {
    await installedContract(name);
  }, 120_000);
});

describe("Astro stable config security boundaries", () => {
  test.each(securityCases)("%s", async name => {
    await securityContract(name);
  }, 30_000);
});
