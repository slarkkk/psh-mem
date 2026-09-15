/**
 * Plugin configuration for the curated memory provider: the two per-target
 * character budgets, the per-turn consolidation cap, and the provider name.
 * Every field is optional here because the schema below supplies its default;
 * {@link resolveConfig} applies the same defaults to a directly constructed
 * configuration, so a test or an embedding behaves like a loaded entry.
 * @module @deepseek-ai/dsh-memory-curated/config
 */

import z from '@deepseek-ai/schemastery'
import type { MemoryTarget } from '@deepseek-ai/dsh-memory'

/** Character budget of the `memory` target when the deployment states none. */
const DEFAULT_MEMORY_LIMIT = 2200
/** Character budget of the `user` target when the deployment states none. */
const DEFAULT_USER_LIMIT = 1375
/** Failed consolidation attempts in one turn before a write failure turns terminal. */
const DEFAULT_CONSOLIDATION_FAILURE_LIMIT = 3
/** Provider name registered on `ctx.memory` when the deployment states none. */
const DEFAULT_PROVIDER_NAME = 'curated'
/**
 * Prompt-section position when the deployment states none: after the persona,
 * plan policy, and team policy; before tool guidance and every later block.
 */
const DEFAULT_SECTION_ORDER = 700

/** The two targets this provider owns, in the order their blocks render. */
export const MEMORY_TARGETS: readonly MemoryTarget[] = ['memory', 'user']

/** User-facing configuration of the curated memory provider. */
export interface Config {
  /** Character budget of the `memory` target, measured over its joined entries. Default 2200. */
  memoryLimit?: number
  /** Character budget of the `user` target, measured over its joined entries. Default 1375. */
  userLimit?: number
  /**
   * Failed `over-budget` and `no-match` writes in one turn before this target's
   * writes turn terminal for that turn. Default 3.
   */
  consolidationFailureLimit?: number
  /** Name this provider registers under on `ctx.memory`. Default `curated`. */
  providerName?: string
  /**
   * Prompt-section position. This plugin lives outside the harness checkout, so
   * it cannot claim a name from the repository's central allocation; state the
   * order it should occupy instead. Default 700, which places the curated blocks
   * after the persona and plan policy and before tool guidance.
   */
  sectionOrder?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  memoryLimit: z.natural().min(1).default(DEFAULT_MEMORY_LIMIT),
  userLimit: z.natural().min(1).default(DEFAULT_USER_LIMIT),
  consolidationFailureLimit: z.natural().min(1).default(DEFAULT_CONSOLIDATION_FAILURE_LIMIT),
  providerName: z.string().default(DEFAULT_PROVIDER_NAME),
  sectionOrder: z.number().default(DEFAULT_SECTION_ORDER),
})

/** Plugin configuration with every documented default applied. */
export interface ResolvedConfig {
  /** Character budget of each owned target. */
  readonly limits: Readonly<Record<MemoryTarget, number>>
  /** Failed consolidation attempts in one turn before writes turn terminal. */
  readonly consolidationFailureLimit: number
  /** Provider name to register on `ctx.memory`. */
  readonly providerName: string
  /** Prompt-section position the curated blocks occupy. */
  readonly sectionOrder: number
}

/**
 * Apply the documented defaults to a plugin configuration. A configuration
 * loaded through schemastery already carries every default; resolving here
 * keeps a directly constructed one equivalent.
 * @param config - user-facing plugin configuration.
 * @returns the configuration the store and the registration run on.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    limits: {
      memory: config.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
      user: config.userLimit ?? DEFAULT_USER_LIMIT,
    },
    consolidationFailureLimit: config.consolidationFailureLimit ?? DEFAULT_CONSOLIDATION_FAILURE_LIMIT,
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    sectionOrder: config.sectionOrder ?? DEFAULT_SECTION_ORDER,
  }
}
