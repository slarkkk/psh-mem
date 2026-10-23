// ../dsh-mem/memory-curated/src/config.ts
import z from "@deepseek-ai/schemastery";
var DEFAULT_MEMORY_LIMIT = 2200;
var DEFAULT_USER_LIMIT = 1375;
var DEFAULT_CONSOLIDATION_FAILURE_LIMIT = 3;
var DEFAULT_PROVIDER_NAME = "curated";
var DEFAULT_SECTION_ORDER = 700;
var MEMORY_TARGETS = ["memory", "user"];
var Config = z.object({
  memoryLimit: z.natural().min(1).default(DEFAULT_MEMORY_LIMIT),
  userLimit: z.natural().min(1).default(DEFAULT_USER_LIMIT),
  consolidationFailureLimit: z.natural().min(1).default(DEFAULT_CONSOLIDATION_FAILURE_LIMIT),
  providerName: z.string().default(DEFAULT_PROVIDER_NAME),
  sectionOrder: z.number().default(DEFAULT_SECTION_ORDER)
});
function resolveConfig(config) {
  return {
    limits: {
      memory: config.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
      user: config.userLimit ?? DEFAULT_USER_LIMIT
    },
    consolidationFailureLimit: config.consolidationFailureLimit ?? DEFAULT_CONSOLIDATION_FAILURE_LIMIT,
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    sectionOrder: config.sectionOrder ?? DEFAULT_SECTION_ORDER
  };
}

// ../dsh-mem/memory-curated/src/render.ts
var ENTRY_DELIMITER = "\n\xA7\n";
var SECTION_PREAMBLE = "Curated memory: durable entries that outlive this session. This snapshot is frozen for the current session, so an entry written now appears here only in a later session.";
function measureEntries(entries) {
  return entries.join(ENTRY_DELIMITER).length;
}
function renderUsage(snapshot) {
  const percent = Math.round(snapshot.chars / snapshot.limit * 100);
  return `${percent}% \u2014 ${snapshot.chars}/${snapshot.limit} chars`;
}
function renderBlock(target, snapshot) {
  if (snapshot.entries.length === 0) return "";
  return `## ${target} (${renderUsage(snapshot)})
${snapshot.entries.join(ENTRY_DELIMITER)}`;
}
function renderCuratedSection(read) {
  const blocks = MEMORY_TARGETS.map((target) => renderBlock(target, read(target))).filter((block) => block.length > 0);
  if (blocks.length === 0) return "";
  return `${SECTION_PREAMBLE}

${blocks.join("\n\n")}`;
}
function createSectionText(read) {
  const frozen = /* @__PURE__ */ new WeakMap();
  let frozenUnscoped;
  return (context) => {
    const scope = context.scope;
    if (scope === void 0) {
      const cached2 = frozenUnscoped;
      if (cached2 !== void 0) return cached2;
      const unscoped = renderCuratedSection(read);
      frozenUnscoped = unscoped;
      return unscoped;
    }
    const cached = frozen.get(scope);
    if (cached !== void 0) return cached;
    const text = renderCuratedSection(read);
    frozen.set(scope, text);
    return text;
  };
}

// ../dsh-mem/memory-curated/src/spec.ts
import { z as z2 } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
var curatedTargetRecord = z2.object({ entries: z2.array(z2.string()) });
var memoryDomainSpec = defineDomain({
  name: "memory",
  version: 1,
  tables: { targets: domainTable(curatedTargetRecord) }
});

