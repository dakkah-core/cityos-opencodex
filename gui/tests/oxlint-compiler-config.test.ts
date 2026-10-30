import { beforeAll, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveBunVersion } from "../../bin/version-catalog.cjs";
import { repoPath } from "../../tests/helpers/repo-root";

const gui = repoPath("gui");
const config = join(gui, ".oxlintrc.json");
// Exact 1.76 source: memo validation defaults true, effect validation Off.
// All effect-category emitters are behind that Off guard; omit only its new
// 1.89 reporter. Keep legacy memo errors and the other 17 native reporters.
// Config/Gating have a separate fixed-runner source reachability audit.
const nativeCompilerRules = [
  "capitalized-calls", "error-boundaries",
  "globals", "hooks", "immutability", "invariant", "memo-dependencies",
  "no-deriving-state-in-effects", "preserve-manual-memoization", "purity",
  "refs", "rule-suppression", "set-state-in-effect", "set-state-in-render",
  "static-components", "syntax", "use-memo", "void-use-memo",
] as const;

function oxlint(args: string[]) {
  // No ambient bun/bunx, install fallback or --bun host override. The parent
  // provides its selected native Node host for the installed CLI's shebang.
  return Bun.spawnSync([process.execPath, "x", "--no-install", "oxlint", ...args], {
    cwd: gui, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
}

beforeAll(() => {
  const rootManifest = JSON.parse(readFileSync(repoPath("package.json"), "utf8"));
  expect(resolveBunVersion(rootManifest, "test-runner")).toBe("1.4.4");
  expect(Bun.version).toBe(resolveBunVersion(rootManifest, "test-runner"));
  const manifest = JSON.parse(readFileSync(join(gui, "package.json"), "utf8"));
  const installed = JSON.parse(readFileSync(join(gui, "node_modules/oxlint/package.json"), "utf8"));
  expect(manifest.catalog.oxlint).toBe("1.89.0");
  expect(installed.version).toBe(manifest.catalog.oxlint);
  // This real no-install version probe also checks that this Bun's `x` entry
  // can actually reach the installed CLI. A missing runner/tool is a failure.
  const version = oxlint(["--version"]);
  expect(version.exitCode, version.stderr.toString()).toBe(0);
  expect(version.stdout.toString().trim()).toMatch(/^(?:oxlint\s+)?(?:Version:\s*)?1\.89\.0$/);
});

type Diagnostic = { code: string; severity: string; filename: string };
type Report = { diagnostics: Diagnostic[]; number_of_files: number };

function lintFixture(source: string) {
  const parent = realpathSync.native(tmpdir());
  const owned = mkdtempSync(join(parent, "ocx-oxlint-compiler-"));
  const ownedReal = realpathSync.native(owned);
  const fixture = join(owned, "CompilerFixture.tsx");
  try {
    writeFileSync(fixture, source, { flag: "wx" });
    const result = oxlint(["--config", config, "--no-ignore", "--format", "json", fixture]);
    const output = result.stdout.toString();
    // Configuration/host/parser failures cannot masquerade as a compiler lint.
    expect(output.trim().startsWith("{"), result.stderr.toString() || output).toBe(true);
    const report = JSON.parse(output) as Report;
    expect(Array.isArray(report.diagnostics)).toBe(true);
    expect(report.number_of_files).toBe(1);
    return { exitCode: result.exitCode, report, stderr: result.stderr.toString(), fixture };
  } finally {
    // Only this exact mkdtemp directory and its one known regular file may be
    // removed. Refuse a replaced directory, symlink/junction or extra entry.
    expect(lstatSync(owned).isSymbolicLink()).toBe(false);
    expect(lstatSync(owned).isDirectory()).toBe(true);
    expect(realpathSync.native(owned)).toBe(ownedReal);
    expect(resolve(owned)).toBe(ownedReal);
    expect(dirname(ownedReal)).toBe(parent);
    const within = relative(ownedReal, resolve(fixture));
    expect(isAbsolute(within) || within === ".." || within.startsWith("../") || within.startsWith("..\\")).toBe(false);
    expect(within).toBe("CompilerFixture.tsx");
    expect(readdirSync(owned)).toEqual(["CompilerFixture.tsx"]);
    expect(lstatSync(fixture).isSymbolicLink()).toBe(false);
    expect(lstatSync(fixture).isFile()).toBe(true);
    expect(realpathSync.native(fixture)).toBe(resolve(fixture));
    rmSync(owned, { recursive: true, force: false });
  }
}

test("actual GUI Oxlint config accepts a clean React component", () => {
  const result = lintFixture(`export function CompilerFixture({ value }: { value: number }) {
  return <div>{value + 1}</div>;
}
`);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.report.diagnostics).toEqual([]);
});

test("actual GUI config reports native React Compiler immutability as an error", () => {
  const result = lintFixture(`export function CompilerFixture({ model }: { model: { value: number } }) {
  model.value = 2;
  return <div>{model.value}</div>;
}
`);
  expect(result.exitCode, result.stderr).toBe(1);
  expect(result.report.diagnostics.some(d => d.code === "react(immutability)" && d.severity === "error")).toBe(true);
  expect(result.report.diagnostics.every(d => d.code === "react(immutability)")).toBe(true);
});

test("actual GUI config reports native React Compiler purity as an error", () => {
  const result = lintFixture(`export function CompilerFixture() {
  const value = Math.random();
  return <div>{value}</div>;
}
`);
  expect(result.exitCode, result.stderr).toBe(1);
  expect(result.report.diagnostics.some(d => d.code === "react(purity)" && d.severity === "error")).toBe(true);
  expect(result.report.diagnostics.every(d => d.code === "react(purity)")).toBe(true);
});

test("actual GUI config reports native void-use-memo omitted by the recommended-only subset", () => {
  const result = lintFixture(`import { useMemo } from "react";
export function CompilerFixture() {
  const value = useMemo(() => {}, []);
  return <div>{value}</div>;
}
`);
  expect(result.exitCode, result.stderr).toBe(1);
  expect(result.report.diagnostics.some(d => d.code === "react(void-use-memo)" && d.severity === "error")).toBe(true);
  expect(result.report.diagnostics.every(d => d.code === "react(void-use-memo)")).toBe(true);
});

test("actual GUI config accepts an intentional effect trigger key under the legacy Off policy", () => {
  const result = lintFixture(`import { useEffect } from "react";
export function CompilerFixture({ triggerKey }: { triggerKey: number }) {
  useEffect(() => {
    window.dispatchEvent(new Event("compiler-fixture"));
  }, [triggerKey]);
  return <div>{triggerKey}</div>;
}
`);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.report.diagnostics).toEqual([]);
});

