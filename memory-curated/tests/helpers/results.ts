/**
 * Result-narrowing helpers shared by the curated memory specs. They fail the
 * calling test with the settled outcome spelled out, so a mistaken expectation
 * about success or failure reports the actual code and message.
 * @module
 */

import type { MemoryWriteResult } from '@deepseek-ai/dsh-memory'

/** Successful outcome of a memory write. */
export type MemoryWriteSuccess = Extract<MemoryWriteResult, { ok: true }>

/** Rejected outcome of a memory write. */
export type MemoryWriteFailure = Extract<MemoryWriteResult, { ok: false }>

/**
 * Require a settled write to have succeeded.
 * @param result - the settled outcome.
 * @returns the success arm.
 * @throws when the write was rejected, with the rejection's code and message.
 */
export function succeeded(result: MemoryWriteResult): MemoryWriteSuccess {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`)
  return result
}

/**
 * Require a settled write to have been rejected.
 * @param result - the settled outcome.
 * @returns the rejection arm.
 * @throws when the write succeeded.
 */
export function failed(result: MemoryWriteResult): MemoryWriteFailure {
  if (result.ok) throw new Error('expected failure, got a settled success')
  return result
}
