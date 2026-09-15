/**
 * Vocabulary the curated memory provider shares between its store, its
 * renderer, and its plugin entry: the capability's memory names re-exported so
 * a consumer of this package needs no second import, plus the outcome and match
 * types the store uses internally.
 * @module @deepseek-ai/dsh-memory-curated/types
 */

import type { MemoryFailureCode } from '@deepseek-ai/dsh-memory'

export type {
  MemoryEntry,
  MemoryFailureCode,
  MemoryOperation,
  MemoryProvider,
  MemoryRecall,
  MemoryRecallFacet,
  MemoryRecallRequest,
  MemorySnapshot,
  MemoryStoreFacet,
  MemoryTarget,
  MemoryWriteResult,
} from '@deepseek-ai/dsh-memory'

/**
 * Why one operation was rejected before the target's budget was measured.
 * These are per-operation faults: the character budget is checked once, against
 * the final result of the whole operation list, and reports `over-budget`
 * instead.
 */
export type OperationFailureCode = Extract<
  MemoryFailureCode,
  'empty-content' | 'empty-old-text' | 'no-match' | 'ambiguous-match'
>

/** One rejected operation: its stable code and the message the caller reads. */
export interface OperationFailure {
  /** Stable failure class, restricted to the faults one operation raises on its own. */
  readonly code: OperationFailureCode
  /** Actionable explanation of this one operation's rejection. */
  readonly message: string
}

/**
 * Where one `oldText` landed among a target's entries.
 *
 * `distinct` counts the distinct entry texts containing `oldText`, so identical
 * duplicates count once and never make an address ambiguous; `index` is the
 * position of the first of them, and `-1` when nothing matched.
 */
export interface EntryMatch {
  /** Number of distinct matching entry texts; `0` means no match at all. */
  readonly distinct: number
  /** Position of the first matching entry, or `-1` when `distinct` is `0`. */
  readonly index: number
}
