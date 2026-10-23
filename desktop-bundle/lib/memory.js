// ../dsh-mem/memory/src/index.ts
import { Service } from "@deepseek-ai/cordis";
var MemoryService = class extends Service {
  providerTable = /* @__PURE__ */ new Map();
  targetOwners = /* @__PURE__ */ new Map();
  /**
   * @param ctx - Context the capability attaches to.
   */
  constructor(ctx) {
    super(ctx, "memory");
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
  register(provider) {
    if (this.providerTable.has(provider.name)) {
      throw new Error(`memory provider "${provider.name}" is already registered`);
    }
    const targets = provider.targets ?? [];
    if (targets.length > 0 && provider.store === void 0) {
      throw new Error(`memory provider "${provider.name}" claims targets without a store facet`);
    }
    for (const target of targets) {
      const owner = this.targetOwners.get(target);
      if (owner !== void 0) {
        throw new Error(`memory target "${target}" is already owned by provider "${owner.provider.name}"`);
      }
    }
    this.providerTable.set(provider.name, provider);
    if (provider.store !== void 0) {
      for (const target of targets) this.targetOwners.set(target, { provider, store: provider.store });
    }
    return () => {
      this.providerTable.delete(provider.name);
      for (const target of targets) {
        const owner = this.targetOwners.get(target);
        if (owner?.provider === provider) this.targetOwners.delete(target);
      }
    };
  }
  /**
   * List the registered providers in registration order.
   * @returns every registered provider.
   */
  list() {
    return [...this.providerTable.values()];
  }
  /**
   * Look up one registered provider by name.
   * @param providerName - name given at registration.
   * @returns the provider, or `undefined` when none is registered under that name.
   */
  get(providerName) {
    return this.providerTable.get(providerName);
  }
  /**
   * Read a target's entries from the provider owning it.
   * @param target - curated target to read.
   * @throws when no registered provider owns the target.
   * @returns the target's current entries and usage.
   */
  async snapshot(target) {
    return this.requireOwner(target).store.snapshot(target);
  }
  /**
   * Apply entry mutations to a target through the provider owning it.
   * @param target - curated target to mutate.
   * @param operations - entry mutations, applied by the owner in order.
   * @returns the owner's settled outcome, or `unowned-target` when the
   * deployment registers no provider for the target.
   */
  async write(target, operations) {
    const owner = this.targetOwners.get(target);
    if (owner === void 0) {
      return {
        ok: false,
        code: "unowned-target",
        message: `No memory provider stores the "${target}" target in this deployment.`
      };
    }
    return owner.store.write(target, operations);
  }
  /**
   * Collect recall from every provider offering it. One failing backend never
   * denies another's recall: the failure is logged and contributes nothing.
   * @param request - query, owning session, and per-provider result cap.
   * @param signal - cancellation forwarded to every provider.
   * @returns the concatenated recall, ordered by provider registration order.
   */
  async recall(request, signal) {
    const retrievers = [...this.providerTable.values()].flatMap((provider) => provider.recall === void 0 ? [] : [{ name: provider.name, recall: provider.recall }]);
    const pages = await Promise.all(retrievers.map(async ({ name, recall }) => {
      try {
        return await recall.recall(request, signal);
      } catch (error) {
        this.ctx.logger.warn(`memory provider "${name}" recall failed: ${String(error)}`);
        return [];
      }
    }));
    return pages.flat();
  }
  /** Resolve the provider owning a target, or fail loud when none does. */
  requireOwner(target) {
    const owner = this.targetOwners.get(target);
    if (owner === void 0) {
      throw new Error(`no memory provider owns target "${target}"`);
    }
    return owner;
  }
};
var index_default = MemoryService;
export {
  MemoryService,
  index_default as default
};
