/**
 * Model-facing description of the `memory` tool. It is the tool's only model
 * guidance: this plugin registers no system-prompt section, so what to save,
 * how to batch it, and what to leave out all live here.
 * @module @deepseek-ai/dsh-tool-memory/description
 */

/** What the store is and the bar an entry must clear to belong in it. */
const WHAT =
  'Durable facts that outlive this session: whatever you write here is injected into '
  + 'every future turn, so keep each entry compact and high-signal.'

/** Why one call must carry every change, and why the call is not repeated. */
const HOW =
  'Make ALL changes in ONE call — the `operations` array applies atomically, and the '
  + 'character budget is checked only on the FINAL result, so a single call can remove '
  + 'or shorten stale entries AND add new entries even when an add alone would overflow. '
  + 'The response confirms completion; do not repeat the call.'

/** When to reach for the tool without being asked, in priority order. */
const WHEN =
  'Save proactively when the user states a preference, a correction, or a personal '
  + 'detail, or when you learn a stable fact about their environment, conventions, or '
  + 'workflow. Prefer user preferences and corrections first, then environment facts, '
  + 'then procedures.'

/** What a rejected add hands back, and the one retry it asks for. */
const FULL =
  'If an add is rejected because the target is full, the current entries come back with '
  + 'the rejection: reissue ONE batch that frees room and adds together.'

/** Which curated block holds what. */
const TARGETS =
  'Targets: `user` is who the user is (name, role, preferences, style); `memory` is your '
  + 'own notes (environment, conventions, tool quirks, lessons).'

/** What does not belong in either target. */
const SKIP =
  'Skip trivial or easily re-discovered facts, raw data dumps, task progress, '
  + 'completed-work logs, and temporary TODO state.'

/** The complete model-facing description of the `memory` tool. */
export const MEMORY_DESCRIPTION: string = [WHAT, HOW, WHEN, FULL, TARGETS, SKIP].join(' ')
