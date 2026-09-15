/**
 * Public durable records for one injected recall block rendered from other
 * sessions' logs.
 *
 * @module @deepseek-ai/dsh-memory-recall/types
 */

import type { MemoryRecall } from '@deepseek-ai/dsh-memory'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Durable source record carried by the injected `user/message`. A reader of the
 * log sees which query produced the block, every recall the memory service
 * returned for it, and which provider supplied each one, without re-running
 * retrieval.
 */
export interface MemoryRecallSource {
  /** Producer discriminant, unique to this package. */
  kind: 'memory-recall'
  /** Material recalled out of other sessions' logs (the `recall` context form). */
  form: 'recall'
  /** Record version for readers of a durable log. */
  version: 1
  /** Session the recall was injected into. */
  readonly sessionId: SessionId
  /** Direct user text the recalls were retrieved for. */
  readonly query: string
  /**
   * Recalls exactly as the memory service returned them, in injected order. A
   * {@link MemoryRecall.key} that a provider set stays verbatim: it is that
   * provider's own identity for the recalled unit, and this record is what a
   * later step folds out of the log to skip repeats.
   */
  readonly items: readonly MemoryRecall[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-recall': MemoryRecallSource
  }
}
