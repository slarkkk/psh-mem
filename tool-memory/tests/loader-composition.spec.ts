// Proves the plugin composes for real: a cordis.yml booted through the real
// Loader mounts the memory capability and this tool, the model-facing
// description comes back from the live registry, and a call reaches the real
// `ctx.memory` service and the store provider registered behind it. The store
// is the only stand-in.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import MemoryService from '@deepseek-ai/dsh-memory'
import type {
  MemoryOperation,
  MemorySnapshot,
  MemoryStoreFacet,
  MemoryTarget,
  MemoryWriteResult,
} from '@deepseek-ai/dsh-memory'
import * as ToolMemory from '../src/index.ts'

/**
 * Test-only curated store: the targets it is told to own, a fixed character
 * budget, and the all-or-nothing batch semantics the provider contract
 * requires. A rejection reports the entries as they still stand, because the
 * caller consolidates against those.
 */
class FixtureStore implements MemoryStoreFacet {
  private readonly entries = new Map<MemoryTarget, string[]>()
  /** Every batch the tool delivered through `ctx.memory`, in call order. */
  readonly writes: { target: MemoryTarget; operations: readonly MemoryOperation[] }[] = []

  /**
   * @param limit - maximum characters one target may occupy.
   */
  constructor(private readonly limit: number) {}

  /**
   * @param target - curated target to read.
   * @returns the fixture's entries and usage for that target.
   */
  snapshot(target: MemoryTarget): Promise<MemorySnapshot> {
    return Promise.resolve(this.view(target, this.entries.get(target) ?? []))
  }

  /**
   * @param target - curated target to mutate.
   * @param operations - entry mutations, applied in order.
   * @returns the settled outcome with the resulting or the still-standing snapshot.
   */
  write(target: MemoryTarget, operations: readonly MemoryOperation[]): Promise<MemoryWriteResult> {
    this.writes.push({ target, operations })
    const current = this.entries.get(target) ?? []
    const next = [...current]
    for (const operation of operations) {
      if (operation.action === 'add') {
        next.push(operation.content)
        continue
      }
      const at = next.findIndex(entry => entry.includes(operation.oldText))
      if (at === -1) {
        return Promise.resolve({
          ok: false,
          code: 'no-match',
          message: `No ${target} entry contains ${JSON.stringify(operation.oldText)}.`,
          snapshot: this.view(target, current),
        })
      }
      if (operation.action === 'replace') next[at] = operation.content
      else next.splice(at, 1)
    }
    if (measure(next) > this.limit) {
      return Promise.resolve({
        ok: false,
        code: 'over-budget',
        message: `The ${target} target would exceed its ${String(this.limit)}-character budget.`,
        snapshot: this.view(target, current),
      })
    }
    this.entries.set(target, next)
    return Promise.resolve({
      ok: true,
      snapshot: this.view(target, next),
      note: `${String(operations.length)} operation(s) applied to ${target}.`,
    })
  }

  /**
   * @param target - target the snapshot describes.
   * @param entries - entries to report and measure.
   * @returns the snapshot for those entries under this store's budget.
   */
  private view(target: MemoryTarget, entries: readonly string[]): MemorySnapshot {
    return { target, entries: [...entries], chars: measure(entries), limit: this.limit }
  }
}

/**
 * @param entries - entries to measure.
 * @returns the characters the joined entries occupy.
 */
function measure(entries: readonly string[]): number {
  return entries.join('\n').length
}

/**
 * Join the text blocks of one result.
 * @param result - a normalized execution result.
 * @returns the model-facing text.
 */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying prompt assembly, the tool registry, the memory
 * capability, and this tool, then register the test-only store provider.
 * @param limit - character budget the fixture store enforces per target.
 * @param targets - curated targets the fixture provider owns.
 * @returns the booted context and the fixture store behind `ctx.memory`.
 */
async function boot(limit: number, targets: readonly MemoryTarget[] = ['memory', 'user']): Promise<{ ctx: Context; store: FixtureStore }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-memory'",
    "- name: '@deepseek-ai/dsh-tool-memory'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-memory', MemoryService],
    ['@deepseek-ai/dsh-tool-memory', ToolMemory],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  const store = new FixtureStore(limit)
  ctx.effect(() => ctx.memory.register({ name: 'fixture-store', targets, store }))
  return { ctx, store }
}

/**
 * Invoke the loaded `memory` tool through the live registry.
 * @param ctx - booted context carrying the registered tool.
 * @param target - curated target to write.
 * @param operations - raw model operations.
 * @returns the normalized execution result.
 */
function callMemory(ctx: Context, target: MemoryTarget, operations: readonly unknown[]) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`loader-${target}-${String(operations.length)}`),
    name: 'memory',
    arguments: { target, operations },
  })
}

describe('tool-memory real Loader composition through cordis.yml', () => {
  it('serves the model-facing description and writes through ctx.memory end to end', async () => {
    const { ctx, store } = await boot(400)
    const description = ctx.tools.schemas().find(schema => schema.name === 'memory')?.description ?? ''
    expect(description).toContain('Durable facts that outlive this session')
    expect(description).toContain('Targets: `user` is who the user is')
    expect(description).toContain('`memory` is your own notes')

    const result = await callMemory(ctx, 'memory', [{ action: 'add', content: 'the repo uses pnpm' }])

    expect(result.isError).toBe(false)
    expect(store.writes).toEqual([
      { target: 'memory', operations: [{ action: 'add', content: 'the repo uses pnpm' }] },
    ])
    if (result.isError) throw new Error('expected the memory write to succeed')
    expect(result.value).toMatchObject({
      ok: true,
      snapshot: { target: 'memory', entries: ['the repo uses pnpm'], chars: 18, limit: 400 },
    })
    expect(text(result)).toContain('1 operation(s) applied to memory.')
    expect(text(result)).toContain('(18/400 chars used)')
    await expect(ctx.memory.snapshot('memory')).resolves.toMatchObject({ entries: ['the repo uses pnpm'] })
  }, 30_000)

  it('hands back the still-standing entries when a batch overflows the budget', async () => {
    const { ctx } = await boot(40)
    await callMemory(ctx, 'memory', [{ action: 'add', content: 'the repo uses pnpm' }])

    const result = await callMemory(ctx, 'memory', [
      { action: 'add', content: 'every workspace package is ESM and imports siblings by name' },
    ])

    expect(result.isError).toBe(false)
    expect(text(result)).toContain('would exceed its 40-character budget')
    expect(text(result)).toContain('Current memory entries (18/40 chars):')
    expect(text(result)).toContain('- the repo uses pnpm')
    expect(text(result)).not.toContain('every workspace package is ESM')
    await expect(ctx.memory.snapshot('memory')).resolves.toMatchObject({ entries: ['the repo uses pnpm'] })
  }, 30_000)

  it('reports the real unowned-target outcome for a target no provider owns', async () => {
    const { ctx, store } = await boot(400, ['memory'])
    const result = await callMemory(ctx, 'user', [{ action: 'add', content: 'name is Ada' }])

    expect(result.isError).toBe(false)
    expect(text(result)).toBe('No memory provider stores the "user" target in this deployment.')
    expect(store.writes).toEqual([])
  }, 30_000)
})
