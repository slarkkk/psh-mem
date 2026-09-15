/**
 * The curated entry store: the two bounded ordered lists this provider owns,
 * behind `MemoryStoreFacet`, persisted through the `memory` domain and read
 * synchronously from that domain's authoritative in-memory state.
 *
 * The store is the only writer of its records. A write request applies every
 * operation to a working copy, compares the copy against the target's character
 * budget exactly once, and persists only when the whole list applies and fits —
 * so one request can free room by removing or shortening stale entries and add
 * a new entry together, and a rejected request leaves the stored entries
 * untouched.
 * @module @deepseek-ai/dsh-memory-curated/store
 */

import type {
  MemoryFailureCode,
  MemoryOperation,
  MemorySnapshot,
  MemoryStoreFacet,
  MemoryTarget,
  MemoryWriteResult,
} from '@deepseek-ai/dsh-memory'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ResolvedConfig } from './config.ts'
import { measureEntries, renderUsage } from './render.ts'
import type { CuratedTargetRecord } from './spec.ts'
import type { EntryMatch, OperationFailure } from './types.ts'

/**
 * The two curated lists on the `memory` domain.
 *
 * Reads are synchronous and always see the state every landed write produced;
 * writes are all-or-nothing and account for their rejections against a per-turn
 * consolidation allowance, so a caller that cannot consolidate stops being
 * asked to try instead of holding a reply hostage.
 */
export class CuratedMemoryStore implements MemoryStoreFacet {
  /** Failed `over-budget` and `no-match` writes since the last turn boundary. */
  private failures = 0

  /**
   * @param table - the `targets` table of the open `memory` domain.
   * @param config - resolved provider configuration holding the budgets and the consolidation cap.
   */
  constructor(
    private readonly table: KvTable<MemoryTarget, CuratedTargetRecord>,
    private readonly config: ResolvedConfig,
  ) {}

  /**
   * Read one target's entries and usage. Synchronous against the domain's
   * in-memory state, so the prompt renderer needs no await and observes exactly
   * what the last landed write produced.
   * @param target - curated target to read.
   * @returns the target's current entries, usage, and budget.
   */
  read(target: MemoryTarget): MemorySnapshot {
    const record = this.table.get(target)
    const entries = record === undefined ? [] : [...record.entries]
    const limit = this.config.limits[target]
    return { target, entries, chars: measureEntries(entries), limit }
  }

  /**
   * Read one target's entries and usage through the capability's store facet.
   * @param target - curated target this provider owns.
   * @returns the target's current entries, usage, and budget.
   */
  snapshot(target: MemoryTarget): Promise<MemorySnapshot> {
    return Promise.resolve(this.read(target))
  }

  /**
   * Apply every operation to the target's entries, then compare the result
   * against the target's budget once. Nothing is persisted unless the whole
   * list applies and the final character count fits.
   * @param target - curated target this provider owns.
   * @param operations - entry mutations, applied in order to a working copy.
   * @returns the settled outcome; a failure carries the unchanged snapshot.
   */
  async write(target: MemoryTarget, operations: readonly MemoryOperation[]): Promise<MemoryWriteResult> {
    const current = this.read(target)
    const entries = [...current.entries]
    for (const operation of operations) {
      const failure = applyOperation(entries, operation, current)
      if (failure !== undefined) return this.reject(failure.code, current, failure.message)
    }
    const chars = measureEntries(entries)
    if (chars > current.limit) {
      return this.reject('over-budget', current, overBudgetMessage(target, current, chars))
    }
    await this.table.put(target, { entries })
    // A landed write is a successful consolidation, so the turn starts over.
    this.failures = 0
    const snapshot: MemorySnapshot = { target, entries, chars, limit: current.limit }
    return { ok: true, snapshot, note: successNote(snapshot) }
  }

  /**
   * Start a fresh consolidation allowance. The plugin calls this at every turn
   * boundary, so a turn that exhausted its cap never silences a later turn.
   */
  resetTurn(): void {
    this.failures = 0
  }

  /**
   * Build a settled failure and account for it against the turn's consolidation
   * allowance. `over-budget` and `no-match` are the two codes a caller answers
   * with another write, so they advance the allowance; once it is exhausted the
   * failure turns terminal and tells the caller to stop retrying memory.
   * @param code - stable failure class.
   * @param current - the unchanged snapshot the request started from.
   * @param message - actionable explanation of this rejection.
   * @returns the rejection result, terminal once the allowance is exhausted.
   */
  private reject(code: MemoryFailureCode, current: MemorySnapshot, message: string): MemoryWriteResult {
    if (code !== 'over-budget' && code !== 'no-match') {
      return { ok: false, code, message, snapshot: current }
    }
    this.failures += 1
    if (this.failures < this.config.consolidationFailureLimit) {
      return { ok: false, code, message, snapshot: current }
    }
    return { ok: false, code, message: terminalMessage(code, current, this.failures), snapshot: current }
  }
}

/**
 * Apply one operation to the working copy.
 * @param entries - working copy, mutated in place once the operation applies.
 * @param operation - the mutation to apply.
 * @param current - the snapshot the request started from, used in rejection messages.
 * @returns the rejection, or `undefined` once the operation applied.
 */
