---
description: "The model-facing memory tool: one batch write over the curated memory targets, and the result rendering that keeps a rejected batch actionable."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

## Summary

The model-facing consumer of the memory capability. It registers exactly one tool, `memory`, whose single `operations` array carries every change to one target. All model guidance lives in the tool description: what belongs in memory, why one call carries every change, and what to do when a batch is rejected for exceeding the target's budget. The tool reads and writes only through `ctx.memory`, so it works unchanged over any registered provider.

## Table of Contents

- [The tool](#the-tool)
- [Why one batch shape](#why-one-batch-shape)
- [Result rendering](#result-rendering)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="the-tool"></a>
## The tool

The generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory) is the exhaustive source for the accepted arguments and the canonical output schema. In outline, one call names a `target` (`memory` or `user`) and an `operations` array whose items are `add`, `replace`, or `remove`; `replace` and `remove` identify their entry by a short unique substring of its text.

The tool delegates the whole array to `ctx.memory.write(target, operations)` and returns the settled outcome. It applies no policy of its own: the budget, the matching rules, and the all-or-nothing behavior belong to the owning provider, so a deployment that replaces the provider changes what the tool does without changing what the model is told.

<a id="why-one-batch-shape"></a>
## Why one batch shape

There is no separate single-operation form. One change is a batch of one, and the description says so. Two shapes for one intent would double the schema and let the model reach the same state two ways, which is the asymmetry the repository asks to be explained or removed.

<a id="result-rendering"></a>
## Result rendering

`output.render` turns the canonical value into one text block. A success reports the provider's confirmation and the target's usage. A rejection reports the failure message and, when the provider returned one, the current entries, because those are exactly what the model needs to decide what to consolidate before retrying.

The rendering is pure and reads only the canonical value, so a recorded call replays to the same content without re-running the provider.

## Model Experience

### The `memory` tool schema

#### What the model sees

The tool name, description, and argument schema in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory). The description is the tool's only guidance: this plugin registers no system-prompt section, so what to save, why one call carries every change, which target holds what, and what to skip all live in that text.

#### Token effect

Fixed per request while the tool is visible: the description and schema occupy prompt tokens on every turn. The registry owns the exact envelope. One call's result is a short confirmation or a failure message plus the target's entries, and the entry list appears only on a retryable rejection.

#### KV Cache effect

Independent of the curated section's stability: the tool schema is part of the same prompt prefix, so it invalidates reuse only when the tool set itself changes, which happens at composition time rather than during a turn.

## Known Limitations and Deferred Work

- **No read-only inspection operation** — the model can only mutate. It sees the current entries when it reads them out of a rejection, and the standing entries through the prompt section, but it cannot ask for a target's entries directly. A model that wants to review memory before changing it has no call for that.
- **No entry-level identity** — entries are addressed by a substring of their own text, so two entries sharing a distinctive phrase cannot be told apart by a caller that only knows the phrase. The provider resolves that as `ambiguous-match` rather than guessing.
- **One target per call** — a batch addresses exactly one target, so a change that must move a fact from `memory` to `user` needs two calls and is not atomic across them.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the tool holds no state: every call delegates to `ctx.memory` and returns what the provider settled, and the rendering is a pure projection of that value. An invariant observing the tool would be reading the provider's result a second time.

The tool deliberately registers no system-prompt section. `todo_write` sets the same precedent: guidance that belongs to one tool reads better in its description, where it travels with the schema, than in a separate prompt paragraph that can drift from it.

</details>