test("actual GUI config retains a native legacy memo error for an extra useMemo dependency", () => {
  const result = lintFixture(`import { useMemo } from "react";
export function CompilerFixture({ value, triggerKey }: { value: number; triggerKey: number }) {
  const computed = useMemo(() => value + 1, [value, triggerKey]);
  return <div>{computed}</div>;
}
`);
  expect(result.exitCode, result.stderr).toBe(1);
  expect(result.report.diagnostics.some(d => d.code === "react(memo-dependencies)" && d.severity === "error")).toBe(true);
  // Keep any independent core warning visible; a parse/config failure or an
  // unrelated compiler error cannot satisfy this regression.
  expect(result.report.diagnostics.every(d =>
    (d.code === "react(memo-dependencies)" && d.severity === "error") ||
    (d.code === "react-hooks(exhaustive-deps)" && d.severity === "warning"),
  ), JSON.stringify(result.report.diagnostics)).toBe(true);
});

test("GUI retains all reachable legacy error reporters and independent core hook levels", () => {
  const actual = JSON.parse(readFileSync(config, "utf8"));
  const rules = actual.overrides.find((o: { files: string[] }) => o.files.includes("**/*.{ts,tsx}")).rules;
  for (const name of nativeCompilerRules) expect(rules[`react/${name}`], name).toBe("error");
  expect(rules["react/exhaustive-effect-dependencies"]).toBeUndefined();
  expect(rules["react/memo-dependencies"]).toBe("error");
  // The legacy aggregate's default error filter excluded these bailouts.
  for (const name of ["incompatible-library", "unsupported-syntax", "todo"]) {
    expect(rules[`react/${name}`], name).toBeUndefined();
  }
  expect(rules["react/react-compiler"]).toBeUndefined();
  expect(rules["react/rules-of-hooks"]).toBe("error");
  expect(rules["react/exhaustive-deps"]).toBe("warn");
  expect(actual.overrides.find((o: { files: string[] }) => o.files.includes("src/pages/Models.tsx")).rules["react/exhaustive-deps"]).toBe("off");
});

