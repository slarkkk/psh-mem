import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryService from '../src/index.ts'
import type {
  MemoryOperation,
  MemoryProvider,
  MemoryRecall,
  MemoryRecallFacet,
  MemoryRecallRequest,
  MemorySnapshot,
  MemoryStoreFacet,
  MemoryTarget,
  MemoryWriteResult,
} from '../src/types.ts'

/**
 * Drives the real `ctx.memory` registry: providers are tiny fakes so every
 * routing, ownership, and failure-isolation decision in the service is the only
 * thing under observation.
 */

/** A store that records the owner and target of every call, making routing observable. */
class FakeStore implements MemoryStoreFacet {
  readonly snapshots: MemoryTarget[] = []
  readonly writes: { target: MemoryTarget; operations: readonly MemoryOperation[] }[] = []

  constructor(private readonly owner: string) {}

  async snapshot(target: MemoryTarget): Promise<MemorySnapshot> {
    this.snapshots.push(target)
    return snapshotOf(this.owner, target)
  }

  async write(target: MemoryTarget, operations: readonly MemoryOperation[]): Promise<MemoryWriteResult> {
    this.writes.push({ target, operations })
    return {
      ok: true,
      snapshot: snapshotOf(this.owner, target),
      note: `${operations.length} operation(s) applied`,
    }
  }
}

/** A recall facet that runs one scripted behavior per call. */
class FakeRecall implements MemoryRecallFacet {
  readonly calls: { request: MemoryRecallRequest; signal: AbortSignal | undefined }[] = []

  constructor(private readonly behavior: (request: MemoryRecallRequest) => Promise<readonly MemoryRecall[]>) {}

  async recall(request: MemoryRecallRequest, signal?: AbortSignal): Promise<readonly MemoryRecall[]> {
    this.calls.push({ request, signal })
    return this.behavior(request)
  }
}

function snapshotOf(
  owner: string,
  target: MemoryTarget,
  entries: readonly string[] = [`${owner}:${target}`],
): MemorySnapshot {
  return {
    target,
    entries,
    chars: entries.reduce((total, entry) => total + entry.length, 0),
    limit: 128,
  }
}

/** Recall results tagged with their producing provider, as the framing requires. */
function answers(provider: string, texts: readonly string[]): MemoryRecall[] {
  return texts.map((text, index) => ({ provider, label: `${provider} #${index}`, text }))
}

const REQUEST: MemoryRecallRequest = { query: 'where is the config', sessionId: 'session-1', limit: 3 }

async function mount(): Promise<{ ctx: Context; memory: MemoryService }> {
  const ctx = new Context()
  await ctx.plugin(MemoryService)
  return { ctx, memory: ctx.memory }
}

