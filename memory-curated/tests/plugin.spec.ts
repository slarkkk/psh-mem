import { describe, expect, it } from 'vitest'
import type { MemoryOperation } from '@deepseek-ai/dsh-memory'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { CuratedMemoryStore, SECTION_NAME, inject, name } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'
import { bootMemoryCurated, storedRecord } from './helpers/harness.ts'
import { failed } from './helpers/results.ts'

/** The curated section's text in one assembly, or `''` when it contributed nothing. */
function curatedText(assembly: PromptAssembly): string {
  return assembly.sections.find(section => section.name === SECTION_NAME)?.text ?? ''
}

describe('memory-curated plugin', () => {
  it('publishes the plugin protocol slots the loader reads', () => {
    expect(name).toBe('memory-curated')
    expect(inject).toEqual(['storageDomain', 'systemPrompt', 'memory'])
    expect(SECTION_NAME).toBe('memory:curated')
  })

  it('registers a store-only provider owning both curated targets', async () => {
    const harness = await bootMemoryCurated()
    const provider = harness.ctx.memory.get('curated')
    expect(provider?.name).toBe('curated')
    expect(provider?.targets).toEqual(['memory', 'user'])
    expect(provider?.store).toBeInstanceOf(CuratedMemoryStore)
    expect(provider?.recall).toBeUndefined()
    expect(harness.ctx.memory.list()).toHaveLength(1)
  })

  it('applies every configured value', async () => {
    const harness = await bootMemoryCurated({
      config: { memoryLimit: 40, userLimit: 20, providerName: 'notes', consolidationFailureLimit: 1 },
    })
    expect(harness.ctx.memory.get('notes')).toBeDefined()
    expect(await harness.ctx.memory.snapshot('memory')).toMatchObject({ limit: 40 })
    expect(await harness.ctx.memory.snapshot('user')).toMatchObject({ limit: 20 })
    // A cap of one makes the very first consolidation failure terminal.
    const terminal = failed(await harness.ctx.memory.write('memory', [
      { action: 'add', content: 'x'.repeat(30) },
      { action: 'add', content: 'y'.repeat(30) },
    ]))
    expect(terminal.message).toContain('Consolidation failed 1 times in this turn')
  })

  it('contributes nothing to the prompt while both targets are empty', async () => {
    const harness = await bootMemoryCurated()
    expect(curatedText(await harness.ctx.systemPrompt.assemble())).toBe('')
  })

  it('contributes the curated section at the configured order', async () => {
    const harness = await bootMemoryCurated()
    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'alpha' }])
    const assembly = await harness.ctx.systemPrompt.assemble()
    const section = assembly.sections.find(entry => entry.name === SECTION_NAME)
    expect(section?.text).toContain('## memory')
    expect(section?.text).toContain('alpha')
    expect(resolveConfig({}).sectionOrder).toBe(700)
  })

  it('freezes the section for a session and re-reads it for the next one', async () => {
    const harness = await bootMemoryCurated()
    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'alpha' }])
    const scope = {}
    const first = curatedText(await harness.ctx.systemPrompt.assemble({ scope }))
    expect(first).toContain('alpha')

    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'beta' }])
    expect(curatedText(await harness.ctx.systemPrompt.assemble({ scope }))).toBe(first)
    expect(curatedText(await harness.ctx.systemPrompt.assemble({ scope: {} }))).toContain('beta')
  })

  it('resets the consolidation allowance at a turn boundary', async () => {
    const harness = await bootMemoryCurated({ config: { memoryLimit: 30 }, sessions: true })
    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'aaaaaaaaaa' }])
    const overflowing: MemoryOperation[] = [{ action: 'add', content: 'b'.repeat(20) }]
    await harness.ctx.memory.write('memory', overflowing)
    await harness.ctx.memory.write('memory', overflowing)
    expect(failed(await harness.ctx.memory.write('memory', overflowing)).message)
      .toContain('Consolidation failed 3 times')

    const session = harness.ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect(failed(await harness.ctx.memory.write('memory', overflowing)).message).toContain('Consolidate:')
  })

  it('removes its provider, its domain, and its section when the fiber unloads', async () => {
    const harness = await bootMemoryCurated()
    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'alpha' }])
    expect(harness.ctx.memory.list()).toHaveLength(1)
    expect(harness.ctx.storageDomain.get('memory')).toBeDefined()
    expect(curatedText(await harness.ctx.systemPrompt.assemble())).toContain('alpha')

    await harness.fiber.dispose()

    expect(harness.ctx.memory.list()).toEqual([])
    expect(harness.ctx.storageDomain.get('memory')).toBeUndefined()
    expect(curatedText(await harness.ctx.systemPrompt.assemble())).toBe('')
    await expect(harness.ctx.memory.snapshot('memory')).rejects.toThrow('no memory provider owns target')
    // The domain closed cleanly, so the entry the write committed is still durable.
    expect(storedRecord(harness.pool, 'memory')).toEqual({ entries: ['alpha'] })
  })
})
