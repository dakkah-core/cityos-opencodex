/**
 * The scanner's address pattern reads a Retina asset name as an email.
 *
 * `128x128@2x.png` is local part `128x128`, domain `2x`, and the deliberately loose TLD rule
 * accepts `png`, so listing the desktop icon set failed the gate. The exemption that fixes it is
 * one character away from a hole: a person's name in front of the same `@2x.png` suffix has the
 * identical shape and is a mailbox, so the rule is written against the asset-name grammar — a
 * pixel dimension, optionally prefixed the way an iconset member is — rather than against the
 * shape.
 *
 * This exercises the real `scanText`. A test that restated the regex would keep passing after the
 * exemption was widened, which is the only way this can go wrong.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { scanText } from "../../scripts/privacy-scan";
import { repoPath } from "../helpers/repo-root";

/** Assembled at runtime so this file carries no bare address of its own. */
const mailbox = (local: string, domain: string): string => [local, domain].join("@");

describe("privacy scan: Retina asset names", () => {
  test("the icon set the generator declares does not read as addresses", () => {
    for (const name of ["128x128@2x.png", "icon_16x16@2x.png", "icon_512x512@2x.png"]) {
      expect(scanText("desktop/scripts/generate-icons.ts", `"${name}": 256,`)
        .filter(finding => finding.kind === "email")).toEqual([]);
    }
  });

  test("a mailbox wearing the same suffix is still a finding", () => {
    for (const local of ["alice", "j.doe", "support"]) {
      const line = `contact ${mailbox(local, "2x.png")}`;
      expect(scanText("src/example.ts", line).some(finding => finding.kind === "email")).toBe(true);
    }
  });

  test("the exemption does not extend past the scale suffix and a raster extension", () => {
    const cases = [
      mailbox("128x128", "2x.com"),
      mailbox("128x128", "4x.png"),
      mailbox("128x128", "2x.example.com"),
    ];
    for (const line of cases) {
      expect(scanText("src/example.ts", line).some(finding => finding.kind === "email")).toBe(true);
    }
  });
});