describe('MemoryService registration', () => {
  it('registers a provider, owns its targets, and frees both on disposal', async () => {
    const { memory } = await mount()
    const store = new FakeStore('curated')
    const provider: MemoryProvider = { name: 'curated', targets: ['memory', 'user'], store }

    const dispose = memory.register(provider)
    expect(memory.list()).toEqual([provider])
    expect(memory.get('curated')).toBe(provider)
    await expect(memory.snapshot('user')).resolves.toEqual(snapshotOf('curated', 'user'))
    expect(store.snapshots).toEqual(['user'])

    dispose()
    expect(memory.list()).toEqual([])
    expect(memory.get('curated')).toBeUndefined()
    await expect(memory.snapshot('user')).rejects.toThrow('no memory provider owns target "user"')

    // The disposer is idempotent: the second call finds no ownership left.
    dispose()
    expect(memory.list()).toEqual([])
    await expect(memory.snapshot('user')).rejects.toThrow('no memory provider owns target "user"')
  })

  it('rejects a duplicate provider name', async () => {
    const { memory } = await mount()
    const provider: MemoryProvider = { name: 'dup', targets: ['memory'], store: new FakeStore('dup') }
    memory.register(provider)

    expect(() => memory.register({ name: 'dup', recall: new FakeRecall(async () => []) }))
      .toThrow('memory provider "dup" is already registered')
    expect(memory.list()).toEqual([provider])
  })

  it('rejects a provider claiming targets without a store facet', async () => {
    const { memory } = await mount()

    expect(() => memory.register({ name: 'bare', targets: ['memory'] }))
      .toThrow('memory provider "bare" claims targets without a store facet')
    expect(memory.list()).toEqual([])

    // A provider that stores nothing needs no store facet.
    const recallOnly: MemoryProvider = { name: 'recall-only', recall: new FakeRecall(async () => []) }
    memory.register(recallOnly)
    expect(memory.list()).toEqual([recallOnly])
  })

  it('rejects a provider claiming a target another provider already owns', async () => {
    const { memory } = await mount()
    const first: MemoryProvider = { name: 'first', targets: ['memory'], store: new FakeStore('first') }
    const disposeFirst = memory.register(first)

    expect(() => memory.register({ name: 'second', targets: ['memory'], store: new FakeStore('second') }))
      .toThrow('memory target "memory" is already owned by provider "first"')
    expect(memory.list()).toEqual([first])

    // The rejected registration left no residue and no disposer: the first
    // owner still serves the target, and only its own disposer frees it.
    await expect(memory.snapshot('memory')).resolves.toEqual(snapshotOf('first', 'memory'))
    disposeFirst()
    await expect(memory.snapshot('memory')).rejects.toThrow('no memory provider owns target "memory"')
  })

  it('frees only the ownership its own registration created', async () => {
    const { memory } = await mount()
    const disposeStale = memory.register({ name: 'stale', targets: ['memory'], store: new FakeStore('stale') })
    disposeStale()

    const replacementStore = new FakeStore('replacement')
    const replacement: MemoryProvider = { name: 'replacement', targets: ['memory'], store: replacementStore }
    memory.register(replacement)

    // The superseded disposer must not free a target it no longer owns.
    disposeStale()
    expect(memory.list()).toEqual([replacement])
    await expect(memory.snapshot('memory')).resolves.toEqual(snapshotOf('replacement', 'memory'))
    expect(replacementStore.snapshots).toEqual(['memory'])
  })

  it('lists providers in registration order and looks them up by name', async () => {
    const { memory } = await mount()
    const zeta: MemoryProvider = { name: 'zeta', recall: new FakeRecall(async () => []) }
    const alpha: MemoryProvider = { name: 'alpha', recall: new FakeRecall(async () => []) }
    const mid: MemoryProvider = { name: 'mid', targets: ['user'], store: new FakeStore('mid') }
    memory.register(zeta)
    memory.register(alpha)
    memory.register(mid)

    expect(memory.list().map(provider => provider.name)).toEqual(['zeta', 'alpha', 'mid'])
    expect(memory.get('alpha')).toBe(alpha)
    expect(memory.get('unknown')).toBeUndefined()
  })

  it('removes the provider and its ownership when the contributing fiber is disposed (HMR-safety)', async () => {
    const { ctx } = await mount()
    const store = new FakeStore('hot')
    const provider: MemoryProvider = { name: 'hot', targets: ['user'], store }

    const fiber = await ctx.plugin({
      name: 'memory-provider-hot-test',
      inject: ['memory'],
      apply: (providerCtx: Context) => {
        providerCtx.effect(() => providerCtx.memory.register(provider))
      },
    })
    expect(ctx.memory.list()).toEqual([provider])
    await expect(ctx.memory.snapshot('user')).resolves.toEqual(snapshotOf('hot', 'user'))

    await fiber.dispose()
    expect(ctx.memory.list()).toEqual([])
    expect(ctx.memory.get('hot')).toBeUndefined()
    await expect(ctx.memory.snapshot('user')).rejects.toThrow('no memory provider owns target "user"')
  })
})

