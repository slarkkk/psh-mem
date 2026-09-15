/**
 * System-prompt rendering for the curated targets. One section carries a block
 * per target that holds entries, and its text is captured once per assembly
 * scope and then reused, so a session's prompt prefix stays byte-stable for as
 * long as that session lives.
 * @module @deepseek-ai/dsh-memory-curated/render
 */

import type { MemorySnapshot, MemoryTarget } from '@deepseek-ai/dsh-memory'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { MEMORY_TARGETS } from './config.ts'

/**
 * Separator written between entries. It is the delimiter the budget is measured
 * over and the delimiter the prompt renders, so a rendered block is exactly the
 * measured string.
 */
export const ENTRY_DELIMITER = '\n§\n'

/**
 * Opening line of the curated section. It states what the entries are and that
 * the session's view is frozen, because a model that has just written an entry
 * would otherwise read the unchanged text as a failed write.
 */
const SECTION_PREAMBLE =
  'Curated memory: durable entries that outlive this session. This snapshot is frozen for the current session, '
  + 'so an entry written now appears here only in a later session.'

/**
 * Measure one entry list the way the character budget does: the entries joined
 * by {@link ENTRY_DELIMITER}, so the separators count too.
 * @param entries - entries in storage order.
 * @returns the character count a target's limit is compared against.
 */
export function measureEntries(entries: readonly string[]): number {
  return entries.join(ENTRY_DELIMITER).length
}

/**
 * Render the usage reading shared by a block's header and a write result.
 * @param snapshot - the snapshot to describe.
 * @returns `"<pct>% — <current>/<limit> chars"`.
 */
export function renderUsage(snapshot: MemorySnapshot): string {
  const percent = Math.round((snapshot.chars / snapshot.limit) * 100)
  return `${percent}% — ${snapshot.chars}/${snapshot.limit} chars`
}

/**
 * Render one target's block.
 * @param target - target the block names.
 * @param snapshot - the target's current entries and usage.
 * @returns the header and joined entries, or `''` when the target holds no entries.
 */
function renderBlock(target: MemoryTarget, snapshot: MemorySnapshot): string {
  if (snapshot.entries.length === 0) return ''
  return `## ${target} (${renderUsage(snapshot)})\n${snapshot.entries.join(ENTRY_DELIMITER)}`
}

/**
 * Render the whole section: the preamble plus one block per target that holds
 * entries. A target with no entries contributes nothing, and a deployment whose
 * targets are both empty carries no section at all.
 * @param read - synchronous read of one target's current state.
 * @returns the section text, or `''` when neither target holds entries.
 */
export function renderCuratedSection(read: (target: MemoryTarget) => MemorySnapshot): string {
  const blocks = MEMORY_TARGETS.map(target => renderBlock(target, read(target)))
    .filter(block => block.length > 0)
  if (blocks.length === 0) return ''
  return `${SECTION_PREAMBLE}\n\n${blocks.join('\n\n')}`
}

/**
 * Build the section's text provider together with its per-scope freeze. The
 * first assembly of a scope renders and stores the text; every later assembly
 * of that same scope returns the stored string without reading the store, so a
 * write made during a session never moves the prompt prefix that session has
 * already sent. The freeze is keyed by `AssembleContext.scope` — the agent a
 * session's assemblies run under — so a later session renders its own snapshot.
 * @param read - synchronous read of one target's current state.
 * @returns the provider to hand to `ctx.systemPrompt.section`.
 */
export function createSectionText(
  read: (target: MemoryTarget) => MemorySnapshot,
): (context: AssembleContext) => string {
  const frozen = new WeakMap<object, string>()
  let frozenUnscoped: string | undefined
  return (context) => {
    const scope = context.scope
    if (scope === undefined) {
      const cached = frozenUnscoped
      if (cached !== undefined) return cached
      const unscoped = renderCuratedSection(read)
      frozenUnscoped = unscoped
      return unscoped
    }
    const cached = frozen.get(scope)
    if (cached !== undefined) return cached
    const text = renderCuratedSection(read)
    frozen.set(scope, text)
    return text
  }
}
