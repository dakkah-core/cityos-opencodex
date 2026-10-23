import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('the immutable registry license has exact recorded bytes in Git and in the checkout', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = 'scripts/toolchains/astro-stable-config/';
  const name = 'stable4/upstream/npm/jsonc-parser/LICENSE.md', file = directory + name;
  const expected = JSON.parse(readFileSync(root + directory + 'stable4/SOURCE.json', 'utf8')).inputSha256[name];
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const committed = execFileSync('git', ['show', 'HEAD:' + file], { cwd: root, windowsHide: true });
  assert.equal(digest(committed), expected, 'Git must preserve the exact original registry bytes');
  assert.equal(digest(readFileSync(root + file)), expected);
  assert.equal(execFileSync('git', ['check-attr', 'text', '--', file], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim(), file + ': text: unset');
});