describe('MemoryService snapshot and write', () => {
  it('reads a target through the provider owning it', async () => {
    const { memory } = await mount()
    const store = new FakeStore('curated')
    memory.register({ name: 'curated', targets: ['memory'], store })

    await expect(memory.snapshot('memory')).resolves.toEqual(snapshotOf('curated', 'memory'))
    expect(store.snapshots).toEqual(['memory'])
  })

  it('throws when no registered provider owns the target', async () => {
    const { memory } = await mount()
    memory.register({ name: 'memory-only', targets: ['memory'], store: new FakeStore('memory-only') })

    await expect(memory.snapshot('user')).rejects.toThrow('no memory provider owns target "user"')
  })

  it('routes a write to the owning provider store', async () => {
    const { memory } = await mount()
    const store = new FakeStore('curated')
    memory.register({ name: 'curated', targets: ['memory'], store })
    const operations: MemoryOperation[] = [
      { action: 'remove', oldText: 'stale entry' },
      { action: 'add', content: 'fresh entry' },
    ]

    await expect(memory.write('memory', operations)).resolves.toEqual({
      ok: true,
      snapshot: snapshotOf('curated', 'memory'),
      note: '2 operation(s) applied',
    })
    expect(store.writes).toEqual([{ target: 'memory', operations }])
  })

  it('returns unowned-target without a snapshot when no provider owns the target', async () => {
    const { memory } = await mount()
    memory.register({ name: 'memory-only', targets: ['memory'], store: new FakeStore('memory-only') })

    const result = await memory.write('user', [{ action: 'add', content: 'kept' }])
    expect(result).toEqual({
      ok: false,
      code: 'unowned-target',
      message: 'No memory provider stores the "user" target in this deployment.',
    })
    expect(result).not.toHaveProperty('snapshot')
  })
})

describe('MemoryService recall', () => {
  it('concatenates recall from every provider offering the facet, in registration order', async () => {
    const { memory } = await mount()
    const signal = new AbortController().signal
    const first = new FakeRecall(async () => answers('first', ['one']))
    const second = new FakeRecall(async () => answers('second', ['two', 'three']))
    memory.register({ name: 'first', recall: first })
    memory.register({ name: 'store-only', targets: ['memory'], store: new FakeStore('store-only') })
    memory.register({ name: 'second', recall: second })

    await expect(memory.recall(REQUEST, signal)).resolves.toEqual([
      { provider: 'first', label: 'first #0', text: 'one' },
      { provider: 'second', label: 'second #0', text: 'two' },
      { provider: 'second', label: 'second #1', text: 'three' },
    ])
    expect(first.calls).toEqual([{ request: REQUEST, signal }])
    expect(second.calls).toEqual([{ request: REQUEST, signal }])
  })

  it('isolates a provider whose recall rejects, warning and contributing nothing', async () => {
    const { ctx, memory } = await mount()
    const warnings = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    memory.register({ name: 'healthy', recall: new FakeRecall(async () => answers('healthy', ['kept'])) })
    memory.register({
      name: 'broken',
      recall: new FakeRecall(async () => { throw new Error('backend down') }),
    })
    memory.register({ name: 'last', recall: new FakeRecall(async () => answers('last', ['also kept'])) })

    await expect(memory.recall(REQUEST)).resolves.toEqual([
      { provider: 'healthy', label: 'healthy #0', text: 'kept' },
      { provider: 'last', label: 'last #0', text: 'also kept' },
    ])
    expect(warnings).toHaveBeenCalledTimes(1)
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('memory provider "broken" recall failed'))
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('backend down'))
  })

  it('returns no recall when no provider offers the facet', async () => {
    const { memory } = await mount()
    memory.register({ name: 'store-only', targets: ['memory'], store: new FakeStore('store-only') })

    await expect(memory.recall(REQUEST)).resolves.toEqual([])
  })
})
