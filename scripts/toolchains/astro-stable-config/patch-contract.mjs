// Shared patch and manifest contracts have no generator CLI side effects.
import { existsSync } from 'node:fs';
import { canonicalRelativePath, command, confinedPath, preparationError, read, repo } from './build.mjs';
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
  const bound = structuredClone(pkg);
  if (bound.catalog?.['get-tsconfig'] !== '4.14.3' || bound.catalog?.astro !== '7.4.1' || bound.dependencies?.astro !== 'catalog:') throw preparationError('Unexpected docs catalogs');
  bound.overrides ??= {};
  const existing = bound.overrides['astro@7.4.1'];
  if (existing !== undefined && (typeof existing !== 'object' || !existing || Array.isArray(existing))) throw preparationError('Conflicting exact Astro override');
  if (existing?.['get-tsconfig'] !== undefined && existing['get-tsconfig'] !== 'catalog:') throw preparationError('Conflicting stable provider override');
  bound.overrides['astro@7.4.1'] = { ...existing, 'get-tsconfig': 'catalog:' };
  bound.patchedDependencies ??= {};
  const previous = bound.patchedDependencies['get-tsconfig@4.14.3'];
  if (previous !== undefined && previous !== patchRelative) throw preparationError('Conflicting provider patch');
  if (bound.overrides.tsconfck || bound.patchedDependencies['tsconfck@3.1.6'] || bound.patchedDependencies['astro@7.4.1']) throw preparationError('The retired consumer/tsconfck proposal must remain inactive');
  bound.patchedDependencies['get-tsconfig@4.14.3'] = patchRelative;
  return bound;
}

export function applyPatch(root, patch, check = false) {
  if (typeof check !== 'boolean') throw new TypeError('Patch check must be boolean');
  // Package tarballs and generated patches use LF, regardless of host Git defaults.
  return command('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', ...(check ? ['--check'] : []), '-'], root, patch);
}
