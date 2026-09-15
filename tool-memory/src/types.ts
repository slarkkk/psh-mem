/**
 * Vocabulary of the model-facing `memory` tool: the canonical value it returns
 * and the model-supplied operation objects it narrows before delegating. Types
 * only — the runtime write and failure vocabulary stays in
 * `@deepseek-ai/dsh-memory`, so a provider can settle a new failure class
 * without a tool release.
 * @module @deepseek-ai/dsh-tool-memory/types
 */

/** One curated target's entries and budget usage as the tool reports them. */
export interface MemoryToolSnapshot {
  /** Curated target this snapshot observes (`memory` or `user`). */
  readonly target: string
  /**
   * Stored entries in storage order. The array is mutable because the tool owns
   * this value as plain JSON; `execute` copies the capability's readonly entries
   * into a fresh array rather than passing the provider's own list through.
   */
  readonly entries: string[]
  /** Characters the joined entries occupy, measured against {@link MemoryToolSnapshot.limit}. */
  readonly chars: number
  /** Maximum characters the target may occupy. */
  readonly limit: number
}

/**
 * Canonical value of one `memory` call: the settled outcome of the whole
 * batch, never a per-operation one.
 *
 * The fields are optional in this declaration and in the tool's output schema
 * because a settled outcome carries only the fields its own branch produces —
 * a success reports `note` and `snapshot`, a rejection reports `code`, `message`,
 * and a `snapshot` whenever the owning provider could observe target state.
 * `execute` builds this value field by field from the provider's outcome, so a
 * key the settled branch does not carry is absent rather than `undefined`, and
 * a provider's private additions never reach the tool's schema. The canonical
 * value is deliberately not a discriminated union: providers are swappable, the
 * tool must carry whatever a provider settles, and a failure class a provider
 * adds later must not require a tool release.
 */
export interface MemoryToolValue {
  /** Whether the batch was applied. */
  readonly ok: boolean
  /** Stable failure class; present exactly on a rejection. */
  readonly code?: string
  /** Actionable failure explanation; present exactly on a rejection. */
  readonly message?: string
  /** Short success confirmation; present exactly on a success. */
  readonly note?: string
  /** Resulting entries and usage on success, current entries on a retryable rejection. */
  readonly snapshot?: MemoryToolSnapshot
}

/**
 * One model-supplied entry mutation, as the parameter schema declares it. The
 * schema cannot express that `content` is required for `add`/`replace` and
 * `oldText` for `replace`/`remove`, so both fields are optional here and the
 * tool narrows the object into a `MemoryOperation` before delegating.
 */
export interface RawMemoryOperation {
  /** Mutation to apply. */
  readonly action: 'add' | 'replace' | 'remove'
  /** Entry text for `add` and `replace`. */
  readonly content?: string
  /** Short unique substring of the existing entry, for `replace` and `remove`. */
  readonly oldText?: string
}
