/**
 * Cross-session recall: a `ctx.memory` provider that searches the session
 * corpus, and a prepended `agent/pre-step` listener that injects what it
 * recalls into the live turn as durable, model-visible context.
 *
 * The injected block reaches the model as one extra `user/message` that the
 * agent loop appends to the durable surface, so nothing here adds a session
 * event type. Retrieval is best-effort: a disabled or failing search is reported
 * once and contributes nothing, and a recall this session already carries is
 * never injected a second time.
 *
 * @module @deepseek-ai/dsh-memory-recall
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryRecall } from '@deepseek-ai/dsh-memory'
import type { Session } from '@deepseek-ai/dsh-session'
import { Config, resolveConfig } from './config.ts'
import { createRecallFacet } from './recall.ts'
import { renderRecallBlock } from './render.ts'
import type { MemoryRecallSource } from './types.ts'

export { Config }
export type { MemoryRecallSource } from './types.ts'

/** Cordis plugin name, and the provider name this recall path registers under. */
export const name = 'memory-recall'

/** Services this plugin reads: the provider registry and the corpus search. */
export const inject = ['memory', 'sessionQuery']

/**
 * Register the recall provider and the pre-step injection for the lifetime of `ctx`.
 * @param ctx - plugin context; disposing its fiber removes both registrations.
 * @param config - recall limits; an omitted field takes its documented default.
 * @throws when a resolved limit is not a positive safe integer.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  // The provider stores nothing curated: it omits `targets`, so it owns no entry
  // list and contributes only its recall facet.
  ctx.effect(
    () => ctx.memory.register({ name, recall: createRecallFacet(ctx, name) }),
    'memory-recall.provider',
  )

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const query = directUserQuery(decision.messages)
    if (query.length < resolved.minQueryChars) return decision
    // The capability composes every registered recall provider and isolates a
    // failing one, so retrieval contributes whatever succeeded and never fails
    // the turn.
    const recalled = await ctx.memory.recall(
      { query, sessionId: agent.session.id, limit: resolved.maxRecalls },
      signal,
    )
    const alreadyInjected = injectedRecallKeys(agent.session, decision.messages)
    const fresh = recalled.filter((recall) => {
      const identity = recallIdentity(recall)
      // A provider that names no unit of retrieval accepts that its recall repeats.
      return identity === undefined || !alreadyInjected.has(identity)
    })
    const rendered = renderRecallBlock(agent.session.id, query, fresh, resolved.maxRecallBytes)
    if (rendered === undefined) return decision
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          source: rendered.source,
          content: [{ type: 'text', text: rendered.text }],
        }),
      ],
    }
  }, { prepend: true })
}

/**
 * Concatenate the text of the step's direct user-authored messages.
 * @param messages - messages the pre-step decision carries.
 * @returns trimmed direct user text, empty when the step carries none.
 */
function directUserQuery(messages: readonly UserMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Collect the identities of every recall this session has already injected.
 *
 * The log holds injections from earlier steps and turns; the step's own
 * messages cover an injection this listener has already contributed to the
 * decision under construction.
 * @param session - session entering the step.
 * @param messages - messages the pre-step decision carries.
 * @returns the provider-and-key identity of every recall present in either source.
 */
function injectedRecallKeys(session: Session, messages: readonly UserMessage[]): Set<string> {
  const keys = new Set<string>()
  const record = (source: MemoryRecallSource): void => {
    for (const item of source.items) {
      const identity = recallIdentity(item)
      if (identity !== undefined) keys.add(identity)
    }
  }
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  for (const event of session.snapshotEvents()) {
    if (event.type === 'user/message' && event.data.source.kind === 'memory-recall') record(event.data.source)
  }
  for (const message of messages) {
    if (message.source.kind === 'memory-recall') record(message.source)
  }
  return keys
}

/**
 * Identify one recall by its provider and the provider's own key for it.
 * @param recall - recall to identify.
 * @returns a cross-provider-safe identity, or `undefined` when its provider named no unit.
 */
function recallIdentity(recall: MemoryRecall): string | undefined {
  return recall.key === undefined ? undefined : JSON.stringify([recall.provider, recall.key])
}
