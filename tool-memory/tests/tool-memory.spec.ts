import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type MemoryService from '@deepseek-ai/dsh-memory'
import type { MemoryOperation, MemoryTarget, MemoryWriteResult } from '@deepseek-ai/dsh-memory'
import * as tool from '../src/index.ts'

/**
 * Drives the real plugin body against a real `ToolRuntime`, with `ctx.memory`
 * replaced by a double that records every delegated batch and answers with one
 * scripted outcome. The tool body, the schema it registers, and the rendering
 * the registry applies are the shipping code; only the memory service is a
 * stand-in.
 */

const testToolSignal = new AbortController().signal

/** One scripted answer from the memory double. */
type WriteScript = (target: MemoryTarget, operations: readonly MemoryOperation[]) => Promise<MemoryWriteResult>

/** A success outcome for a target, with the usage the store would report. */
function applied(target: MemoryTarget, entries: string[], chars: number, limit: number, note = 'Memory updated.'): MemoryWriteResult {
  return { ok: true, snapshot: { target, entries, chars, limit }, note }
}

/**
 * Mount prompt assembly, the tool registry, and the tool itself on a fresh
 * context whose `ctx.memory` is a recording double.
 * @param script - the outcome the double settles for each write.
 * @returns the context, the contributing fiber, the double, and its recorded batches.
 */
async function setup(script: WriteScript) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const delegated: { target: MemoryTarget; operations: readonly MemoryOperation[] }[] = []
  const write = vi.fn((target: MemoryTarget, operations: readonly MemoryOperation[]): Promise<MemoryWriteResult> => {
    delegated.push({ target, operations })
    return script(target, operations)
  })
  // MemoryService owns private registry state, so a delegation double is asserted here.
  ctx.provide('memory', { write, snapshot: vi.fn() } as unknown as MemoryService)
  const fiber = await ctx.plugin(tool)
  return { ctx, fiber, write, delegated }
}

let callCounter = 0

/**
 * Invoke the registered `memory` tool through the real registry.
 * @param ctx - context carrying the registered tool.
 * @param args - raw model arguments.
 * @returns the normalized execution result.
 */
function callMemory(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`memory-${++callCounter}`),
    name: 'memory',
    arguments: args,
  })
}

/**
 * Join the text blocks of one result.
 * @param result - a normalized execution result.
 * @returns the model-facing text.
 */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Register the tool and read back its model-facing schema.
 * @param script - the outcome the memory double settles.
 * @returns the registered schema as the model receives it.
 */
async function registeredSchema(script: WriteScript) {
  const { ctx } = await setup(script)
  const schema = ctx.tools.schemas().find(candidate => candidate.name === 'memory')
  if (schema === undefined) throw new Error('the memory tool was not registered')
  return schema
}

