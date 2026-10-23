// ../dsh-mem/tool-memory/src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// ../dsh-mem/tool-memory/src/description.ts
var WHAT = "Durable facts that outlive this session: whatever you write here is injected into every future turn, so keep each entry compact and high-signal.";
var HOW = "Make ALL changes in ONE call \u2014 the `operations` array applies atomically, and the character budget is checked only on the FINAL result, so a single call can remove or shorten stale entries AND add new entries even when an add alone would overflow. The response confirms completion; do not repeat the call.";
var WHEN = "Save proactively when the user states a preference, a correction, or a personal detail, or when you learn a stable fact about their environment, conventions, or workflow. Prefer user preferences and corrections first, then environment facts, then procedures.";
var FULL = "If an add is rejected because the target is full, the current entries come back with the rejection: reissue ONE batch that frees room and adds together.";
var TARGETS = "Targets: `user` is who the user is (name, role, preferences, style); `memory` is your own notes (environment, conventions, tool quirks, lessons).";
var SKIP = "Skip trivial or easily re-discovered facts, raw data dumps, task progress, completed-work logs, and temporary TODO state.";
var MEMORY_DESCRIPTION = [WHAT, HOW, WHEN, FULL, TARGETS, SKIP].join(" ");

// ../dsh-mem/tool-memory/src/schema.ts
var MEMORY_PARAMETERS = {
  target: {
    type: "string",
    required: true,
    enum: ["memory", "user"],
    description: "Which block this batch addresses: `user` for durable facts about the user; `memory` for your own notes."
  },
  operations: {
    type: "array",
    required: true,
    description: "Every change for this target, applied in order as one atomic batch against the budget of the final result.",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          required: true,
          enum: ["add", "replace", "remove"],
          description: "add (new entry) | replace (rewrite the entry matching oldText) | remove (drop the entry matching oldText)."
        },
        content: {
          type: "string",
          description: "The entry text, for add and replace. Keep it compact: it is injected into every future turn."
        },
        oldText: {
          type: "string",
          description: "A short unique substring of the existing entry, identifying it for replace and remove."
        }
      }
    }
  }
};
var MEMORY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true, description: "Whether the whole batch was applied." },
    code: { type: "string", description: "Stable failure class, present exactly on a rejection." },
    message: { type: "string", description: "Actionable failure explanation, present exactly on a rejection." },
    note: { type: "string", description: "Short success confirmation, present exactly on a success." },
    snapshot: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: { type: "string", required: true, description: "Target this snapshot observes." },
        entries: {
          type: "array",
          required: true,
          items: { type: "string" },
          description: "Stored entries in storage order."
        },
        chars: { type: "integer", required: true, description: "Characters the joined entries occupy." },
        limit: { type: "integer", required: true, description: "Maximum characters the target may occupy." }
      }
    }
  }
};

// ../dsh-mem/tool-memory/src/index.ts
var name = "tool-memory";
var inject = ["tools", "memory"];
function toOperations(operations) {
  return operations.map((operation) => {
    if (operation.action === "add") {
      return { action: "add", content: operation.content ?? "" };
    }
    if (operation.action === "replace") {
      return { action: "replace", oldText: operation.oldText ?? "", content: operation.content ?? "" };
    }
    return { action: "remove", oldText: operation.oldText ?? "" };
  });
}
function toSnapshot(snapshot) {
  return {
    target: snapshot.target,
    entries: [...snapshot.entries],
    chars: snapshot.chars,
    limit: snapshot.limit
  };
}
function toCanonicalValue(result) {
  if (result.ok) {
    return { ok: true, note: result.note, snapshot: toSnapshot(result.snapshot) };
  }
  if (result.snapshot === void 0) {
    return { ok: false, code: result.code, message: result.message };
  }
  return { ok: false, code: result.code, message: result.message, snapshot: toSnapshot(result.snapshot) };
}
function renderMemory(value) {
  if (value.ok) {
    const usage = value.snapshot === void 0 ? "" : ` (${value.snapshot.chars}/${value.snapshot.limit} chars used)`;
    return [{ type: "text", text: `${value.note ?? "Memory updated."}${usage}` }];
  }
  const lines = [value.message ?? "Memory write rejected."];
  if (value.snapshot !== void 0) {
    lines.push(`Current ${value.snapshot.target} entries (${value.snapshot.chars}/${value.snapshot.limit} chars):`);
    for (const entry of value.snapshot.entries) lines.push(`- ${entry}`);
  }
  return [{ type: "text", text: lines.join("\n") }];
}
function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "memory",
    description: MEMORY_DESCRIPTION,
    parameters: MEMORY_PARAMETERS,
    output: {
      schema: MEMORY_OUTPUT_SCHEMA,
      render: (_args, value) => renderMemory(value)
    },
    async execute(args) {
      return toCanonicalValue(await ctx.memory.write(args.target, toOperations(args.operations)));
    }
  }));
}
export {
  apply,
  inject,
  name
};
