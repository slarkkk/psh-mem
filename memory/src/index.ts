/**
 * Memory Service Definition (`ctx.memory`): the registry that composes memory
 * providers and routes curated reads and writes to the provider owning each
 * target. Providers own every storage decision; this service owns registration,
 * target ownership, lookup, and failure isolation between providers.
 * @module @deepseek-ai/dsh-memory
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  MemoryOperation,
  MemoryProvider,
  MemoryRecall,
  MemoryRecallRequest,
  MemorySnapshot,
  MemoryStoreFacet,
  MemoryTarget,
  MemoryWriteResult,
} from './types.ts'

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
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/** One target's owning provider together with the store facet that owns it. */
interface TargetOwner {
  readonly provider: MemoryProvider
  readonly store: MemoryStoreFacet
}

/**
 * The composed memory capability. Load one instance per context as
 * `ctx.memory`; providers register into it, and consumers reach every backend
 * through it rather than through a provider directly.
 *
 * Registration rules fail loud because they are deployment misconfigurations,
 * not model-visible outcomes: a duplicate provider name, a provider owning a
 * target without a store facet, and two providers owning one target all throw
 * at the registration that creates the conflict.
 */
export class MemoryService extends Service {
  private readonly providerTable = new Map<string, MemoryProvider>()
  private readonly targetOwners = new Map<MemoryTarget, TargetOwner>()

  /**
   * @param ctx - Context the capability attaches to.
   */
  constructor(ctx: Context) {
    super(ctx, 'memory')
  }

  /**
   * Register one provider and the curated targets it owns. The calling plugin
   * wraps this in `ctx.effect` so unloading the contributing fiber removes the
   * provider and frees its targets.
   * @param provider - the backend to register.
   * @throws when the name is taken, a target already has an owner, or the
   * provider claims targets without a store facet.
   * @returns the exact disposer that removes the provider and its ownership.
   */
  register(provider: MemoryProvider): () => void {
    if (this.providerTable.has(provider.name)) {
      throw new Error(`memory provider "${provider.name}" is already registered`)
    }
    const targets = provider.targets ?? []
    if (targets.length > 0 && provider.store === undefined) {
      throw new Error(`memory provider "${provider.name}" claims targets without a store facet`)
    }
    for (const target of targets) {
      const owner = this.targetOwners.get(target)
      if (owner !== undefined) {
        throw new Error(`memory target "${target}" is already owned by provider "${owner.provider.name}"`)
      }
    }
    this.providerTable.set(provider.name, provider)
    if (provider.store !== undefined) {
      for (const target of targets) this.targetOwners.set(target, { provider, store: provider.store })
    }
    return () => {
      this.providerTable.delete(provider.name)
      for (const target of targets) {
        const owner = this.targetOwners.get(target)
        if (owner?.provider === provider) this.targetOwners.delete(target)
      }
    }
  }

  /**
   * List the registered providers in registration order.
   * @returns every registered provider.
   */
  list(): readonly MemoryProvider[] {
    return [...this.providerTable.values()]
  }

  /**
   * Look up one registered provider by name.
   * @param providerName - name given at registration.
   * @returns the provider, or `undefined` when none is registered under that name.
   */
  get(providerName: string): MemoryProvider | undefined {
    return this.providerTable.get(providerName)
  }

  /**
   * Read a target's entries from the provider owning it.
   * @param target - curated target to read.
   * @throws when no registered provider owns the target.
   * @returns the target's current entries and usage.
   */
  async snapshot(target: MemoryTarget): Promise<MemorySnapshot> {
    return this.requireOwner(target).store.snapshot(target)
  }

  /**
   * Apply entry mutations to a target through the provider owning it.
   * @param target - curated target to mutate.
   * @param operations - entry mutations, applied by the owner in order.
   * @returns the owner's settled outcome, or `unowned-target` when the
   * deployment registers no provider for the target.
   */
  async write(target: MemoryTarget, operations: readonly MemoryOperation[]): Promise<MemoryWriteResult> {
    const owner = this.targetOwners.get(target)
    if (owner === undefined) {
      return {
        ok: false,
        code: 'unowned-target',
        message: `No memory provider stores the "${target}" target in this deployment.`,
      }
    }
    return owner.store.write(target, operations)
  }

  /**
   * Collect recall from every provider offering it. One failing backend never
   * denies another's recall: the failure is logged and contributes nothing.
   * @param request - query, owning session, and per-provider result cap.
   * @param signal - cancellation forwarded to every provider.
   * @returns the concatenated recall, ordered by provider registration order.
   */
  async recall(request: MemoryRecallRequest, signal?: AbortSignal): Promise<readonly MemoryRecall[]> {
    const retrievers = [...this.providerTable.values()].flatMap(provider =>
      provider.recall === undefined ? [] : [{ name: provider.name, recall: provider.recall }])
    const pages = await Promise.all(retrievers.map(async ({ name, recall }) => {
      try {
        return await recall.recall(request, signal)
      } catch (error) {
        this.ctx.logger.warn(`memory provider "${name}" recall failed: ${String(error)}`)
        return []
      }
    }))
    return pages.flat()
  }

  /** Resolve the provider owning a target, or fail loud when none does. */
  private requireOwner(target: MemoryTarget): TargetOwner {
    const owner = this.targetOwners.get(target)
    if (owner === undefined) {
      throw new Error(`no memory provider owns target "${target}"`)
    }
    return owner
  }
}

export default MemoryService
