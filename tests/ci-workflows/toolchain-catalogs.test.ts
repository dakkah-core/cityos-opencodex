import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { materializePackageManifest, resolveBunVersion, resolveCatalogSpecifier, resolveDependency } from "../../bin/version-catalog.cjs";

const read = (path: string) => JSON.parse(readFileSync(repoPath(path), "utf8"));
const catalog = read("config/toolchains/node-typescript.json");

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
    expect(resolveBunVersion(pkg, "runtime")).toBe("1.4.3");
    expect(resolveBunVersion(pkg, "test-runner")).toBe("1.4.3");
    expect(pkg.dependencies.bun).toBe("catalog:");
    expect(pkg.testRunnerBun).toBe("catalog:test-runner");
    expect(catalog.bunRoles.candidateStatus).toBe("source-candidate");
    expect(catalog.bunRoles.unifiedLaneStatus).toBe("pending");
    const changed = { ...pkg, catalog: { ...pkg.catalog, bun: "1.5.0" } };
    expect(resolveBunVersion(changed, "runtime")).toBe("1.5.0");
    expect(resolveBunVersion(changed, "test-runner")).toBe("1.4.3");
    const docker = readFileSync(repoPath("Dockerfile"), "utf8");
    const image = /^ARG BUN_IMAGE=oven\/bun:(\d+\.\d+\.\d+)@sha256:[a-f0-9]{64}$/m.exec(docker);
    expect(image?.[1]).toBe(resolveBunVersion(pkg));
    expect(docker).toContain("gate is PENDING");
  });

  test("older transitive APIs use named owner-scoped compatibility catalogs", () => {
    const root = read("package.json");
    const gui = read("gui/package.json");
    const docs = read("docs-site/package.json");
    expect(root.catalog["fast-uri"]).toBe("4.2.2");
    expect(gui.catalog.nanoid).toBe("6.0.2");
    expect(docs.catalog.nanoid).toBe("6.0.2");
    expect(docs.catalog["js-yaml"]).toBe("5.5.0");
    expect(materializePackageManifest(root).overrides["ajv@^8"]["fast-uri"]).toBe("3.1.8");
    for (const pkg of [gui, docs]) {
      const prepared = materializePackageManifest(pkg);
      expect(prepared.overrides.postcss).toEqual({ ".": pkg.catalog.postcss, nanoid: "3.3.20" });
      expect(pkg.overrides.nanoid).toBeUndefined();
    }
    expect(root.overrides["fast-uri"]).toBeUndefined();
    expect(docs.overrides["js-yaml"]).toBeUndefined();
    expect(materializePackageManifest(docs).overrides["@astrojs/starlight"]["js-yaml"]).toBe("4.3.2");
    expect(catalog.compatibilityCatalogs.bindings).toHaveLength(4);
    for (const binding of catalog.compatibilityCatalogs.bindings) {
      const pkg = read(binding.manifest);
      expect(pkg.overrides[binding.selector][binding.dependency]).toBe(`catalog:${binding.catalog}`);
      expect(pkg.catalogs[binding.catalog][binding.dependency]).not.toBe(pkg.catalog[binding.dependency]);
      expect(binding.parentDeclaredRange).toStartWith("^");
    }
  });

  test("four catalog and lock domains remain independent and use Node 26", () => {
    expect(catalog.lockDomains).toEqual([".", "gui", "docs-site", "desktop"]);
    for (const domain of catalog.lockDomains) {
      const prefix = domain === "." ? "" : `${domain}/`;
      const pkg = read(`${prefix}package.json`);
      expect(pkg.workspaces).toBeUndefined();
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
