/**
 * Session-corpus retrieval behind the recall facet this package registers.
 *
 * @module @deepseek-ai/dsh-memory-recall/recall
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryRecall, MemoryRecallFacet, MemoryRecallRequest } from '@deepseek-ai/dsh-memory'
import type { SessionSearchHit } from '@deepseek-ai/dsh-session-query'

/**
 * Build the recall facet this package registers on `ctx.memory`.
 *
 * The facet owns retrieval failure: a disabled or broken search settles as an
 * empty result, so the registry — which logs a rejecting facet on every call —
 * never sees a rejection, and the condition is reported once per facet instance.
 * @param ctx - context carrying the session-query engine and the plugin logger.
 * @param providerName - provider name carried by every returned recall.
 * @returns the facet that searches the corpus and names each hit it returns.
 */
export function createRecallFacet(ctx: Context, providerName: string): MemoryRecallFacet {
  let reported = false
  return {
    async recall(request: MemoryRecallRequest, signal?: AbortSignal): Promise<readonly MemoryRecall[]> {
      let hits: readonly SessionSearchHit[]
      try {
        hits = await searchCorpus(ctx, request, signal)
      } catch (error: unknown) {
        // A disabled or broken index is one standing condition, not one failure
        // per step; retrieval is a side effect and must never fail a turn.
        if (!reported) {
          reported = true
          ctx.logger.warn(`memory-recall: session search failed, injecting no recall: ${String(error)}`)
        }
        return []
      }
      return hits.map(hit => toRecall(providerName, hit))
    },
  }
}

/**
 * Search the corpus and drop the querying session from the page.
 *
 * One spare result is requested so that dropping the querying session still
 * leaves the caller's cap filled. A disabled or failing search rejects: the
 * facet owns logging it once and reporting nothing.
 * @param ctx - context carrying the session-query engine.
 * @param request - query text, querying session, and the caller's result cap.
 * @param signal - optional cancellation forwarded to the search backend.
 * @returns the ranked hits that survive self-exclusion and the caller's cap.
 */
async function searchCorpus(
  ctx: Context,
  request: MemoryRecallRequest,
  signal?: AbortSignal,
): Promise<SessionSearchHit[]> {
  const page = await ctx.sessionQuery.searchSessions({
    query: request.query,
    limit: request.limit + 1,
  }, signal === undefined ? undefined : { signal })
  return page.items
    .filter(hit => hit.header.id !== request.sessionId)
    .slice(0, request.limit)
}

/**
 * Read one corpus hit as a recall a consumer can skip by identity.
 * @param providerName - provider name carried by the recall.
 * @param hit - grouped corpus hit to read.
 * @returns the recall naming the source session and the event that matched.
 */
function toRecall(providerName: string, hit: SessionSearchHit): MemoryRecall {
  return {
    provider: providerName,
    label: hit.header.id,
    key: `${hit.header.id}:${hit.bestMatch.seq}`,
    text: hit.bestMatch.snippet,
  }
}
