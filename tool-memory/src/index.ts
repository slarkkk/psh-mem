/**
 * Model-facing `memory` tool: the only way the model writes durable facts that
 * survive the session. Every call carries a whole batch of entry mutations for
 * one target and delegates it to `ctx.memory`, which applies it atomically
 * against that target's final character budget. The plugin registers exactly
 * one tool and no system-prompt section — the model guidance is the tool
 * description, and the prompt section that renders the entries belongs to the
 * store provider. Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: also resolves the required ctx.memory service declaration.
import type { MemoryOperation, MemorySnapshot, MemoryWriteResult } from '@deepseek-ai/dsh-memory'
import { MEMORY_DESCRIPTION } from './description.ts'
import { MEMORY_OUTPUT_SCHEMA, MEMORY_PARAMETERS } from './schema.ts'
import type { MemoryToolSnapshot, MemoryToolValue, RawMemoryOperation } from './types.ts'

export const name = 'tool-memory'
export const inject = ['tools', 'memory']

/**
 * Narrow the model's operation objects into the capability's vocabulary.
 *
 * The parameter schema cannot make `content` required for `add`/`replace` and
 * `oldText` required for `replace`/`remove`, so an omitted field becomes the
 * empty string. The provider then settles its own `empty-content` or
 * `empty-old-text` outcome, which keeps one authority over the failure
 * vocabulary instead of a second, tool-owned copy of it.
 * @param operations - schema-validated operation objects supplied by the model.
 * @returns one `MemoryOperation` per supplied object, in the supplied order.
 */
function toOperations(operations: readonly RawMemoryOperation[]): MemoryOperation[] {
  return operations.map((operation) => {
    if (operation.action === 'add') {
      return { action: 'add', content: operation.content ?? '' }
    }
    if (operation.action === 'replace') {
      return { action: 'replace', oldText: operation.oldText ?? '', content: operation.content ?? '' }
    }
    return { action: 'remove', oldText: operation.oldText ?? '' }
  })
}

/**
 * Copy one provider snapshot into the canonical value's plain JSON snapshot.
 * The capability owns its entries as a readonly list; the tool's output schema
 * declares a mutable array, so copying into a fresh array is what makes the two
 * contracts meet without widening the capability.
 * @param snapshot - the snapshot the provider settled with.
 * @returns the canonical snapshot, with a fresh entries array.
 */
function toSnapshot(snapshot: MemorySnapshot): MemoryToolSnapshot {
  return {
    target: snapshot.target,
    entries: [...snapshot.entries],
    chars: snapshot.chars,
    limit: snapshot.limit,
  }
}

/**
 * Build the tool's canonical value from one settled provider outcome. Every
 * declared field is copied explicitly, and a key the settled branch does not
 * carry is omitted rather than set to `undefined`: the tool owns its output
 * contract, so a provider's private additions never reach the model, and
 * `exactOptionalPropertyTypes` plus the schema's `additionalProperties: false`
 * both stay satisfied.
 * @param result - the outcome `ctx.memory.write` settled.
 * @returns the canonical value declared by the tool's output schema.
 */
function toCanonicalValue(result: MemoryWriteResult): MemoryToolValue {
  if (result.ok) {
    return { ok: true, note: result.note, snapshot: toSnapshot(result.snapshot) }
  }
  if (result.snapshot === undefined) {
    return { ok: false, code: result.code, message: result.message }
  }
  return { ok: false, code: result.code, message: result.message, snapshot: toSnapshot(result.snapshot) }
}

/**
 * Render one settled memory outcome for the model. A success confirms the batch
 * and reports budget usage without echoing the entries, because an echoed list
 * invites a redundant repeat call. A rejection states the failure and, when the
 * provider could observe target state, lists the current entries so the next
 * batch can free room and add together.
 * @param value - the canonical value `execute` returned.
 * @returns one text block; the content is a single line on success and a short
 * header plus one line per entry on a rejection with a snapshot.
 */
function renderMemory(value: MemoryToolValue): { type: 'text'; text: string }[] {
  if (value.ok) {
    const usage = value.snapshot === undefined ? '' : ` (${value.snapshot.chars}/${value.snapshot.limit} chars used)`
    return [{ type: 'text', text: `${value.note ?? 'Memory updated.'}${usage}` }]
  }
  const lines = [value.message ?? 'Memory write rejected.']
  if (value.snapshot !== undefined) {
    lines.push(`Current ${value.snapshot.target} entries (${value.snapshot.chars}/${value.snapshot.limit} chars):`)
    for (const entry of value.snapshot.entries) lines.push(`- ${entry}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Register the `memory` tool on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry and the memory capability.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'memory',
    description: MEMORY_DESCRIPTION,
    parameters: MEMORY_PARAMETERS,
    output: {
      schema: MEMORY_OUTPUT_SCHEMA,
      render: (_args, value) => renderMemory(value),
    },
    async execute(args) {
      return toCanonicalValue(await ctx.memory.write(args.target, toOperations(args.operations)))
    },
  }))
}
