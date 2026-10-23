import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

test('the real catalog-selected docs CSS compiler preserves scroll timeline declarations', async () => {
  const require = createRequire(new URL('../../docs-site/package.json', import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL('../../docs-site/package.json', import.meta.url), 'utf8'));
  const compiler = require('esbuild');
  assert.equal(manifest.devDependencies.esbuild, 'catalog:');
  assert.equal(compiler.version, manifest.catalog.esbuild);
  const result = await compiler.transform('.progress { animation: reading 1s linear; animation-timeline: scroll(); }',
    { loader: 'css', minify: true, target: 'chrome120' });
  assert.match(result.code, /animation-timeline:scroll\(\)/u);
  assert.deepEqual(result.warnings, []);
});
