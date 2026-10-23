import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEngineHostBoundary, type EngineHostBindings } from './host-contract.ts';
function fixture() {
  const calls = { admission: 0, authorization: 0, usage: 0, finalization: 0, management: 0, provider: 0 };
  const bindings: EngineHostBindings = {
    admit: async () => { calls.admission++; return { admitted: true, operationRef: 'owner-operation', context: {} }; },
    authorizeProviderAttempt: async () => { calls.authorization++; return true; },
    usage: async () => { calls.usage++; return true; }, finalize: async () => { calls.finalization++; return true; },
    management: async () => { calls.management++; return true; },
  };
  const attempt = (attemptRef: string) => ({ attemptRef, providerRef: 'provider', accountRef: 'account', transport: 'http' as const, destination: 'https://provider.invalid/v1/responses' });
  return { calls, bindings, attempt, send: async () => { calls.provider++; return Response.json({ result: true }); } };
}
test('missing bindings reject bootstrap and denials or exceptions produce zero provider calls', async () => {
  const f = fixture(); assert.throws(() => createEngineHostBoundary({ ...f.bindings, usage: undefined } as unknown as EngineHostBindings));
  for (const authorizeProviderAttempt of [async () => false, async () => { throw Error('credential-value-must-not-escape'); }]) {
    const context = await createEngineHostBoundary({ ...f.bindings, authorizeProviderAttempt } as EngineHostBindings).admit(new Request('http://localhost/'));
    await assert.rejects(context.attempt(f.attempt('attempt'), f.send), error => error instanceof Error && !error.message.includes('credential-value'));
  }
  assert.equal(f.calls.provider, 0);
});
test('every retry, account fallback and transport needs a distinct freshly authorized attempt', async () => {
  const f = fixture(); let allowed = true;
  const context = await createEngineHostBoundary({ ...f.bindings, authorizeProviderAttempt: async () => { f.calls.authorization++; return allowed as true; } }).admit(new Request('http://localhost/'));
  await context.attempt(f.attempt('first'), f.send);
  await context.attempt({ ...f.attempt('retry'), accountRef: 'fallback', transport: 'websocket' }, f.send);
  allowed = false;
  await assert.rejects(context.attempt({ ...f.attempt('reconnect'), transport: 'native' }, f.send));
  assert.equal(f.calls.provider, 2); assert.equal(f.calls.authorization, 3);
  await assert.rejects(context.attempt(f.attempt('first'), f.send), /identity_reused/);
});
test('authorization is awaited and cancellation during that wait prevents dispatch', async () => {
  const f = fixture(), controller = new AbortController(); let allow!: () => void;
  const context = await createEngineHostBoundary({ ...f.bindings, authorizeProviderAttempt: () => new Promise(resolve => { allow = () => resolve(true); }) })
    .admit(new Request('http://localhost/', { signal: controller.signal }));
  const pending = context.attempt(f.attempt('first'), f.send);
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(f.calls.provider, 0);
  controller.abort(); allow(); await assert.rejects(pending); assert.equal(f.calls.provider, 0);
});
test('usage and finalization callbacks deduplicate identical receipts and reject conflicting ones', async () => {
  const f = fixture(), context = await createEngineHostBoundary(f.bindings).admit(new Request('http://localhost/'));
  const receipt = { receiptRef: 'usage-receipt', inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 };
  await Promise.all([context.usage(receipt), context.usage(receipt)]); assert.equal(f.calls.usage, 1);
  await assert.rejects(context.usage({ ...receipt, outputTokens: 3 }), /conflict/);
  const result = { outcome: 'completed' as const, receiptRef: 'terminal-receipt' };
  await Promise.all([context.finalize(result), context.finalize(result)]); assert.equal(f.calls.finalization, 1);
  await assert.rejects(context.attempt(f.attempt('late'), f.send), /finalized/);
  assert.throws(() => context.finalize({ ...result, outcome: 'failed' }), /conflict/);
});
test('bounded hook failure and denied management operations cannot become success', async () => {
  const f = fixture();
  const context = await createEngineHostBoundary({ ...f.bindings, management: async () => false as true,
    finalize: async () => new Promise(() => {}) }, 10).admit(new Request('http://localhost/'));
  await assert.rejects(context.management('management-route', f.send)); assert.equal(f.calls.provider, 0);
  await assert.rejects(context.finalize({ outcome: 'failed', receiptRef: 'terminal' }), /call_rejected/);
});
test('a caller-controlled cancellation reason cannot escape as a host error', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort('private-caller-value');
  await assert.rejects(createEngineHostBoundary(f.bindings).admit(new Request('http://localhost/', { signal: controller.signal })),
    error => error instanceof Error && error.message === 'engine_host_call_cancelled');
  assert.equal(f.calls.admission, 0);
});
test('a rejected accounting callback cannot be followed by successful completion', async () => {
  const f = fixture();
  const context = await createEngineHostBoundary({ ...f.bindings, usage: async () => false as true }).admit(new Request('http://localhost/'));
  await assert.rejects(context.usage({ receiptRef: 'usage', inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }));
  await assert.rejects(context.finalize({ outcome: 'completed', receiptRef: 'terminal' }), /unresolved_effect/);
  assert.equal(f.calls.finalization, 0);
});

test('client disconnect cancels new dispatch but preserves final usage settlement', async () => {
  const f = fixture(), controller = new AbortController();
  const context = await createEngineHostBoundary({ ...f.bindings,
    usage: async ({ signal }) => { assert.equal(signal.aborted, false); f.calls.usage++; return true; },
  }).admit(new Request('http://localhost/', { signal: controller.signal }));
  await context.attempt(f.attempt('admitted-send'), f.send);
  controller.abort();
  const receipt = { receiptRef: 'partial-usage', inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 };
  await Promise.all([context.usage(receipt), context.usage(receipt)]);
  await assert.rejects(context.attempt(f.attempt('after-disconnect'), f.send), /call_cancelled/);
  await assert.rejects(context.management('after-disconnect', f.send), /call_cancelled/);
  await context.finalize({ outcome: 'cancelled', receiptRef: 'cancelled-terminal' });
  assert.equal(f.calls.provider, 1); assert.equal(f.calls.authorization, 1);
  assert.equal(f.calls.usage, 1); assert.equal(f.calls.finalization, 1);
});

test('disconnect does not abort accounting already waiting for its owner', async () => {
  const f = fixture(), controller = new AbortController();
  let entered!: () => void, accept!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const acknowledged = new Promise<void>(resolve => { accept = resolve; });
  const context = await createEngineHostBoundary({ ...f.bindings, usage: async ({ signal }) => {
    entered(); await acknowledged; assert.equal(signal.aborted, false); f.calls.usage++; return true;
  } }).admit(new Request('http://localhost/', { signal: controller.signal }));
  const pending = context.usage({ receiptRef: 'in-flight-usage', inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 });
  await started; controller.abort();
  const finalization = context.finalize({ outcome: 'cancelled', receiptRef: 'settled-terminal' });
  assert.equal(f.calls.finalization, 0);
  accept(); await Promise.all([pending, finalization]);
  assert.equal(f.calls.usage, 1); assert.equal(f.calls.finalization, 1);
  assert.equal(f.calls.provider, 0);
});
