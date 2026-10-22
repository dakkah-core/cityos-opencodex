# Engine host boundary

`host-contract.ts` defines the mandatory admission, physical-attempt authorization,
usage, finalization and management ports for the engine extraction. It captures
bindings during bootstrap, rejects missing bindings, bounds asynchronous host
calls, and requires literal `true` acknowledgments. Host exceptions become bounded
error codes. Each physical retry, account fallback or reconnect needs a distinct
attempt and a fresh authorization call.

Receipt deduplication is transient coordination within one request. The CityOS
host retains durable operation identities, replay protection, policy, tenant
scope and accounting. A failed or ambiguous finalization remains failed; the
boundary never creates a terminal receipt on behalf of an owner.

The current upstream runtime does not yet invoke these ports. These unit tests
qualify this contract only. The server factory, all transport call sites, packed
engine and CMS migration must be qualified before this boundary can enforce
policy in the gateway. The existing CMS runtime remains active during that work.

Run the contract tests with the selected canonical Node runtime:

```sh
node --test extensions/cityos-engine/host-contract.test.ts
```
