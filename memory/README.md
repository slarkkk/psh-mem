---
description: "The cross-session memory capability definition: the memory vocabulary, the MemoryProvider contract, and the ctx.memory registry that composes providers."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

## Summary

The Service Definition for cross-session memory. It owns the shared vocabulary — targets, entries, operations, snapshots, and write outcomes — plus the `MemoryProvider` contract and the concrete `ctx.memory` registry that registers providers, enforces one owner per curated target, and routes reads, writes, and recall. Providers own every storage and retrieval decision, so a backend can be replaced without changing the tool schema or the prompt section. Consumers reach every backend through this service and never through a provider directly.

## Table of Contents

- [The capability](#the-capability)
- [The provider contract](#the-provider-contract)
- [Target ownership](#target-ownership)
- [Registration and disposal](#registration-and-disposal)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="the-capability"></a>
## The capability

`ctx.memory` is a `MemoryService`. It holds a provider table and a target-ownership table, and it exposes four operations: `register`, `snapshot`, `write`, and `recall`. Every operation a consumer needs is on this service; the provider facets are the only swappable part.

The generated [Cordis surface](../../../docs/subsystems/memory.md#cordis-surface) is the exhaustive source for every method and its JSDoc.

The vocabulary these methods exchange — targets, entries, operations, snapshots, write outcomes, and recall requests — is declared in [`src/types.ts`](src/types.ts) and documented on the [memory subsystem page](../../../docs/subsystems/memory.md).

<a id="the-provider-contract"></a>
## The provider contract

A provider is a plain object, not a service. It declares a unique `name` and up to two facets:

| Facet | Member | Contract |
|---|---|---|
| Curated store | `targets` + `store` | Owns the named targets; `snapshot(target)` reads them and `write(target, operations)` applies entry mutations against the target's final character budget. |
| Recall | `recall` | Retrieves context for an upcoming step through `recall(request, signal)`. |

A provider with no curated store omits both `targets` and `store`, which is the recall-only shape. A provider that claims targets without a store facet is rejected at registration rather than failing later.

One provider failing never denies another: `recall` collects from every provider offering the facet, logs a rejection as a warning, and returns the others' results.

<a id="target-ownership"></a>
## Target ownership

Exactly one provider owns each curated target. `snapshot` throws when no provider owns the requested target, because a caller asking for an unowned target is a composition error. `write` does not throw: it settles as `{ ok: false, code: 'unowned-target' }`, so a deployment that mounts only one target still gives its caller an actionable answer instead of an exception.

<a id="registration-and-disposal"></a>
## Registration and disposal

`register` returns the exact disposer that removes the provider and frees the targets it owned. The calling plugin owns the lifetime and wraps the call in `ctx.effect`, so unloading the contributing fiber withdraws the provider with it.

Registration fails loud on the three compositions that cannot be resolved later: a duplicate provider name, two providers claiming one target, and targets claimed without a store facet.

```yaml
- insert:
    - id: memory
      name: '@deepseek-ai/dsh-memory'

    - id: memory-curated
      name: '@deepseek-ai/dsh-memory-curated'
```

No shipped bundle mounts this capability; a deployment composes it with its own patch layer. See the [memory group README](../README.md) for the example overlays.

## Model Experience

Indirectly, through the providers registered on it and `dsh-tool-memory`, which turn stored entries and recalled text into a prompt section and tool results.

#### KV Cache effect

No direct invalidation; the registered provider owns its prompt section's byte stability and the tool consumer owns its schema.

## Known Limitations and Deferred Work

- **One provider per target** — the capability cannot merge two providers' entries for one target, and a second claimant is rejected at registration rather than arbitrated. A backend that wants to combine sources must present one facet.
- **No cross-process change notification** — providers persist through whatever backend they choose, and this service does not propagate a write made in another process to a live registry. A long-running host observes only its own registrations.
- **No write ordering guarantee across providers** — `write` routes to exactly one owning provider, so a deployment cannot express a single atomic operation spanning two targets owned by different providers.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The class is concrete, not abstract, because the swappable part of this capability is the provider facet rather than the service. This mirrors the storage hub, where `ctx.storage` is concrete and backends are registered into it.

No invariant companion is published because every fact worth asserting is a within-call relationship this service already enforces at the point of the call: the ownership table is written only under the same registration that validates it, and each routing decision reads the table it just wrote. An external observer re-deriving those would be checking the call it was invoked from.

</details>
