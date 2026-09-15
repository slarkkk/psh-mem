/**
 * Recall limits a deployment can change from `cordis.yml`.
 *
 * @module @deepseek-ai/dsh-memory-recall/config
 */

import z from '@deepseek-ai/schemastery'

/** Default maximum number of recalled items injected in one step. */
export const DEFAULT_MAX_RECALLS = 3

/** Default minimum length, in characters, of the direct user text that triggers retrieval. */
export const DEFAULT_MIN_QUERY_CHARS = 16

/** Default maximum UTF-8 bytes of one injected block, framing included. */
export const DEFAULT_MAX_RECALL_BYTES = 4_096

/**
 * Recall configuration. Every field is optional, and {@link resolveConfig}
 * supplies the documented default for each omitted field, so a deployment only
 * states the limits it wants to change.
 */
export interface Config {
  /** Maximum recalled items injected in one step; defaults to {@link DEFAULT_MAX_RECALLS}. */
  maxRecalls?: number
  /**
   * Minimum length, in characters, of the trimmed direct user text that
   * triggers retrieval. Shorter turns inject nothing, so greetings and
   * confirmations never pay for a corpus search. Defaults to
   * {@link DEFAULT_MIN_QUERY_CHARS}.
   */
  minQueryChars?: number
  /**
   * Maximum UTF-8 bytes of one injected block, framing included. Items are
   * retained in rank order while they fit. Defaults to
   * {@link DEFAULT_MAX_RECALL_BYTES}.
   */
  maxRecallBytes?: number
}

/** Schemastery validation for {@link Config}; invalid values fail plugin load. */
export const Config: z<Config> = z.object({
  maxRecalls: z.number().step(1).min(1).default(DEFAULT_MAX_RECALLS),
  minQueryChars: z.number().step(1).min(1).default(DEFAULT_MIN_QUERY_CHARS),
  maxRecallBytes: z.number().step(1).min(1).default(DEFAULT_MAX_RECALL_BYTES),
})

/** {@link Config} with every field resolved to the value retrieval uses. */
export interface ResolvedConfig {
  /** Maximum recalled items injected in one step. */
  readonly maxRecalls: number
  /** Minimum direct-user-text length, in characters, that triggers retrieval. */
  readonly minQueryChars: number
  /** Maximum UTF-8 bytes of one injected block, framing included. */
  readonly maxRecallBytes: number
}

/**
 * Resolve the configured recall limits, rejecting a limit that cannot bound anything.
 * @param config - configured limits; an omitted field takes its documented default.
 * @throws when a resolved limit is not a positive safe integer.
 * @returns the resolved limits in the order retrieval reads them.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const resolved: ResolvedConfig = {
    maxRecalls: config.maxRecalls ?? DEFAULT_MAX_RECALLS,
    minQueryChars: config.minQueryChars ?? DEFAULT_MIN_QUERY_CHARS,
    maxRecallBytes: config.maxRecallBytes ?? DEFAULT_MAX_RECALL_BYTES,
  }
  for (const [field, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`memory-recall: ${field} must be a positive safe integer, got ${String(value)}`)
    }
  }
  return resolved
}
