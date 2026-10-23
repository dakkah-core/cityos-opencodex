import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import {
  sha256,
  validateManifest,
  verifyDeclaredChanges,
  verifyReceipt,
  captureSourceIdentity,
  checkedFile,
} from "./integration.mjs";

const manifest = () => ({
  schemaVersion: "cityos.upstream-integration.v1",
  upstream: {
    repository: "https://github.com/puckeditor/puck",
    branch: "main",
    commit: "a".repeat(40),
  },
  ownedDirectories: [
    "extensions/cityos",
    "config/upstream",
    "scripts/upstream",
  ],
  changes: [
    {
      id: "root-index",
      purpose: "Preserve root canvas",
      invariant: "One root index",
      paths: ["packages/core/root.ts"],
      tests: ["tests/root.test.ts"],
    },
  ],
});
test("source identity hashes Git links while artifact checks still require ordinary files", () => {
  const temporary = mkdtempSync(join(tmpdir(), "cityos-upstream-links-")), root = join(temporary, "repo");
  mkdirSync(root); mkdirSync(join(root, "bin"));
  const run = args => execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe" });
  try {
    writeFileSync(join(root, "target.mjs"), "export const identity = 1;\n");
    symlinkSync("../target.mjs", join(root, "bin", "tool"), "file");
    run(["init", "--quiet"]);
    run(["add", "--", "target.mjs", "bin/tool"]);
    run(["-c", "user.name=Source fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Source fixture"]);
    const initial = captureSourceIdentity(root);
    assert.equal(initial.dirty, false);
    assert.throws(() => checkedFile(root, "bin/tool"), /escapes/u);
    unlinkSync(join(root, "bin", "tool"));
    symlinkSync("../missing.mjs", join(root, "bin", "tool"), "file");
    const dangling = captureSourceIdentity(root);
    assert.equal(dangling.dirty, true); assert.notEqual(dangling.sourceDigest, initial.sourceDigest);
    unlinkSync(join(root, "bin", "tool"));
    symlinkSync("../../outside.mjs", join(root, "bin", "tool"), "file");
    assert.throws(() => captureSourceIdentity(root), /Source link escapes/u);
  } finally {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    assert.ok(temporary.startsWith(join(tmpdir(), "cityos-upstream-links-")));
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
});
test("declared bridges and owned extensions do not admit undeclared core edits", () => {
  assert.deepEqual(
    verifyDeclaredChanges(manifest(), [
      "extensions/cityos/field.ts",
      "packages/core/root.ts",
    ]),
    [],
  );
  assert.deepEqual(
    verifyDeclaredChanges(manifest(), [
      "extensions/cityos-escape/field.ts",
      "packages/core/other.ts",
    ]),
    [
      "Undeclared upstream modification: extensions/cityos-escape/field.ts",
      "Undeclared upstream modification: packages/core/other.ts",
    ],
  );
});
test("invalid paths, ambiguous declarations and unpinned upstreams fail", () => {
  for (const path of [
    "../core.ts",
    "C:/core.ts",
    "/core.ts",
    "core\\index.ts",
    "core//index.ts",
  ]) {
    const value = manifest();
    value.changes[0].paths = [path];
    assert.ok(validateManifest(value).length);
  }
  const value = manifest();
  value.changes.push(value.changes[0]);
  assert.ok(
    validateManifest(value).some((error) => error.includes("Duplicate")),
  );
  value.upstream.commit = "main";
  assert.ok(
    validateManifest(value).some((error) => error.includes("full commit")),
  );
});
test("qualification binds clean source, required executed checks, logs, lock and exact artifact bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "cityos-upstream-receipt-"));
  try {
    mkdirSync(join(root, ".build"));
    mkdirSync(join(root, "config/upstream"), { recursive: true });
    writeFileSync(
      join(root, "config/upstream/integration.json"),
      JSON.stringify({ ...manifest(), requiredChecks: ["consumer"] }),
    );
    for (const [path, bytes] of [
      [".build/package.tgz", "tested artifact"],
      [".build/test.log", "actual test output"],
      ["lock.yaml", "locked dependencies"],
    ])
      writeFileSync(join(root, path), bytes);
    const hash = (path) => sha256(readFileSync(join(root, path)));
    const identity = {
      sourceSha: "b".repeat(40),
      sourceDigest: "c".repeat(64),
      dirty: false,
    };
    const receipt = {
      schemaVersion: "cityos.upstream-qualification.v1",
      ...identity,
      requiredChecks: ["consumer"],
      checks: [
        {
          name: "consumer",
          exitCode: 0,
          passed: 1,
          failed: 0,
          skipped: 0,
          logPath: ".build/test.log",
          logSha256: hash(".build/test.log"),
        },
      ],
      artifact: {
        path: ".build/package.tgz",
        sha256: hash(".build/package.tgz"),
      },
      lockfile: { path: "lock.yaml", sha256: hash("lock.yaml") },
    };
    assert.deepEqual(verifyReceipt(root, receipt, identity), []);
    assert.ok(
      verifyReceipt(
        root,
        { ...receipt, requiredChecks: [] },
        identity,
      ).includes(
        "Receipt required checks differ from the integration manifest",
      ),
    );
    for (const changes of [
      { skipped: 1 },
      { passed: 0 },
      { exitCode: 1 },
      { failed: 1 },
    ]) {
      const candidate = structuredClone(receipt);
      Object.assign(candidate.checks[0], changes);
      assert.ok(verifyReceipt(root, candidate, identity).length);
    }
    assert.ok(
      verifyReceipt(root, receipt, { ...identity, dirty: true }).length,
    );
    assert.ok(
      verifyReceipt(root, receipt, {
        ...identity,
        sourceDigest: "d".repeat(64),
      }).length,
    );
    writeFileSync(join(root, ".build/package.tgz"), "rebuilt replacement");
    assert.ok(
      verifyReceipt(root, receipt, identity).includes(
        "Qualified artifact bytes differ",
      ),
    );
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.startsWith(join(tmpdir(), "cityos-upstream-receipt-")));
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
