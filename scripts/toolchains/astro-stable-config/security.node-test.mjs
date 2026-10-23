// Exercise filesystem security contracts under the generator's actual Node
// runtime as well as their existing native-Bun test registration.
import { test } from 'node:test';
import { runtime } from './build.mjs';
import { securityCases, securityContract } from './acceptance.mjs';
runtime();
for (const name of securityCases) {
  test('Astro stable config Node security: ' + name, { timeout: 30_000 }, () => securityContract(name));
}
