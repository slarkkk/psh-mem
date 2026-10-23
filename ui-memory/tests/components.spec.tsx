// @vitest-environment jsdom
/**
 * Memory view rendering: both target sections with their entries and usage, an
 * edited entry reaching the documented write payload, a refused write
 * surfacing the API's message, and the per-entry staging interactions.
 * Components are fed a real store and plain callbacks (no render machinery).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zh, type MemoryKey } from '../src/client/locales.ts'
import {
  createMemoryStore, MemoryController, type MemoryStateReport, type MemoryTarget,
} from '../src/client/state.ts'
import { MemoryView, type MemoryViewProps } from '../src/client/MemoryView.tsx'
import { createLessonsStore, LessonsController } from '../src/client/lessons.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** `GET /memory/state` body every case starts from. */
const STATE_BODY: MemoryStateReport = {
  targets: [
    { target: 'user', entries: ['称呼：小明'], chars: 5, limit: 100 },
    { target: 'memory', entries: ['项目代号是 tool'], chars: 9, limit: 200 },
  ],
}

/** The zh dictionary through the `{name}` interpolation the locale service uses. */
function translate(key: MemoryKey, params?: Record<string, unknown>): string {
  const template = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    (name in params ? String(params[name]) : match))
}

/** One recorded request. */
interface Call {
  readonly route: string
  readonly init: RequestInit
}

/** The smallest response face the controller reads. */
interface StubResponse {
  readonly ok: boolean
  readonly status: number
  json: () => Promise<unknown>
}

/**
 * Build a response.
 * @param body - decoded JSON body.
 * @param status - HTTP status.
 * @returns the stub response.
 */
function respond(body: unknown, status = 200): StubResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

/**
 * Mount the view over a real controller and a stub transport.
 * @param options - read and write responses the transport answers with.
 * @returns the rendered view plus the recorded requests and shared store.
 */
async function mount(options: { read?: StubResponse; write?: StubResponse } = {}) {
  const calls: Call[] = []
  const fetchImpl = (async (route: string, init: RequestInit) => {
    calls.push({ route, init })
    if (init.method === 'GET') return options.read ?? respond(STATE_BODY)
    return options.write ?? respond({ ok: true, note: '', snapshot: STATE_BODY })
  }) as unknown as typeof fetch
  const store = createMemoryStore()
  const controller = new MemoryController(store, { fetchImpl })
  await controller.load()
  // 教训区用独立的传输：它不算进记忆 API 的调用记录。
  const lessonsFetch = (async (route: string) => {
    if (route !== '/lessons/state') return respond({ ok: true })
    return respond({
      workspace: '/tmp/ws',
      counts: { total: 1, stale: 0, hits: 2 },
      lessons: [{
        id: 'abcdef12', title: '构建前先清 lib', fix: '先 pnpm run clean', tags: ['pnpm'],
        paths: [], tools: [], scope: 'workspace', hits: 2, ageDays: 3, stale: false,
      }],
    })
  }) as unknown as typeof fetch
  const lessonsStore = createLessonsStore()
  const lessonsController = new LessonsController(lessonsStore, { fetchImpl: lessonsFetch })
  await lessonsController.load()
  const props = {
    // The fixture selector reads the store directly: component specs assert a
    // given snapshot, and the renderer's real binding is ui-renderer's job.
    useMemory: (selector: (snapshot: ReturnType<typeof store.getSnapshot>) => unknown) =>
      selector(store.getSnapshot()),
    t: translate,
    load: () => { void controller.load() },
    save: (target: MemoryTarget) => { void controller.save(target) },
    setDraft: (target: MemoryTarget, index: number, text: string) => {
      controller.setDraft(target, index, text)
    },
    removeEntry: (target: MemoryTarget, index: number) => { controller.removeEntry(target, index) },
    restoreEntry: (target: MemoryTarget, index: number) => { controller.restoreEntry(target, index) },
    addEntry: (target: MemoryTarget, text: string) => { controller.addEntry(target, text) },
    dropAddition: (target: MemoryTarget, index: number) => { controller.dropAddition(target, index) },
    useLessons: (selector: (snapshot: ReturnType<typeof lessonsStore.getSnapshot>) => unknown) =>
      selector(lessonsStore.getSnapshot()),
    loadLessons: () => { void lessonsController.load() },
    confirmLesson: (id: string) => { void lessonsController.confirm(id) },
    forgetLesson: (id: string) => { void lessonsController.forget(id) },
  } as unknown as MemoryViewProps
  const view = render(<MemoryView {...props} />)
  // The fixture selector does not subscribe, so a store mutation needs an
  // explicit re-render; the real binding re-renders from the store.
  const sync = () => { view.rerender(<MemoryView {...props} />) }
  return { calls, controller, store, sync, ...view }
}

