/**
 * JSON schema declarations of the `memory` tool's parameters and canonical
 * output, kept apart from the plugin body so the exact model-facing surface can
 * be read in one place.
 * @module @deepseek-ai/dsh-tool-memory/schema
 */

import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/**
 * Parameter schema of the `memory` tool. The implicit root is open, so the
 * schema names only the two fields the tool reads; `target` and `operations`
 * are required, and every operation field is optional because which fields a
 * mutation needs depends on its action.
 */
export const MEMORY_PARAMETERS = {
  target: {
    type: 'string',
    required: true,
    enum: ['memory', 'user'],
    description: 'Which block this batch addresses: `user` for durable facts about the user; `memory` for your own notes.',
  },
  operations: {
    type: 'array',
    required: true,
    description: 'Every change for this target, applied in order as one atomic batch against the budget of the final result.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          required: true,
          enum: ['add', 'replace', 'remove'],
          description: 'add (new entry) | replace (rewrite the entry matching oldText) | remove (drop the entry matching oldText).',
        },
        content: {
          type: 'string',
          description: 'The entry text, for add and replace. Keep it compact: it is injected into every future turn.',
        },
        oldText: {
          type: 'string',
          description: 'A short unique substring of the existing entry, identifying it for replace and remove.',
        },
      },
    },
  },
} as const satisfies ParameterSchemaSpec

/**
 * Canonical output schema of the `memory` tool: one object whose `ok` field
 * settles the batch and whose remaining fields are optional because each
 * outcome carries only its own. `code` and `message` accompany a rejection,
 * `note` accompanies a success, and `snapshot` accompanies a success or a
 * retryable rejection. Their inner fields are required together, because a
 * snapshot is only ever whole.
 */
export const MEMORY_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: 'Whether the whole batch was applied.' },
    code: { type: 'string', description: 'Stable failure class, present exactly on a rejection.' },
    message: { type: 'string', description: 'Actionable failure explanation, present exactly on a rejection.' },
    note: { type: 'string', description: 'Short success confirmation, present exactly on a success.' },
    snapshot: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', required: true, description: 'Target this snapshot observes.' },
        entries: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'Stored entries in storage order.',
        },
        chars: { type: 'integer', required: true, description: 'Characters the joined entries occupy.' },
        limit: { type: 'integer', required: true, description: 'Maximum characters the target may occupy.' },
      },
    },
  },
} as const satisfies ValueSchemaSpec
