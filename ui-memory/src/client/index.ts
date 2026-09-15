/**
 * Browser memory plugin: one entry on the conversation view ring
 * (beside Chat and Trajectory) rendering the memory editor page. The editor
 * store and its API controller are created once per plugin lifecycle in apply()
 * and shared by every session's tab through the registration's inject face.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { MemoryView, type MemoryViewInjected } from './MemoryView.tsx'
import { en, NS, zh } from './locales.ts'
import { createMemoryStore, MemoryController } from './state.ts'

/** Required services: the conversation slot and the locale service. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: create the editor controller, register the locale
 * dictionaries, and add the memory view tab. Plugin unload disposes the
 * registration and stops the controller publishing further responses.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-memory: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createMemoryStore()
  const controller = new MemoryController(store)
  ctx.effect(() => () => { controller.dispose() }, 'ui-memory: controller lifecycle')
  // The host serves the memory API on this page's origin, so the one read at
  // plugin start is what fills the tab; the tab's Reload action refreshes it.
  void controller.load()

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'memory',
    order: 15,
    locale: NS,
    label: () => t('view.memory'),
    inject: (): MemoryViewInjected => ({
      hooks: { memory: store },
      load: () => { void controller.load() },
      save: (target) => { void controller.save(target) },
      setDraft: (target, index, text) => { controller.setDraft(target, index, text) },
      removeEntry: (target, index) => { controller.removeEntry(target, index) },
      restoreEntry: (target, index) => { controller.restoreEntry(target, index) },
      addEntry: (target, text) => { controller.addEntry(target, text) },
      dropAddition: (target, index) => { controller.dropAddition(target, index) },
    }),
  }, MemoryView))
}
