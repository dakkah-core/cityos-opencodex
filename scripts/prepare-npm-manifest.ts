import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { generateCompatibilityVersionManifest } from "./generate-compatibility-version";
import { assertPackagePath } from "./npm-with-catalogs.mjs";

const root = resolve(import.meta.dir, "..");
const stage = resolve(process.argv[2] ?? "");
const path = relative(join(root, ".tmp"), stage);
if (!path || path.startsWith("..") || isAbsolute(path)) throw new Error("Expected a package assembly directory within .tmp");
assertPackagePath(root, stage);
assertPackagePath(stage, join(stage, "package.json"));
assertPackagePath(stage, join(stage, "src/generated/compatibility-version.json"));
generateCompatibilityVersionManifest(root, join(stage, "src/generated/compatibility-version.json"), {
  packageManifestBytes: readFileSync(join(stage, "package.json")),
});
