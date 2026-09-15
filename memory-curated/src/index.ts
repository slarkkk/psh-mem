/**
 * The built-in curated memory provider: the two bounded entry lists DSH ships
 * (`memory` and `user`), persisted through `ctx.storageDomain`, registered on
 * `ctx.memory` as a `MemoryProvider`, and rendered into the system prompt as
 * one section.
 *
 * The section is frozen per session. It renders the stored entries the first
 * time a session assembles its prompt and returns that exact text for the rest
 * of the session, so the prompt prefix stays byte-stable and its cache stays
 * reusable. A write therefore changes what the store reports and what a LATER
 * session reads; the model does not see its own write in the prompt, and the
 * write result's completion note is the only in-session confirmation.
 *
 * There is no prompt-injection scanner and no external-drift guard: entries
 * live behind validated storage records that nothing outside this store writes,
 * and this repository owns no content-policing mechanism to reuse.
 * @module @deepseek-ai/dsh-memory-curated
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import { Config, MEMORY_TARGETS, resolveConfig } from './config.ts'
import { createSectionText } from './render.ts'
import { memoryDomainSpec } from './spec.ts'
import { CuratedMemoryStore } from './store.ts'

export { Config, MEMORY_TARGETS, resolveConfig }
export type { ResolvedConfig } from './config.ts'
export { ENTRY_DELIMITER, createSectionText, measureEntries, renderCuratedSection, renderUsage } from './render.ts'
export { curatedTargetRecord, memoryDomainSpec } from './spec.ts'
export type { CuratedTargetRecord } from './spec.ts'
export { CuratedMemoryStore } from './store.ts'
export type { EntryMatch, OperationFailure, OperationFailureCode } from './types.ts'

/** Cordis plugin name. */
export const name = 'memory-curated'

/** Services this provider needs before it can open its domain or register a facet. */
export const inject = ['storageDomain', 'systemPrompt', 'memory']

/** Name of the prompt section the curated blocks occupy. */
export const SECTION_NAME = 'memory:curated'

/**
 * Open the `memory` domain, register the curated provider on `ctx.memory`, and
 * contribute the frozen prompt section. Every registration is an effect on this
 * plugin's fiber, so unloading removes the provider, releases the domain, and
 * drops the section together.
 * @param ctx - plugin context carrying `storageDomain`, `systemPrompt`, and `memory`.
 * @param config - plugin configuration; a loader-supplied one already carries every default.
 * @returns resolution once the domain is open and every registration is installed.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const domain = await ctx.storageDomain.open(memoryDomainSpec)
  ctx.effect(() => () => domain.close(), 'memory-curated.domainClose')
  const store = new CuratedMemoryStore(domain.table('targets'), resolved)
  ctx.effect(() => ctx.memory.register({
    name: resolved.providerName,
    targets: MEMORY_TARGETS,
    store,
  }), 'memory-curated.provider')
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: resolved.sectionOrder,
    text: createSectionText(target => store.read(target)),
  }), 'memory-curated.section')
  ctx.on('session/event', (_session, event) => {
    // A turn boundary ends the consolidation allowance: a caller that exhausted
    // its cap answering one turn's failures must not stay silenced in the next.
    if (event.type === 'turn/end') store.resetTurn()
  })
}
