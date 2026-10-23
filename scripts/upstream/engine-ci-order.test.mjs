import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

test('the clean CI runner installs dependencies before the engine typecheck', () => {
  const gates = workflow.slice(workflow.indexOf('\n  gates:\n'));
  assert.ok(gates.startsWith('\n  gates:\n'), 'The maintained gates job must exist');
  const setup = gates.indexOf('uses: ./.github/actions/setup-project-node');
  const boundary = gates.indexOf('node --test extensions/cityos-engine/host-contract.test.ts');
  const install = gates.indexOf('\n      - name: Install dependencies\n');
  const frozen = gates.indexOf('bun install --frozen-lockfile', install);
  const typecheck = gates.indexOf('node node_modules/typescript/bin/tsc --project extensions/cityos-engine/tsconfig.json');
  assert.ok(setup >= 0 && boundary > setup && install > boundary && frozen > install,
    'Dependency-free boundary checks follow canonical Node setup and precede installation');
  assert.ok(typecheck > frozen, 'The installed TypeScript compiler cannot run before frozen installation');
  assert.equal(gates.indexOf('node node_modules/typescript/bin/tsc --project extensions/cityos-engine/tsconfig.json', typecheck + 1), -1,
    'No duplicate compiler invocation may retain the old ordering');
  const installStep = gates.slice(install, gates.indexOf('\n      - name:', install + 1));
  assert.doesNotMatch(installStep, /\n\s+(?:if:|continue-on-error:)/u,
    'The required installation cannot be skipped or converted into success');
});
