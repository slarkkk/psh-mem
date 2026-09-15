---
description: "The built-in curated memory provider: two bounded entry lists persisted through the storage domain and rendered into one system-prompt section frozen per session."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-curated

English | [中文](README.zh.md)

## Summary

The bundled provider of the memory capability. It owns the `memory` and `user` targets, persists each as a bounded list of entries in a storage domain, and renders them into one system-prompt section. Its write path is the batch semantics the capability defines: every operation in a call is applied against the target's final character budget, or none of them is. The prompt section is captured once per session, so entries stay visible without moving the prompt prefix a session has already sent.

## Table of Contents

- [Storage](#storage)
- [Write semantics](#write-semantics)
- [The frozen section](#the-frozen-section)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="storage"></a>
## Storage

Entries live in one storage domain named `memory`, opened through `ctx.storageDomain` and closed by the plugin's own effect disposer. The domain holds one record per target, so a deployment gets the durability, schema validation, and single-writer guarantees of the storage backend it routes that domain to — by default the JSON backend under `$DSH_HOME/storages`.

Entries are stored as a list, and the character budget is measured over that list joined by the entry delimiter, so the separators count toward the budget a target's limit bounds.

<a id="write-semantics"></a>
## Write semantics

One call carries a list of operations, and the character budget is checked on the **final result of the whole list**, never per operation. That is what lets one call remove or shorten stale entries and add a new entry together when the add alone would overflow.

Operations are all-or-nothing: a failure leaves the stored entries exactly as they were and returns the current snapshot, so the caller can see what to consolidate before retrying. `replace` and `remove` locate their entry by a substring of its text; a substring matching several distinct entries is rejected as ambiguous rather than resolved by position. An exact duplicate `add` succeeds without storing a second copy.

A successful write reports usage and a completion note and never echoes the entry list, because an echoed list invites the model to hunt for more to fix and repeat work it already did.

A failed write never holds the turn hostage. After the configured number of failed consolidation attempts within one turn, later failures in that turn become terminal: their message tells the caller to stop retrying, leave memory unchanged, and continue replying. A successful write resets the count, and the count resets at each turn boundary.

<a id="the-frozen-section"></a>
## The frozen section

The provider registers one system-prompt section whose text is rendered on first assembly for a scope and then reused verbatim for that scope's remaining assemblies. A write made during a session therefore does not move the prompt prefix that session has already sent; the model reads its own write back from the tool result, and from the section in a later session.

The section states this in its own preamble, so a model that has just written an entry does not read the unchanged text as a failed write. A target with no entries contributes no block, and a deployment whose targets are both empty carries no section at all — the assembly drops an empty section.

<a id="configuration"></a>
## Configuration

| Field | Default | Effect |
|---|---|---|
| `memoryLimit` | `2200` | Character budget of the `memory` target, measured over its joined entries. |
| `userLimit` | `1375` | Character budget of the `user` target, measured over its joined entries. |
| `consolidationFailureLimit` | `3` | Failed `over-budget` and `no-match` writes in one turn before that target's writes turn terminal for the turn. |
| `providerName` | `curated` | Name this provider registers under on `ctx.memory`. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-memory-curated) is the exhaustive source for every accepted field and its JSDoc.

## Model Experience

### The curated memory system-prompt section

#### What the model sees

One prompt section, present only when at least one target holds entries. It opens with a preamble stating what the entries are and that the snapshot is frozen for the session, then carries one block per non-empty target headed by the target name and its usage.

##### Verbatim section preamble

```markdown
Curated memory: durable entries that outlive this session. This snapshot is frozen for the current session, so an entry written now appears here only in a later session.
```

##### Verbatim per-target block shape

```markdown
## <target> (<pct>% — <chars>/<limit> chars)
<entry>
§
<entry>
```

#### Token effect

Retained. The section is part of the request prefix for every turn of a session, sized by the entries it carries and capped by the two target limits plus the preamble and headers. Zero when neither target holds an entry.

#### KV Cache effect

Prefix-stable within a session by construction: the text is captured on the scope's first assembly and never re-rendered, so a write made later in the same session cannot invalidate the prefix. A new session renders a fresh snapshot, which can differ from the previous session's.

## Known Limitations and Deferred Work

- **Memory is machine-scoped, not project-scoped** — both targets are shared by every session the deployment serves, so a fact learned in one project is offered in another. A deployment wanting isolation configures a separate storage domain rather than filtering entries.
- **A session cannot read back its own write from the prompt** — the freeze is what keeps the prefix stable; the tool result is the only in-session confirmation. The section preamble states this to the model, but a caller reading only the prompt can still be surprised.
- **No merge or supersede operation** — an entry can be replaced by substring match or removed, but nothing merges two overlapping entries automatically, so keeping the store coherent is the caller's work.
- **No provenance on an entry** — entries record their text only, not which session or turn wrote them, so a reader cannot tell when or why an entry was added.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the store validates every relationship while it builds its own result: a rejected write returns the entries it did not change, and a success returns the state the write produced. The freeze is a pure function of the scope and the store's state at capture time, so an outside observer would be recomputing the call it was invoked from.

The consolidation-failure counter is per turn and per store, not per target. It exists to stop a retry loop from consuming a turn's budget; the failure it counts is the caller's, not the target's, so counting it once across targets is the honest scope.

</details>