/** The user-profile section. */
function userSection() {
  return within(screen.getByRole('region', { name: '用户档案' }))
}

/** The memory section. */
function memorySection() {
  return within(screen.getByRole('region', { name: '记忆' }))
}

describe('MemoryView', () => {
  it('lists both targets with their entries and usage', async () => {
    await mount()
    expect(userSection().getByDisplayValue('称呼：小明')).toBeTruthy()
    expect(memorySection().getByDisplayValue('项目代号是 tool')).toBeTruthy()
    expect(userSection().getByText('5 / 100 字符')).toBeTruthy()
    expect(memorySection().getByText('9 / 200 字符')).toBeTruthy()
  })

  it('renders the recorded lessons inside the memory page', async () => {
    await mount()
    expect(screen.getByText('构建前先清 lib')).toBeTruthy()
    expect(screen.getByText('先 pnpm run clean')).toBeTruthy()
    expect(screen.getByRole('button', { name: '仍然成立' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy()
  })

  it('posts an edited entry as a replace operation for its own target', async () => {
    const { calls, sync } = await mount()
    fireEvent.change(userSection().getByDisplayValue('称呼：小明'), { target: { value: '称呼：小红' } })
    sync()

    expect(userSection().getByDisplayValue('称呼：小红')).toBeTruthy()
    fireEvent.click(userSection().getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(calls).toHaveLength(2) })

    expect(calls[1]?.route).toBe('/memory/write')
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      target: 'user',
      operations: [{ action: 'replace', oldText: '称呼：小明', content: '称呼：小红' }],
    })
  })

  it('surfaces the message of a refused write', async () => {
    const { store, sync } = await mount({ write: respond({ ok: false, code: 'limit', message: '记忆已写满' }) })
    fireEvent.change(userSection().getByDisplayValue('称呼：小明'), { target: { value: '称呼：小红' } })
    sync()
    fireEvent.click(userSection().getByRole('button', { name: '保存' }))

    await waitFor(() => { expect(store.getSnapshot().notice).toMatchObject({ kind: 'failed' }) })
    sync()

    expect(screen.getByRole('alert').textContent).toContain('请求失败')
    expect(screen.getByRole('alert').textContent).toContain('记忆已写满')
  })

  it('reports a failed first read with the HTTP status', async () => {
    await mount({ read: respond({}, 500) })

    expect(screen.getByText('无法读取记忆')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('HTTP 500')
  })

  it('stages a removal and restores it', async () => {
    const { store, sync } = await mount()
    fireEvent.click(userSection().getByRole('button', { name: '移除' }))
    sync()

    expect(store.getSnapshot().sections.user.removed).toEqual([0])
    expect(userSection().getByText('待移除')).toBeTruthy()

    fireEvent.click(userSection().getByRole('button', { name: '撤销' }))
    sync()

    expect(store.getSnapshot().sections.user.removed).toEqual([])
    expect(userSection().getByDisplayValue('称呼：小明')).toBeTruthy()
  })

  it('stages a new entry and discards it', async () => {
    const { store, sync } = await mount()
    fireEvent.change(memorySection().getByLabelText('新增条目'), { target: { value: '喜欢喝茶' } })
    fireEvent.click(memorySection().getByRole('button', { name: '添加' }))
    sync()

    expect(store.getSnapshot().sections.memory.additions).toEqual(['喜欢喝茶'])
    expect(memorySection().getByText('待添加')).toBeTruthy()

    fireEvent.click(memorySection().getByRole('button', { name: '丢弃' }))
    sync()

    expect(store.getSnapshot().sections.memory.additions).toEqual([])
  })

  it('keeps save inert until something is staged, and reloads on demand', async () => {
    const { calls } = await mount()
    expect(userSection().getByRole('button', { name: '保存' })).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))

    await waitFor(() => { expect(calls).toHaveLength(2) })
  })

  it('shows the empty state for a target with no entries', async () => {
    await mount({ read: respond({ targets: [{ target: 'user', entries: [], chars: 0, limit: 100 }] }) })

    expect(userSection().getByText('暂无条目')).toBeTruthy()
    expect(memorySection().getByText('0 / 0 字符')).toBeTruthy()
  })
})
