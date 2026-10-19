// Shared by the Node launcher, bootstrap actions and package assembly. No Bun or
// compiler API is required to read a source manifest or an npm-packed manifest.
function resolveCatalogSpecifier(pkg, name, specifier, seen = new Set()) {
  if (typeof specifier !== "string" || !specifier || specifier !== specifier.trim()) {
    throw new Error(`Missing or invalid package.json version for ${name}`);
  }
  if (!specifier.startsWith("catalog:")) return specifier;
  const catalogName = specifier.slice("catalog:".length) || "default";
  const key = `${catalogName}:${name}`;
  if (seen.has(key)) throw new Error(`Circular catalog reference for ${name}`);
  const workspaces = pkg.workspaces && !Array.isArray(pkg.workspaces) ? pkg.workspaces : {};
  const candidates = catalogName === "default"
    ? [pkg.catalog, workspaces.catalog, pkg.catalogs?.default, workspaces.catalogs?.default]
    : [pkg.catalogs?.[catalogName], workspaces.catalogs?.[catalogName]];
  const matches = candidates.filter(catalog => catalog && Object.hasOwn(catalog, name));
  if (matches.length !== 1) throw new Error(`Missing or ambiguous catalog ${catalogName} entry for ${name}`);
  const next = new Set(seen);
  next.add(key);
  return resolveCatalogSpecifier(pkg, name, matches[0][name], next);
}

function resolveDependency(pkg, name, field = "dependencies") {
  const specifier = resolveCatalogSpecifier(pkg, name, pkg[field]?.[name]);
  // Preserve npm aliases when materializing; callers inspecting a version need
  // the registry identity too, rather than treating "npm:..." as a semver.
  const alias = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(specifier);
  if (specifier.startsWith("npm:") && !alias) throw new Error(`Invalid npm alias for ${name}`);
  const version = alias ? alias[2] : specifier;
  if (/^(?:catalog:|workspace:)/.test(version)) throw new Error(`Unresolved version for ${name}`);
  return { name: alias ? alias[1] : name, version, specifier };
}

function resolveBunVersion(pkg, role = "runtime") {
  let dependency;
  if (role === "runtime") dependency = resolveDependency(pkg, "bun");
  else if (role === "test-runner") {
    const specifier = resolveCatalogSpecifier(pkg, "bun", pkg.testRunnerBun);
    dependency = resolveDependency({ dependencies: { bun: specifier } }, "bun");
  } else throw new Error(`Unknown Bun role: ${role}`);
  if (dependency.name !== "bun" || !/^\d+\.\d+\.\d+$/.test(dependency.version)) {
    throw new Error(`Missing or invalid package.json Bun pin for ${role}`);
  }
  return dependency.version;
}

function materializePackageManifest(pkg) {
  const result = structuredClone(pkg);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (!result[field]) continue;
    for (const name of Object.keys(result[field])) {
      if (typeof result[field][name] !== "string") throw new Error(`Unsupported nested ${field} entry for ${name}`);
      result[field][name] = resolveDependency(pkg, name, field).specifier;
    }
  }
  const materializeRules = (rules, parent) => Object.fromEntries(Object.entries(rules).map(([key, value]) => {
    const name = key === "." ? parent : key;
    return [key, typeof value === "string" ? resolveCatalogSpecifier(pkg, name, value) : materializeRules(value, name)];
  }));
  for (const field of ["overrides", "resolutions"]) {
    if (pkg[field]) result[field] = materializeRules(pkg[field]);
  }
  if (pkg.testRunnerBun !== undefined) result.testRunnerBun = resolveBunVersion(pkg, "test-runner");
  delete result.catalog;
  delete result.catalogs;
  if (result.workspaces && !Array.isArray(result.workspaces)) {
    delete result.workspaces.catalog;
    delete result.workspaces.catalogs;
  }
  return result;
}

exports.resolveCatalogSpecifier = resolveCatalogSpecifier;
exports.resolveDependency = resolveDependency;
exports.resolveBunVersion = resolveBunVersion;
exports.materializePackageManifest = materializePackageManifest;
