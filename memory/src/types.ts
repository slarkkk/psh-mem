/**
 * Memory vocabulary shared by the capability definition, its providers, and the
 * model-facing tool consumer. A provider and its consumer exchange only these
 * names, so replacing the backend does not change the tool schema.
 * @module @deepseek-ai/dsh-memory/types
 */

/**
 * Which curated memory block a request addresses. `memory` holds notes the
 * agent keeps about its environment, conventions, and lessons; `user` holds
 * durable facts about the person it works for.
 */
export type MemoryTarget = 'memory' | 'user'

/**
 * One durable memory entry: free text stored whole. Entries are addressed for
 * replacement and removal by a substring of their own text, never by an index,
 * because a model cannot reliably cite a position it cannot see.
 */
export type MemoryEntry = string

/**
 * One entry mutation. A request carries several of these so that a single
 * call can free room by removing or shortening stale entries and add a new one
 * together, against the target's final character budget.
 */
export type MemoryOperation =
  | { readonly action: 'add'; readonly content: string }
  | { readonly action: 'replace'; readonly oldText: string; readonly content: string }
  | { readonly action: 'remove'; readonly oldText: string }

/** One target's stored entries and its current budget usage. */
export interface MemorySnapshot {
  /** Target this snapshot observes. */
  readonly target: MemoryTarget
  /** Stored entries in storage order. */
  readonly entries: readonly MemoryEntry[]
  /** Characters the joined entries occupy, measured against {@link limit}. */
  readonly chars: number
  /** Maximum characters this target may occupy. */
  readonly limit: number
}

/**
 * Why a write did not land. Every code is a settled outcome the model can act
 * on: the caller retries with different operations, or stops.
 */
export type MemoryFailureCode =
  | 'empty-content'
  | 'empty-old-text'
  | 'no-match'
  | 'ambiguous-match'
  | 'over-budget'
  | 'unowned-target'

/**
 * Outcome of one write request. A success carries the resulting snapshot; a
 * failure carries the snapshot the caller must reason about to retry, so a
 * rejection is actionable without a second read.
 */
export type MemoryWriteResult =
  | {
    readonly ok: true
    /** Entries and usage after the request was applied. */
    readonly snapshot: MemorySnapshot
    /** Short confirmation for the model; never a restatement of every entry. */
    readonly note: string
  }
  | {
    readonly ok: false
    /** Stable failure class. */
    readonly code: MemoryFailureCode
    /** Actionable explanation, including current entries when a retry can succeed. */
    readonly message: string
    /**
     * Entries and usage at rejection time, so the caller can choose what to
     * consolidate. Absent only for `unowned-target`, where no target state
     * exists to report.
     */
    readonly snapshot?: MemorySnapshot
  }

/** Read access to one provider's curated entries for a target it owns. */
export interface MemoryStoreFacet {
  /**
   * Read the target's current entries.
   * @param target - target this provider owns.
   * @returns the current snapshot.
   */
  snapshot(target: MemoryTarget): Promise<MemorySnapshot>

  /**
   * Apply every operation against the target's final character budget, or
   * apply none of them.
   * @param target - target this provider owns.
   * @param operations - entry mutations, applied in order.
   * @returns the settled outcome and the resulting or rejected snapshot.
   */
  write(target: MemoryTarget, operations: readonly MemoryOperation[]): Promise<MemoryWriteResult>
}

/** One query for context a provider retrieves from outside the current turn. */
export interface MemoryRecallRequest {
  /** Text to retrieve against. */
  readonly query: string
  /** Session the recall serves; a provider searching the corpus excludes it. */
  readonly sessionId: string
  /** Maximum recalls the caller accepts from this provider. */
  readonly limit: number
}

/** One piece of recalled context, with the provenance its framing must state. */
export interface MemoryRecall {
  /** Provider that produced this recall. */
  readonly provider: string
  /** Short label naming where the text came from. */
  readonly label: string
  /** Recalled text, rendered under the caller's framing and escaping rules. */
  readonly text: string
  /**
   * Stable identity for this recall, unique within its provider. A consumer
   * uses it to skip a recall it already injected, so a provider that can name
   * one unit of retrieval MUST set it; a provider whose results are not
   * individually identifiable omits it and accepts that its recall may repeat.
   */
  readonly key?: string
}

/** Retrieval access to context a provider supplies for an upcoming step. */
export interface MemoryRecallFacet {
  /**
   * Retrieve context relevant to one query.
   * @param request - query, owning session, and per-provider result cap.
   * @param signal - cancellation for the retrieval.
   * @returns recall results, or an empty list when nothing is relevant.
   */
  recall(request: MemoryRecallRequest, signal?: AbortSignal): Promise<readonly MemoryRecall[]>
}

/**
 * One memory backend. A provider contributes at most two facets: a curated
 * store for the targets it owns, and recall from wherever it retrieves.
 * Providers are registered on {@link MemoryService} and are the only swappable
 * part of the capability.
 */
export interface MemoryProvider {
  /** Unique provider name; a duplicate registration is rejected. */
  readonly name: string
  /**
   * Curated targets this provider owns. Omit or leave empty for a provider
   * that only recalls. Two providers owning one target is a misconfiguration
   * and fails at registration.
   */
  readonly targets?: readonly MemoryTarget[]
  /** Required when {@link targets} is non-empty. */
  readonly store?: MemoryStoreFacet
  /** Retrieval facet; omit for a provider that only stores. */
  readonly recall?: MemoryRecallFacet
}
