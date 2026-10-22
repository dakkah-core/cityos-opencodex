// Shared patch and manifest contracts have no generator CLI side effects.
import { existsSync } from 'node:fs';
import { canonicalRelativePath, command, confinedPath, consumerCatalog, consumerVersion, preparationError, read, repo } from './build.mjs';
export const patchRelative = 'patches/get-tsconfig@4.14.3.patch';
export function filePatch(path, original, corrected) {
  canonicalRelativePath(path);
  if (original === corrected) return '';
  if ([original, corrected].some((value) => value.includes('\r'))) {
    throw preparationError(`Patch inputs must use LF line endings: ${path}`);
  }
  const oldNewline = original.endsWith('\n');
  const newNewline = corrected.endsWith('\n');
  const before = (oldNewline ? original.slice(0, -1) : original).split('\n');
  const after = (newNewline ? corrected.slice(0, -1) : corrected).split('\n');
  let prefix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  if (oldNewline !== newNewline && prefix === Math.min(before.length, after.length)) prefix = Math.max(0, prefix - 1);
  let suffix = 0;
  while (oldNewline === newNewline && suffix < Math.min(before.length, after.length) - prefix && before.at(-suffix - 1) === after.at(-suffix - 1)) suffix++;
  const start = Math.max(0, prefix - 3);
  const trailing = Math.min(3, suffix);
  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  const lines = (values, start, end, marker, newline) => values.slice(start, end).flatMap((line, offset) => [
    `${marker}${line}`, ...(!newline && start + offset === values.length - 1 ? ['\\ No newline at end of file'] : []),
  ]);
  return [
    `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
    `@@ -${start + 1},${oldEnd + trailing - start} +${start + 1},${newEnd + trailing - start} @@`,
    ...lines(before, start, prefix, ' ', oldNewline),
    ...lines(before, prefix, oldEnd, '-', oldNewline),
    ...lines(after, prefix, newEnd, '+', newNewline),
    ...lines(before, oldEnd, oldEnd + trailing, ' ', oldNewline), '',
  ].join('\n');
}

export function bindManifest(pkg, patch) {
  const output = confinedPath(repo, 'docs-site/' + patchRelative);
  if (!patch || !existsSync(output) || read(output) !== patch) throw preparationError('A real complete generated provider patch must exist before binding');
  return bindConsumerManifest(pkg);
}

// Pure manifest rule: tests never write the owner manifest or provider patch.
export function bindConsumerManifest(pkg) {
  const bound = structuredClone(pkg);
  consumerCatalog(bound);
  bound.overrides ??= {};
  if (typeof bound.overrides !== 'object' || Array.isArray(bound.overrides)) throw preparationError('Unexpected docs overrides');
  const parent = 'astro@' + consumerVersion;
  const previousParent = 'astro@7.4.1';
  const previousBinding = bound.overrides[previousParent];
  if (previousBinding !== undefined) {
    if (typeof previousBinding !== 'object' || !previousBinding || Array.isArray(previousBinding) ||
        Object.keys(previousBinding).length !== 1 || previousBinding['get-tsconfig'] !== 'catalog:') {
      throw preparationError('Conflicting prior Astro parent binding; preserve unrelated owner rules');
    }
    delete bound.overrides[previousParent];
  }
  const existing = bound.overrides[parent];
  if (existing !== undefined && (typeof existing !== 'object' || !existing || Array.isArray(existing))) throw preparationError('Conflicting exact Astro override');
  if (existing?.['get-tsconfig'] !== undefined && existing['get-tsconfig'] !== 'catalog:') throw preparationError('Conflicting stable provider override');
  bound.overrides[parent] = { ...existing, 'get-tsconfig': 'catalog:' };
  bound.patchedDependencies ??= {};
  if (typeof bound.patchedDependencies !== 'object' || Array.isArray(bound.patchedDependencies)) throw preparationError('Unexpected docs patch bindings');
  const previous = bound.patchedDependencies['get-tsconfig@4.14.3'];
  if (previous !== undefined && previous !== patchRelative) throw preparationError('Conflicting provider patch');
  if (Object.keys(bound.overrides).some(key => /^tsconfck(?:@|$)/.test(key)) ||
      Object.keys(bound.patchedDependencies).some(key => /^(?:astro|tsconfck)(?:@|$)/.test(key))) {
    throw preparationError('The retired consumer/tsconfck proposal must remain inactive');
  }
  bound.patchedDependencies['get-tsconfig@4.14.3'] = patchRelative;
  return bound;
}

// The existing generator stages the one reviewed parent transition in memory.
// Only its final complete-patch binding publishes the catalog and override.
export function prepareConsumerManifest(pkg) {
  const candidate = structuredClone(pkg);
  if (candidate.catalog?.astro === '7.4.1') {
    const previous = candidate.overrides?.['astro@7.4.1'];
    if (!previous || typeof previous !== 'object' || Array.isArray(previous) ||
        Object.keys(previous).length !== 1 || previous['get-tsconfig'] !== 'catalog:') {
      throw preparationError('Existing exact owned Astro parent binding required');
    }
    candidate.catalog.astro = consumerVersion;
  }
  consumerCatalog(candidate);
  bindConsumerManifest(candidate); // Validate the future binding without writes.
  return candidate;
}

export function applyPatch(root, patch, check = false) {
  if (typeof check !== 'boolean') throw new TypeError('Patch check must be boolean');
  // Package tarballs and generated patches use LF, regardless of host Git defaults.
  return command('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', ...(check ? ['--check'] : []), '-'], root, patch);
}