describe('dsh-tool-memory', () => {
  it('registers exactly one `memory` tool carrying the whole batch', async () => {
    const { ctx } = await setup(target => Promise.resolve(applied(target, [], 0, 100)))
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['memory'])
  })

  it('declares a required target enum and a required batch of operations', async () => {
    const schema = await registeredSchema(target => Promise.resolve(applied(target, [], 0, 100)))
    const parameters = schema.parameters as {
      required?: string[]
      properties: Record<string, {
        type: string
        enum?: string[]
        items?: { additionalProperties?: boolean; properties?: Record<string, { type: string; enum?: string[] }> }
      }>
    }
    expect(parameters.required).toEqual(['target', 'operations'])
    expect(Object.keys(parameters.properties)).toEqual(['target', 'operations'])
    expect(parameters.properties.target?.type).toBe('string')
    expect(parameters.properties.target?.enum).toEqual(['memory', 'user'])

    const operations = parameters.properties.operations
    expect(operations?.type).toBe('array')
    expect(operations?.items?.additionalProperties).toBe(false)
    expect(Object.keys(operations?.items?.properties ?? {}).sort()).toEqual(['action', 'content', 'oldText'])
    expect(operations?.items?.properties?.action?.enum).toEqual(['add', 'replace', 'remove'])
  })

  it('declares only `ok` as required in the canonical output schema', async () => {
    const { ctx } = await setup(target => Promise.resolve(applied(target, [], 0, 100)))
    expect(ctx.tools.get('memory')?.output.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: {
        ok: { type: 'boolean' },
        snapshot: {
          type: 'object',
          additionalProperties: false,
          required: ['target', 'entries', 'chars', 'limit'],
        },
      },
    })
  })

  it('describes durable facts, the atomic batch, both targets, and what to skip', async () => {
    const schema = await registeredSchema(target => Promise.resolve(applied(target, [], 0, 100)))
    const description = schema.description
    expect(description).toContain('Durable facts that outlive this session')
    expect(description).toContain('injected into every future turn')
    expect(description).toContain('Make ALL changes in ONE call')
    expect(description).toContain('character budget is checked only on the FINAL result')
    expect(description).toContain('do not repeat the call')
    expect(description).toContain('Save proactively when the user states a preference')
    expect(description).toContain('current entries come back with the rejection: reissue ONE batch')
    expect(description).toContain('`user` is who the user is')
    expect(description).toContain('`memory` is your own notes')
    expect(description).toContain('Skip trivial or easily re-discovered facts')
    expect(description).toContain('temporary TODO state')
  })

  it.each([
    { label: 'add', input: { action: 'add', content: 'prefers pnpm' }, expected: { action: 'add', content: 'prefers pnpm' } },
    {
      label: 'replace',
      input: { action: 'replace', oldText: 'pnpm', content: 'prefers pnpm 10' },
      expected: { action: 'replace', oldText: 'pnpm', content: 'prefers pnpm 10' },
    },
    { label: 'remove', input: { action: 'remove', oldText: 'stale' }, expected: { action: 'remove', oldText: 'stale' } },
  ])('delegates a $label batch to ctx.memory.write', async ({ input, expected }) => {
    const { ctx, write, delegated } = await setup(target => Promise.resolve(applied(target, [], 0, 100)))
    const result = await callMemory(ctx, { target: 'memory', operations: [input] })

    expect(result.isError).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
    expect(delegated).toEqual([{ target: 'memory', operations: [expected] }])
  })

  it('applies several actions of one batch in a single write, in order', async () => {
    const operations = [
      { action: 'remove', oldText: 'stale' },
      { action: 'replace', oldText: 'npm', content: 'uses pnpm' },
      { action: 'add', content: 'runs on Windows' },
    ]
    const { ctx, write, delegated } = await setup(target => Promise.resolve(applied(target, [], 0, 100)))
    const result = await callMemory(ctx, { target: 'memory', operations })

    expect(result.isError).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
    expect(delegated).toEqual([{ target: 'memory', operations }])
  })

  it('passes the `user` target through unchanged', async () => {
    const { ctx, delegated } = await setup(target => Promise.resolve(applied(target, ['name is Ada'], 10, 500)))
    await callMemory(ctx, { target: 'user', operations: [{ action: 'add', content: 'name is Ada' }] })
    expect(delegated[0]?.target).toBe('user')
  })

  it('narrows a field the chosen action does not carry to the empty string', async () => {
    // The provider owns the empty-content/empty-old-text outcomes, so the tool
    // forwards the absence instead of inventing a second failure vocabulary.
    const { ctx, delegated } = await setup(target => Promise.resolve(applied(target, [], 0, 100)))
    await callMemory(ctx, { target: 'memory', operations: [{ action: 'add' }, { action: 'replace' }, { action: 'remove' }] })
    expect(delegated[0]?.operations).toEqual([
      { action: 'add', content: '' },
      { action: 'replace', oldText: '', content: '' },
      { action: 'remove', oldText: '' },
    ])
  })

  it('builds the canonical value from the provider outcome instead of passing it through', async () => {
    // A provider may settle private fields of its own. The canonical value is the
    // tool's own contract, so forwarding the provider's object would leak them,
    // declare a readonly entries list where the schema declares a mutable one,
    // and fail the output schema's `additionalProperties: false` at the boundary.
    const outcome: MemoryWriteResult & { providerDetail: string } = {
      ok: false,
      code: 'over-budget',
      message: 'The memory target is full.',
      snapshot: { target: 'memory', entries: ['old fact'], chars: 9, limit: 8 },
      providerDetail: 'internal',
    }
    const { ctx } = await setup(() => Promise.resolve(outcome))
    const result = await callMemory(ctx, { target: 'memory', operations: [{ action: 'add', content: 'new fact' }] })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected the provider outcome to be a successful call')
    expect(result.value).toEqual({
      ok: false,
      code: 'over-budget',
      message: 'The memory target is full.',
      snapshot: { target: 'memory', entries: ['old fact'], chars: 9, limit: 8 },
    })
    expect(Object.keys(result.value as object).sort()).toEqual(['code', 'message', 'ok', 'snapshot'])
  })

  it('copies the provider entries into a fresh array and carries only the success fields', async () => {
    const entries: readonly string[] = ['a', 'b']
    const { ctx } = await setup(target => Promise.resolve({
      ok: true,
      note: 'Memory updated.',
      snapshot: { target, entries, chars: 42, limit: 200 },
    }))
    const result = await callMemory(ctx, { target: 'memory', operations: [{ action: 'add', content: 'a' }] })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected the memory write to succeed')
    expect(result.value).toEqual({
      ok: true,
      note: 'Memory updated.',
      snapshot: { target: 'memory', entries: ['a', 'b'], chars: 42, limit: 200 },
    })
    expect(Object.keys(result.value as object).sort()).toEqual(['note', 'ok', 'snapshot'])
  })

  it('renders a success as the confirmation plus budget usage', async () => {
    const { ctx } = await setup(target => Promise.resolve(applied(target, ['a', 'b'], 42, 200, 'Memory updated.')))
    const result = await callMemory(ctx, { target: 'memory', operations: [{ action: 'add', content: 'a' }] })

    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Memory updated. (42/200 chars used)')
  })

  it('renders a rejection with the current entries so the next batch can free room', async () => {
    const { ctx } = await setup(() => Promise.resolve({
      ok: false,
      code: 'over-budget',
      message: 'The memory target is full.',
      snapshot: { target: 'memory', entries: ['old fact'], chars: 9, limit: 8 },
    }))
    const result = await callMemory(ctx, { target: 'memory', operations: [{ action: 'add', content: 'new fact' }] })

    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'The memory target is full.\nCurrent memory entries (9/8 chars):\n- old fact',
    )
  })

  it('renders a rejection without a snapshot as the message alone', async () => {
    const { ctx } = await setup(() => Promise.resolve({
      ok: false,
      code: 'unowned-target',
      message: 'No memory provider stores the "user" target in this deployment.',
    }))
    const result = await callMemory(ctx, { target: 'user', operations: [{ action: 'add', content: 'name is Ada' }] })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected the settled outcome to be a successful call')
    expect(text(result)).toBe('No memory provider stores the "user" target in this deployment.')
    // The branch carries no snapshot, so the key is absent rather than undefined.
    expect(Object.keys(result.value as object).sort()).toEqual(['code', 'message', 'ok'])
  })

  it('renders a bare success and a message-less rejection without inventing detail', async () => {
    const { ctx } = await setup(target => Promise.resolve(applied(target, [], 0, 100)))
    const definition = ctx.tools.get('memory')
    expect(definition).toBeDefined()

    expect(definition?.output.render({}, { ok: true })).toEqual([{ type: 'text', text: 'Memory updated.' }])
    expect(definition?.output.render({}, { ok: false })).toEqual([{ type: 'text', text: 'Memory write rejected.' }])
  })

  it('reports a thrown provider failure as an isError result', async () => {
    const { ctx } = await setup(() => Promise.reject(new Error('memory storage is offline')))
    const result = await callMemory(ctx, { target: 'memory', operations: [{ action: 'add', content: 'a' }] })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('memory storage is offline')
  })

  it.each([
    { label: 'an unknown target', args: { target: 'global', operations: [] } },
    { label: 'an unknown action', args: { target: 'memory', operations: [{ action: 'append', content: 'a' }] } },
    { label: 'a missing operations array', args: { target: 'memory' } },
    { label: 'an unknown operation key', args: { target: 'memory', operations: [{ action: 'add', content: 'a', index: 0 }] } },
  ])('rejects $label before the provider is reached', async ({ args }) => {
    const { ctx, write } = await setup(target => Promise.resolve(applied(target, [], 0, 100)))
    const result = await callMemory(ctx, args)

    expect(result.isError).toBe(true)
    expect(write).not.toHaveBeenCalled()
  })

  it('unregisters the tool when its contributing fiber is disposed (HMR-safety)', async () => {
    const { ctx, fiber } = await setup(target => Promise.resolve(applied(target, [], 0, 100)))
    expect(ctx.tools.schemas().some(schema => schema.name === 'memory')).toBe(true)

    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'memory')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    // A default export would make Loader unwrap only apply and drop `inject`.
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-memory')
    expect(tool.inject).toEqual(['tools', 'memory'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-memory')
    expect(unwrapped.inject).toEqual(['tools', 'memory'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