describe("privacy scan: immutable dependency inputs", () => {
  const sourcePath = "scripts/toolchains/astro-stable-config/stable4/SOURCE.json";
  const source = readFileSync(repoPath(sourcePath), "utf8");

  test("versioned pnpm patch paths are filenames in their actual consumers", () => {
    for (const file of [
      "docs-site/package.json",
      "scripts/toolchains/astro-stable-config/README.md",
      "scripts/toolchains/astro-stable-config/patch-contract.mjs",
      "scripts/toolchains/astro-stable-config/inert/tsconfck/SOURCE.json",
      "tests/ci-workflows/starlight-yaml5.test.ts",
    ]) {
      expect(scanText(file, readFileSync(repoPath(file), "utf8"))
        .filter(finding => finding.kind === "email")).toEqual([]);
    }
  });

  test("a patch suffix or directory does not exempt an actual contact", () => {
    for (const token of [
      mailbox("support", "company.patch"),
      "patches/" + mailbox("support", "company.com"),
      "Contact <" + mailbox("support", "1.2.3.patch") + ">",
    ]) {
      expect(scanText("docs/example.md", token).some(finding => finding.kind === "email")).toBe(true);
    }
    expect(scanText("docs/example.md", "patches/get-tsconfig@4.14.3.patch " + mailbox("support", "company.com"))
      .filter(finding => finding.kind === "email")).toHaveLength(1);
  });

  test("complete relative patch tokens support encoded and ordinary scopes", () => {
    for (const name of ["package", "@scope%2Fpackage", "@scope/package"]) {
      const token = "./docs/patches/" + mailbox(name, "1.2.3.patch");
      for (const line of ["`" + token + "`", token + ", covering generated files", token + "; reviewed"]) {
        expect(scanText("docs/example.md", line).filter(finding => finding.kind === "email")).toEqual([]);
      }
    }
    const scopedBasename = "@scope%2F" + mailbox("package", "1.2.3.patch");
    expect(scanText("tests/example.ts", "\"" + scopedBasename + "\"")
      .filter(finding => finding.kind === "email")).toEqual([]);
    expect(scanText("src/example.ts", mailbox("scope%2Fpackage", "1.2.3.patch"))
      .some(finding => finding.kind === "email")).toBe(true);
  });

  test("path recognition rejects suffixes, malformed versions and URL contexts", () => {
    const basename = mailbox("package", "1.2.3.patch");
    const patch = "patches/" + basename;
    for (const token of [
      patch + "/",
      patch + "?download=1",
      patch + ".extra",
      "https://company.com/" + patch,
      "https://" + mailbox("user", "company.com") + "/" + patch,
      "patches/" + mailbox("package", "1.2.patch"),
      "patches/" + mailbox("package", "01.2.3.patch"),
    ]) {
      expect(scanText("docs/example.md", token).some(finding => finding.kind === "email")).toBe(true);
    }
    const findings = scanText("docs/example.md", patch + " Contact <" + basename + ">")
      .filter(finding => finding.kind === "email");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.value).toBe(basename);
  });

  test("the exact immutable upstream record retains public attribution", () => {
    expect(scanText(sourcePath, source).filter(finding => finding.kind === "email")).toEqual([]);
  });

  test("URL punctuation cannot introduce an exempt relative path or basename", () => {
    for (const separator of [";", ","]) {
      const basename = mailbox("package", "1.2.3.patch");
      for (const suffix of ["patches/" + basename, "@scope%2F" + basename]) {
        const expected = suffix.startsWith("@") ? "scope%2F" + basename : basename;
        const findings = scanText("docs/example.md", "https://company.com/x" + separator + suffix);
        expect(findings.some(finding => finding.kind === "email" && finding.value === expected)).toBe(true);
      }
    }
  });

  test("the stable patch rule does not admit prerelease version tokens", () => {
    for (const version of ["1.2.3-beta..1.patch", "1.2.3-01.patch", "1.2.3-beta.1.patch"]) {
      const token = mailbox("package", version);
      expect(scanText("docs/example.md", "patches/" + token)
        .some(finding => finding.kind === "email" && finding.value === token)).toBe(true);
    }
  });

  test("parentheses preserve surrounding URL context", () => {
    const basename = mailbox("package", "1.2.3.patch");
    for (const suffix of ["patches/" + basename, "@scope%2F" + basename]) {
      const expected = suffix.startsWith("@") ? "scope%2F" + basename : basename;
      const url = "https://company.com/(" + suffix + ")";
      expect(scanText("docs/example.md", url)
        .some(finding => finding.kind === "email" && finding.value === expected)).toBe(true);
    }
    expect(scanText("docs/example.md", "(patches/" + basename + ")")
      .filter(finding => finding.kind === "email")).toEqual([]);
  });

  test("apostrophes inside URLs are not single-quote path wrappers", () => {
    const basename = mailbox("package", "1.2.3.patch");
    for (const suffix of ["patches/" + basename, "@scope%2F" + basename]) {
      const expected = suffix.startsWith("@") ? "scope%2F" + basename : basename;
      const url = "https://company.com/x'" + suffix;
      expect(scanText("docs/example.md", url)
        .some(finding => finding.kind === "email" && finding.value === expected)).toBe(true);
      expect(scanText("docs/example.md", "'" + suffix + "'")
        .filter(finding => finding.kind === "email")).toEqual([]);
    }
  });

  test("upstream attribution is not a global address or filename exemption", () => {
    const email = JSON.parse(source).packages["get-tsconfig"].manifest.value.author.email as string;
    expect(scanText("src/example.ts", email).some(finding => finding.kind === "email")).toBe(true);
    expect(scanText("scripts/toolchains/another/SOURCE.json", source)
      .some(finding => finding.kind === "email")).toBe(true);
    expect(scanText(sourcePath, source + "\n").some(finding => finding.kind === "email")).toBe(true);
    const injected = mailbox("private", "company.com");
    expect(scanText(sourcePath, source + "\n" + injected)
      .some(finding => finding.kind === "email" && finding.value === injected)).toBe(true);
  });

  test("the upstream path cannot hide credentials or new private metadata", () => {
    const changed = JSON.parse(source);
    const injected = mailbox("private", "company.com");
    changed.privateContact = injected;
    changed.packages["get-tsconfig"].manifest.value.author.email = injected;
    expect(scanText(sourcePath, JSON.stringify(changed))
      .some(finding => finding.kind === "email" && finding.value === injected)).toBe(true);
    for (const [kind, payload] of [
      ["bearer-token", "Bearer " + "c".repeat(32)],
      ["token-looking", "s" + "k-" + "q".repeat(24)],
      ["home-path", ["", "Users", "private-user", "config"].join("/")],
      ["ssh-endpoint", "Host office\n  HostName " + ["prod", "company", "com"].join(".")],
    ]) {
      expect(scanText(sourcePath, source + "\n" + payload).some(finding => finding.kind === kind)).toBe(true);
    }
  });
});