test("existing memo next-line exception preserves the independent exhaustive-deps warning", () => {
  const result = lintFixture(`import { useMemo } from "react";
export function CompilerFixture({ value, triggerKey }: { value: number; triggerKey: number }) {
  const computed = useMemo(() => {
    return value + 1;
  // oxlint-disable-next-line react/memo-dependencies -- preserve existing callback dependency semantics during Oxlint migration
  }, [value, triggerKey]);
  return <div>{computed}</div>;
}
`);
  expect(result.exitCode, result.stderr || JSON.stringify(result.report.diagnostics)).toBe(0);
  // Retargeting the existing compiler exception must not suppress the core
  // warning. The unsuppressed memo-error control above remains unchanged.
  expect(result.report.diagnostics.some(d => d.code === "react-hooks(exhaustive-deps)" && d.severity === "warning"), JSON.stringify(result.report.diagnostics)).toBe(true);
  expect(result.report.diagnostics.every(d => d.code === "react-hooks(exhaustive-deps)" && d.severity === "warning"), JSON.stringify(result.report.diagnostics)).toBe(true);
});

test("actual GUI config reports an unsuppressed native state-effect error for a poll snapshot", () => {
  const result = lintFixture(`import { useEffect, useState } from "react";
export function CompilerFixture({ updatePoll }: { updatePoll: { data: { reconnecting: boolean } | null } }) {
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    const data = updatePoll.data;
    if (!data) return;
    setReconnecting(data.reconnecting);
  }, [updatePoll.data]);
  return <div>{String(reconnecting)}</div>;
}
`);
  expect(result.exitCode, result.stderr || JSON.stringify(result.report.diagnostics)).toBe(1);
  expect(result.report.diagnostics.some(d => d.code === "react(set-state-in-effect)" && d.severity === "error"), JSON.stringify(result.report.diagnostics)).toBe(true);
  expect(result.report.diagnostics.every(d => d.code === "react(set-state-in-effect)" && d.severity === "error"), JSON.stringify(result.report.diagnostics)).toBe(true);
});

test("existing poll snapshot block exception suppresses only its native state-effect reporter", () => {
  const result = lintFixture(`import { useEffect, useState } from "react";
export function CompilerFixture({ updatePoll }: { updatePoll: { data: { reconnecting: boolean } | null } }) {
  const [reconnecting, setReconnecting] = useState(false);
  /* oxlint-disable react/set-state-in-effect -- mirror update poll snapshot into mutable dashboard UI state */
  useEffect(() => {
    const data = updatePoll.data;
    if (!data) return;
    setReconnecting(data.reconnecting);
  }, [updatePoll.data]);
  /* oxlint-enable react/set-state-in-effect */
  return <div>{String(reconnecting)}</div>;
}
`);
  expect(result.exitCode, result.stderr || JSON.stringify(result.report.diagnostics)).toBe(0);
  expect(result.report.diagnostics).toEqual([]);
});

function nativeCompilerExceptionGroup() {
  const actual = JSON.parse(readFileSync(config, "utf8"));
  const rules = actual.overrides.find((o: { files: string[] }) => o.files.includes("**/*.{ts,tsx}")).rules;
  const independent = new Set(["react/rules-of-hooks", "react/exhaustive-deps", "react/only-export-components"]);
  const group = Object.keys(rules).filter(name => name.startsWith("react/") && !independent.has(name));
  // Bind the fixture to the actual fixed policy, refusing added categories or
  // core hook keys rather than silently expanding an existing exception.
  expect([...group].sort()).toEqual(nativeCompilerRules.map(name => `react/${name}`).sort());
  for (const name of group) expect(rules[name], name).toBe("error");
  return group.join(", ");
}