// ../dsh-mem/memory-curated/src/store.ts
import { assertNever } from "@deepseek-ai/dsh-util-values";
var CuratedMemoryStore = class {
  /**
   * @param table - the `targets` table of the open `memory` domain.
   * @param config - resolved provider configuration holding the budgets and the consolidation cap.
   */
  constructor(table, config) {
    this.table = table;
    this.config = config;
  }
  table;
  config;
  /** Failed `over-budget` and `no-match` writes since the last turn boundary. */
  failures = 0;
  /**
   * Read one target's entries and usage. Synchronous against the domain's
   * in-memory state, so the prompt renderer needs no await and observes exactly
   * what the last landed write produced.
   * @param target - curated target to read.
   * @returns the target's current entries, usage, and budget.
   */
  read(target) {
    const record = this.table.get(target);
    const entries = record === void 0 ? [] : [...record.entries];
    const limit = this.config.limits[target];
    return { target, entries, chars: measureEntries(entries), limit };
  }
  /**
   * Read one target's entries and usage through the capability's store facet.
   * @param target - curated target this provider owns.
   * @returns the target's current entries, usage, and budget.
   */
  snapshot(target) {
    return Promise.resolve(this.read(target));
  }
  /**
   * Apply every operation to the target's entries, then compare the result
   * against the target's budget once. Nothing is persisted unless the whole
   * list applies and the final character count fits.
   * @param target - curated target this provider owns.
   * @param operations - entry mutations, applied in order to a working copy.
   * @returns the settled outcome; a failure carries the unchanged snapshot.
   */
  async write(target, operations) {
    const current = this.read(target);
    const entries = [...current.entries];
    for (const operation of operations) {
      const failure = applyOperation(entries, operation, current);
      if (failure !== void 0) return this.reject(failure.code, current, failure.message);
    }
    const chars = measureEntries(entries);
    if (chars > current.limit) {
      return this.reject("over-budget", current, overBudgetMessage(target, current, chars));
    }
    await this.table.put(target, { entries });
    this.failures = 0;
    const snapshot = { target, entries, chars, limit: current.limit };
    return { ok: true, snapshot, note: successNote(snapshot) };
  }
  /**
   * Start a fresh consolidation allowance. The plugin calls this at every turn
   * boundary, so a turn that exhausted its cap never silences a later turn.
   */
  resetTurn() {
    this.failures = 0;
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
  reject(code, current, message) {
    if (code !== "over-budget" && code !== "no-match") {
      return { ok: false, code, message, snapshot: current };
    }
    this.failures += 1;
    if (this.failures < this.config.consolidationFailureLimit) {
      return { ok: false, code, message, snapshot: current };
    }
    return { ok: false, code, message: terminalMessage(code, current, this.failures), snapshot: current };
  }
};
function applyOperation(entries, operation, current) {
  switch (operation.action) {
    case "add":
      if (operation.content.length === 0) return emptyContentFailure(current.target);
      if (!entries.includes(operation.content)) entries.push(operation.content);
      return void 0;
    case "replace": {
      if (operation.content.length === 0) return emptyContentFailure(current.target);
      if (operation.oldText.length === 0) return emptyOldTextFailure(current.target);
      const match = findEntry(entries, operation.oldText);
      if (match.distinct === 0) return noMatchFailure(operation.oldText, current);
      if (match.distinct > 1) return ambiguousMatchFailure(operation.oldText, match.distinct, current);
      entries[match.index] = operation.content;
      return void 0;
    }
    case "remove": {
      if (operation.oldText.length === 0) return emptyOldTextFailure(current.target);
      const match = findEntry(entries, operation.oldText);
      if (match.distinct === 0) return noMatchFailure(operation.oldText, current);
      if (match.distinct > 1) return ambiguousMatchFailure(operation.oldText, match.distinct, current);
      entries.splice(match.index, 1);
      return void 0;
    }
    default:
      return assertNever(operation, "memory operation");
  }
}
function findEntry(entries, oldText) {
  const distinct = /* @__PURE__ */ new Set();
  let index = -1;
  for (const [position, entry] of entries.entries()) {
    if (!entry.includes(oldText)) continue;
    if (index < 0) index = position;
    distinct.add(entry);
  }
  return { distinct: distinct.size, index };
}
function emptyContentFailure(target) {
  return { code: "empty-content", message: `Memory content must not be empty; nothing was stored in "${target}".` };
}
function emptyOldTextFailure(target) {
  return { code: "empty-old-text", message: `The text to match must not be empty; nothing was stored in "${target}".` };
}
function noMatchFailure(oldText, current) {
  return {
    code: "no-match",
    message: `No entry in "${current.target}" contains ${JSON.stringify(oldText)}; nothing was stored.
Current entries (${current.entries.length}):
${renderEntryList(current.entries)}
Address exactly one entry, or add a new entry, and retry in this same turn.`
  };
}
function ambiguousMatchFailure(oldText, distinct, current) {
  return {
    code: "ambiguous-match",
    message: `${JSON.stringify(oldText)} matches ${distinct} distinct entries in "${current.target}"; nothing was stored.
Current entries (${current.entries.length}):
${renderEntryList(current.entries)}
Quote more of the one entry you mean, or remove it by a longer substring.`
  };
}
function overBudgetMessage(target, current, chars) {
  return `Memory "${target}" would hold ${chars}/${current.limit} characters, ${chars - current.limit} over its budget; nothing was stored.
Current entries (${current.entries.length}):
${renderEntryList(current.entries)}
Consolidate: replace or remove stale entries, then retry in this same turn.`;
}
function terminalMessage(code, current, attempts) {
  const cause = code === "over-budget" ? `"${current.target}" is over its ${current.limit}-character budget` : `no entry in "${current.target}" matches the text you addressed`;
  return `Consolidation failed ${attempts} times in this turn and ${cause}. Stop calling the memory tool now, leave memory unchanged, and continue replying to the user; memory can be consolidated in a later turn.`;
}
function successNote(snapshot) {
  const count = snapshot.entries.length;
  return `Memory "${snapshot.target}" holds ${count} ${count === 1 ? "entry" : "entries"} (${renderUsage(snapshot)}). This update is complete and must not be repeated.`;
}
function renderEntryList(entries) {
  return entries.map((entry, position) => `${position + 1}. ${entry}`).join("\n");
}

// ../dsh-mem/memory-curated/src/index.ts
var name = "memory-curated";
var inject = ["storageDomain", "systemPrompt", "memory"];
var SECTION_NAME = "memory:curated";
async function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const domain = await ctx.storageDomain.open(memoryDomainSpec);
  ctx.effect(() => () => domain.close(), "memory-curated.domainClose");
  const store = new CuratedMemoryStore(domain.table("targets"), resolved);
  ctx.effect(() => ctx.memory.register({
    name: resolved.providerName,
    targets: MEMORY_TARGETS,
    store
  }), "memory-curated.provider");
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: resolved.sectionOrder,
    text: createSectionText((target) => store.read(target))
  }), "memory-curated.section");
  ctx.on("session/event", (_session, event) => {
    if (event.type === "turn/end") store.resetTurn();
  });
}
export {
  Config,
  CuratedMemoryStore,
  ENTRY_DELIMITER,
  MEMORY_TARGETS,
  SECTION_NAME,
  apply,
  createSectionText,
  curatedTargetRecord,
  inject,
  measureEntries,
  memoryDomainSpec,
  name,
  renderCuratedSection,
  renderUsage,
  resolveConfig
};
