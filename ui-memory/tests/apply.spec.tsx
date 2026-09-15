// @vitest-environment jsdom
/**
 * Plugin registration: the memory tab lands on the conversation view ring with
 * the order and localized label the ring expects, its inject face drives the
 * shared controller, and disposing the contributing fiber removes the tab
 * (HMR safety). Also covers the node-half no-op.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import type { MemoryViewInjected } from '../src/client/MemoryView.tsx'
import { apply as nodeApply } from '../src/index.ts'

/** `GET /memory/state` body the stubbed transport answers with. */
const STATE_BODY = { targets: [{ target: 'user', entries: ['称呼：小明'], chars: 5, limit: 100 }] }

beforeEach(() => {
  // The plugin reads the memory API once at apply; the bench must not network.
  vi.stubGlobal('fetch', (async () => ({ ok: true, status: 200, json: async () => STATE_BODY })) as never)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Real-stack bench: root Context + real SlotRegistry ring + the plugin fiber. */
async function bench() {
  const ctx = new Context()
  const slots = new SlotRegistry(ctx)
  // The conversation entry's role: declare the ring, then seed the chat entry.
  slots.register({
    name: 'root',
    children: { 'conversation.view': { kind: 'list', scope: 'session' } },
  }, (_p: { renderSlot?: unknown }) => null)
  slots.register(
    { name: 'conversation.view', id: 'chat', order: 0, label: 'Chat' } as never,
    (() => null) as never,
  )
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, fiber }
}

/**
 * The memory entry currently on the ring, if any.
 * @param slots - the ring's registry.
 * @returns the entry, or undefined.
 */
function memoryEntry(slots: SlotRegistry) {
  return slots.entries('conversation.view').find(entry => entry.options.id === 'memory')
}

describe('ui-memory client plugin', () => {
  it('registers the memory tab at order 15 with a localized label', async () => {
    const { slots } = await bench()
    const entry = memoryEntry(slots)
    expect(entry).toBeDefined()
    expect(entry?.options.order).toBe(15)
    expect(entry?.locale).toBe('memory')
    const label = (entry?.options.label as () => string)()
    expect(['记忆', 'Memory']).toContain(label)
  })

  it('hands the shared store and staging callbacks through inject', async () => {
    const { slots } = await bench()
    const injected = (memoryEntry(slots)!.inject as unknown as (sessionId: string) => MemoryViewInjected)('s1')

    injected.addEntry('memory', '  note  ')
    expect(injected.hooks.memory.getSnapshot().sections.memory.additions).toEqual(['note'])
    injected.dropAddition('memory', 0)
    expect(injected.hooks.memory.getSnapshot().sections.memory.additions).toEqual([])

    injected.setDraft('user', 0, 'edited')
    expect(injected.hooks.memory.getSnapshot().sections.user.drafts).toEqual({ 0: 'edited' })
    injected.removeEntry('user', 0)
    expect(injected.hooks.memory.getSnapshot().sections.user.removed).toEqual([0])
    injected.restoreEntry('user', 0)
    expect(injected.hooks.memory.getSnapshot().sections.user.removed).toEqual([])

    injected.load()
    injected.save('user')
  })

  it('unloads the tab with the plugin fiber', async () => {
    const { fiber, slots } = await bench()
    expect(memoryEntry(slots)).toBeDefined()

    await fiber.dispose()

    expect(memoryEntry(slots)).toBeUndefined()
    expect(slots.entries('conversation.view').map(entry => entry.options.id)).not.toContain('memory')
  })

  it('node half is an intentional no-op (loader-managed lifecycle only)', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
