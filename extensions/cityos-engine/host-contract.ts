/** Host-owned admission and accounting contracts, independent of optional plugins.
 * The runtime integration must call this boundary at every physical transport.
 */
export interface EngineHostAdmission { readonly admitted: true; readonly operationRef: string; readonly context: unknown }
export interface EngineProviderAttempt {
  readonly attemptRef: string; readonly providerRef: string; readonly accountRef: string;
  readonly transport: 'http' | 'websocket' | 'native'; readonly destination: string;
}
export interface EngineUsageReceipt {
  readonly receiptRef: string; readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens: number;
}
export interface EngineFinalization { readonly outcome: 'completed' | 'failed' | 'cancelled'; readonly receiptRef: string }
export interface EngineHostBindings {
  admit(input: { readonly request: Request; readonly signal: AbortSignal }): Promise<EngineHostAdmission>;
  authorizeProviderAttempt(input: { readonly admission: EngineHostAdmission; readonly attempt: EngineProviderAttempt; readonly signal: AbortSignal }): Promise<true>;
  usage(input: { readonly admission: EngineHostAdmission; readonly receipt: EngineUsageReceipt; readonly signal: AbortSignal }): Promise<true>;
  finalize(input: { readonly admission: EngineHostAdmission; readonly result: EngineFinalization; readonly signal: AbortSignal }): Promise<true>;
  management(input: { readonly admission: EngineHostAdmission; readonly routeRef: string; readonly signal: AbortSignal }): Promise<true>;
}
export class EngineHostBoundaryError extends Error {
  constructor(code: string) { super(code); this.name = 'EngineHostBoundaryError'; }
}
const fail = (code: string): never => { throw new EngineHostBoundaryError(code); };
const reference = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\u0000-\u0020\u007f]/u.test(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Transient request coordination only; canonical authority and deduplication stay with the host. */
export function createEngineHostBoundary(input: EngineHostBindings, hookDeadlineMs = 15000) {
  const names = ['admit', 'authorizeProviderAttempt', 'usage', 'finalize', 'management'] as const;
  if (!input || names.some(name => typeof input[name] !== 'function')) fail('engine_host_bindings_required');
  if (!Number.isSafeInteger(hookDeadlineMs) || hookDeadlineMs < 1 || hookDeadlineMs > 30000) fail('engine_host_deadline_invalid');
  // Capture each binding. Later mutation of a bootstrap object cannot replace policy.
  const bindings = Object.freeze(Object.fromEntries(names.map(name => [name, input[name].bind(input)]))) as unknown as EngineHostBindings;
  async function hook<T>(signal: AbortSignal, run: (bounded: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) fail('engine_host_call_cancelled');
    const timeout = new AbortController(), combined = AbortSignal.any([signal, timeout.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined, cancelled: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      cancelled = () => reject(new EngineHostBoundaryError('engine_host_call_cancelled'));
      combined.addEventListener('abort', cancelled, { once: true });
      timer = setTimeout(() => timeout.abort(), hookDeadlineMs);
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => run(combined)), deadline]);
      combined.throwIfAborted(); return result;
    } catch { return fail('engine_host_call_rejected'); }
    finally { clearTimeout(timer); if (cancelled) combined.removeEventListener('abort', cancelled); }
  }
  return Object.freeze({
    async admit(request: Request) {
      if (!(request instanceof Request)) fail('engine_host_request_required');
      const raw = await hook(request.signal, signal => bindings.admit({ request, signal }));
      if (!exact(raw, ['admitted', 'operationRef', 'context']) || raw.admitted !== true || !reference(raw.operationRef)) fail('engine_host_admission_rejected');
      const admission = Object.freeze({ ...raw }) as EngineHostAdmission;
      let state: 'active' | 'finishing' | 'finished' = 'active';
      let rejectedEffect = false;
      let finalization: { identity: string; promise: Promise<void> } | undefined;
      const usages = new Map<string, { identity: string; promise: Promise<void> }>();
      const attempts = new Set<string>();
      const pending = new Set<Promise<unknown>>();
      const active = () => { if (state !== 'active') fail('engine_host_request_finalized'); if (request.signal.aborted) fail('engine_host_call_cancelled'); };
      const tracked = async <T>(run: () => Promise<T>): Promise<T> => {
        const work = Promise.resolve().then(run); pending.add(work);
        try { return await work; } catch (error) { rejectedEffect = true; throw error; } finally { pending.delete(work); }
      };
      return Object.freeze({
        operationRef: admission.operationRef,
        async attempt<T>(rawAttempt: EngineProviderAttempt, send: () => Promise<T>): Promise<T> {
          active();
          if (!exact(rawAttempt, ['attemptRef', 'providerRef', 'accountRef', 'transport', 'destination'])
            || ![rawAttempt.attemptRef, rawAttempt.providerRef, rawAttempt.accountRef].every(reference)
            || !['http', 'websocket', 'native'].includes(rawAttempt.transport) || typeof send !== 'function') fail('engine_host_attempt_invalid');
          let destination: URL; try { destination = new URL(rawAttempt.destination); } catch { return fail('engine_host_destination_invalid'); }
          if (!['http:', 'https:', 'ws:', 'wss:'].includes(destination.protocol) || destination.username || destination.password || destination.hash)
            fail('engine_host_destination_invalid');
          if (attempts.size >= 1024 || attempts.has(rawAttempt.attemptRef)) fail('engine_host_attempt_identity_reused');
          attempts.add(rawAttempt.attemptRef);
          const attempt = Object.freeze({ ...rawAttempt });
          return tracked(async () => {
            if (await hook(request.signal, signal => bindings.authorizeProviderAttempt({ admission, attempt, signal })) !== true) fail('engine_host_attempt_denied');
            active(); return send();
          });
        },
        async usage(rawReceipt: EngineUsageReceipt): Promise<void> {
          active();
          if (!exact(rawReceipt, ['receiptRef', 'inputTokens', 'outputTokens', 'cachedInputTokens']) || !reference(rawReceipt.receiptRef)
            || ![rawReceipt.inputTokens, rawReceipt.outputTokens, rawReceipt.cachedInputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) fail('engine_host_usage_invalid');
          const receipt = Object.freeze({ ...rawReceipt }), identity = JSON.stringify(receipt), previous = usages.get(receipt.receiptRef);
          if (previous) { if (previous.identity !== identity) fail('engine_host_usage_conflict'); return previous.promise; }
          if (usages.size >= 1024) fail('engine_host_usage_bound_exceeded');
          const promise = tracked(async () => {
            if (await hook(request.signal, signal => bindings.usage({ admission, receipt, signal })) !== true) fail('engine_host_usage_rejected');
          });
          usages.set(receipt.receiptRef, { identity, promise }); return promise;
        },
        async management<T>(routeRef: string, invoke: () => Promise<T>): Promise<T> {
          active(); if (!reference(routeRef) || typeof invoke !== 'function') fail('engine_host_management_invalid');
          return tracked(async () => {
            if (await hook(request.signal, signal => bindings.management({ admission, routeRef, signal })) !== true) fail('engine_host_management_denied');
            active(); return invoke();
          });
        },
        finalize(rawResult: EngineFinalization): Promise<void> {
          if (!exact(rawResult, ['outcome', 'receiptRef']) || !['completed', 'failed', 'cancelled'].includes(rawResult.outcome) || !reference(rawResult.receiptRef))
            fail('engine_host_finalization_invalid');
          const result = Object.freeze({ ...rawResult }), identity = JSON.stringify(result);
          if (finalization) { if (identity !== finalization.identity) fail('engine_host_finalization_conflict'); return finalization.promise; }
          state = 'finishing';
          // Finalization is a host effect even after client disconnect. Give it its own bounded signal.
          const signal = new AbortController().signal;
          const promise = (async () => {
            const outstanding = await hook(signal, () => Promise.allSettled([...pending]));
            if ((rejectedEffect || outstanding.some(item => item.status === 'rejected')) && result.outcome === 'completed') fail('engine_host_unresolved_effect');
            if (await hook(signal, bounded => bindings.finalize({ admission, result, signal: bounded })) !== true) fail('engine_host_finalization_rejected');
            state = 'finished';
          })();
          finalization = { identity, promise }; return promise;
        },
      });
    },
  });
}
