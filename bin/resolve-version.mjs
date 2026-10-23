import { readFileSync } from "node:fs";
import { resolveBunVersion, resolveDependency } from "./version-catalog.cjs";

const [name, field = "dependencies"] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
console.log(name === "bun"
  ? resolveBunVersion(pkg, field === "dependencies" ? "runtime" : field)
  : resolveDependency(pkg, name, field).specifier);