function applyOperation(
  entries: string[],
  operation: MemoryOperation,
  current: MemorySnapshot,
): OperationFailure | undefined {
  switch (operation.action) {
    case 'add':
      if (operation.content.length === 0) return emptyContentFailure(current.target)
      // A repeated add is already satisfied; treating it as a no-op keeps a
      // retried request idempotent instead of failing it.
      if (!entries.includes(operation.content)) entries.push(operation.content)
      return undefined
    case 'replace': {
      if (operation.content.length === 0) return emptyContentFailure(current.target)
      if (operation.oldText.length === 0) return emptyOldTextFailure(current.target)
      const match = findEntry(entries, operation.oldText)
      if (match.distinct === 0) return noMatchFailure(operation.oldText, current)
      if (match.distinct > 1) return ambiguousMatchFailure(operation.oldText, match.distinct, current)
      entries[match.index] = operation.content
      return undefined
    }
    case 'remove': {
      if (operation.oldText.length === 0) return emptyOldTextFailure(current.target)
      const match = findEntry(entries, operation.oldText)
      if (match.distinct === 0) return noMatchFailure(operation.oldText, current)
      if (match.distinct > 1) return ambiguousMatchFailure(operation.oldText, match.distinct, current)
      entries.splice(match.index, 1)
      return undefined
    }
    default:
      return assertNever(operation, 'memory operation')
  }
}

/**
 * Locate the entry one `oldText` addresses.
 * @param entries - entries to search, in storage order.
 * @param oldText - substring every candidate entry must contain.
 * @returns the distinct-match count and the first matching position.
 */
function findEntry(entries: readonly string[], oldText: string): EntryMatch {
  const distinct = new Set<string>()
  let index = -1
  for (const [position, entry] of entries.entries()) {
    if (!entry.includes(oldText)) continue
    if (index < 0) index = position
    distinct.add(entry)
  }
  return { distinct: distinct.size, index }
}

/**
 * Build the rejection raised when an operation carries no content.
 * @param target - target the operation addressed.
 * @returns the `empty-content` failure.
 */
function emptyContentFailure(target: MemoryTarget): OperationFailure {
  return { code: 'empty-content', message: `Memory content must not be empty; nothing was stored in "${target}".` }
}

/**
 * Build the rejection raised when an addressing text is empty.
 * @param target - target the operation addressed.
 * @returns the `empty-old-text` failure.
 */
function emptyOldTextFailure(target: MemoryTarget): OperationFailure {
  return { code: 'empty-old-text', message: `The text to match must not be empty; nothing was stored in "${target}".` }
}

/**
 * Build the rejection raised when no entry contains the addressing text.
 * @param oldText - the addressing text that matched nothing.
 * @param current - the unchanged snapshot.
 * @returns the `no-match` failure.
 */
function noMatchFailure(oldText: string, current: MemorySnapshot): OperationFailure {
  return {
    code: 'no-match',
    message: `No entry in "${current.target}" contains ${JSON.stringify(oldText)}; nothing was stored.`
      + `\nCurrent entries (${current.entries.length}):\n${renderEntryList(current.entries)}`
      + '\nAddress exactly one entry, or add a new entry, and retry in this same turn.',
  }
}

/**
 * Build the rejection raised when the addressing text spans several entries.
 * @param oldText - the addressing text.
 * @param distinct - number of distinct matching entry texts.
 * @param current - the unchanged snapshot.
 * @returns the `ambiguous-match` failure.
 */
function ambiguousMatchFailure(oldText: string, distinct: number, current: MemorySnapshot): OperationFailure {
  return {
    code: 'ambiguous-match',
    message: `${JSON.stringify(oldText)} matches ${distinct} distinct entries in "${current.target}"; nothing was stored.`
      + `\nCurrent entries (${current.entries.length}):\n${renderEntryList(current.entries)}`
      + '\nQuote more of the one entry you mean, or remove it by a longer substring.',
  }
}

/**
 * Build the over-budget rejection. It names both character counts, lists the
 * entries the caller still has to consolidate, and asks for the retry in the
 * same turn so the request that overflowed can also free the room.
 * @param target - target the request addressed.
 * @param current - the unchanged snapshot.
 * @param chars - character count the request would have produced.
 * @returns the `over-budget` failure.
 */
function overBudgetMessage(target: MemoryTarget, current: MemorySnapshot, chars: number): string {
  return `Memory "${target}" would hold ${chars}/${current.limit} characters, `
    + `${chars - current.limit} over its budget; nothing was stored.`
    + `\nCurrent entries (${current.entries.length}):\n${renderEntryList(current.entries)}`
    + '\nConsolidate: replace or remove stale entries, then retry in this same turn.'
}

/**
 * Build the terminal rejection that ends a turn's consolidation attempts.
 * @param code - the failure class that exhausted the allowance.
 * @param current - the unchanged snapshot.
 * @param attempts - failed consolidation attempts in this turn.
 * @returns the terminal failure message.
 */
function terminalMessage(code: MemoryFailureCode, current: MemorySnapshot, attempts: number): string {
  const cause = code === 'over-budget'
    ? `"${current.target}" is over its ${current.limit}-character budget`
    : `no entry in "${current.target}" matches the text you addressed`
  return `Consolidation failed ${attempts} times in this turn and ${cause}. `
    + 'Stop calling the memory tool now, leave memory unchanged, and continue replying to the user; '
    + 'memory can be consolidated in a later turn.'
}

/**
 * Build the settled success note. It reports the resulting size and usage and
 * states that the update is complete, because the prompt snapshot is frozen and
 * cannot confirm the write within this session.
 * @param snapshot - the persisted snapshot.
 * @returns the note the model-facing consumer shows the caller.
 */
function successNote(snapshot: MemorySnapshot): string {
  const count = snapshot.entries.length
  return `Memory "${snapshot.target}" holds ${count} ${count === 1 ? 'entry' : 'entries'} `
    + `(${renderUsage(snapshot)}). This update is complete and must not be repeated.`
}

/**
 * Render entries as a numbered list for a rejection message.
 * @param entries - entries to list.
 * @returns one numbered line per entry.
 */
function renderEntryList(entries: readonly string[]): string {
  return entries.map((entry, position) => `${position + 1}. ${entry}`).join('\n')
}