function expectOutsidePurityErrorAndCoreWarning(result: ReturnType<typeof lintFixture>, source: string) {
  const diagnostics = result.report.diagnostics;
  const message = JSON.stringify(diagnostics);
  expect(result.exitCode, result.stderr || message).toBe(1);
  expect(diagnostics.some(d => d.code === "react(purity)" && d.severity === "error"), message).toBe(true);
  expect(diagnostics.some(d => d.code === "react-hooks(exhaustive-deps)" && d.severity === "warning"), message).toBe(true);
  expect(diagnostics.every(d =>
    (d.code === "react(purity)" && d.severity === "error") ||
    (d.code === "react-hooks(exhaustive-deps)" && d.severity === "warning"),
  ), message).toBe(true);
  const outsideLine = source.split("\n").findIndex(line => line.includes("const outsideValue = Math.random()")) + 1;
  expect(outsideLine).toBeGreaterThan(0);
  for (const diagnostic of diagnostics.filter(d => d.code === "react(purity)")) {
    expect(diagnostic.filename.replaceAll("\\", "/")).toBe(result.fixture.replaceAll("\\", "/"));
    const labels = (diagnostic as Diagnostic & { labels?: { span: { line: number } }[] }).labels;
    expect(labels?.some(label => label.span.line === outsideLine), message).toBe(true);
  }
}

test("existing ESLint next-line compiler group preserves the core warning and ends at that line", () => {
  const group = nativeCompilerExceptionGroup();
  const covered = `import { useMemo } from "react";
export function CompilerFixture({ value, triggerKey }: { value: number; triggerKey: number }) {
  // eslint-disable-next-line react-hooks/set-state-in-effect, ${group}
  const computed = useMemo(() => value + 1, [value, triggerKey]);
  return <div>{computed}</div>;
}
`;
  const suppressed = lintFixture(covered);
  expect(suppressed.exitCode, suppressed.stderr || JSON.stringify(suppressed.report.diagnostics)).toBe(0);
  expect(suppressed.report.diagnostics.some(d => d.code === "react-hooks(exhaustive-deps)" && d.severity === "warning"), JSON.stringify(suppressed.report.diagnostics)).toBe(true);
  expect(suppressed.report.diagnostics.every(d => d.code === "react-hooks(exhaustive-deps)" && d.severity === "warning"), JSON.stringify(suppressed.report.diagnostics)).toBe(true);

  const outside = covered + `export function OutsideCompilerFixture() {
  const outsideValue = Math.random();
  return <div>{outsideValue}</div>;
}
`;
  expectOutsidePurityErrorAndCoreWarning(lintFixture(outside), outside);
});

test("existing native compiler block preserves the core warning and restores errors after enable", () => {
  const group = nativeCompilerExceptionGroup();
  const covered = `import { useMemo } from "react";
/* oxlint-disable ${group} -- mirror client-resource snapshots into mutable dashboard UI state that handlers also update */
/* eslint-disable react-hooks/set-state-in-effect -- mirror client-resource snapshots into mutable dashboard UI state that handlers also update */
export function CompilerFixture({ value, triggerKey }: { value: number; triggerKey: number }) {
  const computed = useMemo(() => value + 1, [value, triggerKey]);
  const sampled = Math.random();
  return <div>{computed + sampled}</div>;
}
/* eslint-enable react-hooks/set-state-in-effect */
/* oxlint-enable ${group} */
`;
  const suppressed = lintFixture(covered);
  expect(suppressed.exitCode, suppressed.stderr || JSON.stringify(suppressed.report.diagnostics)).toBe(0);
  expect(suppressed.report.diagnostics.some(d => d.code === "react-hooks(exhaustive-deps)" && d.severity === "warning"), JSON.stringify(suppressed.report.diagnostics)).toBe(true);
  expect(suppressed.report.diagnostics.every(d => d.code === "react-hooks(exhaustive-deps)" && d.severity === "warning"), JSON.stringify(suppressed.report.diagnostics)).toBe(true);

  const outside = covered + `export function OutsideCompilerFixture() {
  const outsideValue = Math.random();
  return <div>{outsideValue}</div>;
}
`;
  expectOutsidePurityErrorAndCoreWarning(lintFixture(outside), outside);
});
