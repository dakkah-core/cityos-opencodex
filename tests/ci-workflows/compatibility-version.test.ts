import { describe, expect, test } from "bun:test";
import { buildCompatibilityVersionManifest } from "../../scripts/generate-compatibility-version";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { materializePackageManifest } from "../../bin/version-catalog.cjs";

describe("Compatibility Lab generated implementation identity", () => {
  test("package assembly hashes concrete package metadata without changing source", () => {
    const original = readFileSync(repoPath("package.json"));
    const bytes = Buffer.from(`${JSON.stringify(materializePackageManifest(JSON.parse(original.toString())), null, 2)}\n`);
    const manifest = buildCompatibilityVersionManifest(repoRoot(), { packageManifestBytes: bytes });
    expect(manifest.files.find(row => row.path === "package.json")?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readFileSync(repoPath("package.json")).equals(original)).toBeTrue();
  });
  test("manifest covers exact tracked source authority without self-reference", () => {
    const manifest = buildCompatibilityVersionManifest(process.cwd());
    const paths = manifest.files.map(row => row.path);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.assertionDslVersion).toBe("1.0.0");
    expect(manifest.evidenceSchemaVersion).toBe("1.0.0");
    expect(manifest.bunRuntimeVersion).toBe(Bun.version);
    expect(paths).toContain("package.json");
    expect(paths).toContain("bun.lock");
    expect(paths).toContain("scripts/model-metadata.source.json");
    expect(paths).toContain("src/routing/compatibility/version.ts");
    expect(paths).not.toContain("src/generated/compatibility-version.json");
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual([...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    for (const row of manifest.files) {
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
