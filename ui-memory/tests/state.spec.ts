/**
 * Memory editor state: staged edits translate to the documented operations
 * payload, every request uses the relative route and the required header, and
 * a refused or non-2xx write surfaces the API's own message.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createMemoryStore, MemoryController, pendingOperations,
  type MemorySectionState, type MemoryStateReport,
} from '../src/client/state.ts'

/** `GET /memory/state` body used by the transport cases. */
const STATE_BODY: MemoryStateReport = {
  targets: [
    { target: 'user', entries: ['称呼：小明'], chars: 5, limit: 100 },
    { target: 'memory', entries: ['项目代号是 tool'], chars: 9, limit: 200 },
  ],
}

/** One section with nothing loaded and nothing staged. */
function section(overrides: Partial<MemorySectionState> = {}): MemorySectionState {
  return { entries: [], drafts: {}, removed: [], additions: [], chars: 0, limit: 0, ...overrides }
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
 * A fetch double that records every request.
 * @param reply - response factory keyed by the recorded call.
 * @returns the recorded calls and the fetch-shaped double.
 */
function recordingFetch(reply: (call: Call) => StubResponse): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = []
  const fetchImpl = (async (route: string, init: RequestInit) => {
    const call: Call = { route, init }
    calls.push(call)
    return reply(call)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('pendingOperations', () => {
  it('translates staged edits in loaded order, additions last', () => {
    expect(pendingOperations(section({
      entries: ['a', 'b', 'c'],
      drafts: { 1: 'b2' },
      removed: [2],
      additions: ['d', 'e'],
    }))).toEqual([
      { action: 'replace', oldText: 'b', content: 'b2' },
      { action: 'remove', oldText: 'c' },
      { action: 'add', content: 'd' },
      { action: 'add', content: 'e' },
    ])
  })

  it('stages nothing for an unchanged draft or an untouched section', () => {
    expect(pendingOperations(section({ entries: ['a'], drafts: { 0: 'a' } }))).toEqual([])
    expect(pendingOperations(section())).toEqual([])
  })

  it('drops the draft of an entry staged for removal', () => {
    expect(pendingOperations(section({ entries: ['a'], drafts: { 0: 'a2' }, removed: [0] })))
      .toEqual([{ action: 'remove', oldText: 'a' }])
  })
})

describe('MemoryController transport', () => {
  it('reads both targets from the relative route with the required header', async () => {
    const { calls, fetchImpl } = recordingFetch(() => respond(STATE_BODY))
    const store = createMemoryStore()
    await new MemoryController(store, { fetchImpl }).load()

    expect(calls.map(call => call.route)).toEqual(['/memory/state'])
    expect(calls[0]?.init.headers).toMatchObject({ 'x-dsh-memory': '1' })
    const snapshot = store.getSnapshot()
    expect(snapshot.phase).toBe('ready')
    expect(snapshot.sections.user.entries).toEqual(['称呼：小明'])
    expect(snapshot.sections.memory).toMatchObject({ chars: 9, limit: 200 })
  })

  it('posts the staged operations for one target', async () => {
    const { calls, fetchImpl } = recordingFetch(call => call.init.method === 'GET'
      ? respond(STATE_BODY)
      : respond({ ok: true, note: '更新 1 条', snapshot: STATE_BODY }))
    const store = createMemoryStore()
    const controller = new MemoryController(store, { fetchImpl })
    await controller.load()

    controller.setDraft('user', 0, '称呼：小红')
    controller.addEntry('memory', '  喜欢喝茶  ')
    await controller.save('user')

    expect(calls.map(call => call.route)).toEqual(['/memory/state', '/memory/write'])
    expect(calls[1]?.init.headers).toMatchObject({
      'x-dsh-memory': '1',
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      target: 'user',
      operations: [{ action: 'replace', oldText: '称呼：小明', content: '称呼：小红' }],
    })
    expect(store.getSnapshot().sections.memory.additions).toEqual(['喜欢喝茶'])
  })

  it('writes nothing when the section has no staged change', async () => {
    const { calls, fetchImpl } = recordingFetch(() => respond(STATE_BODY))
    const store = createMemoryStore()
    const controller = new MemoryController(store, { fetchImpl })
    await controller.load()

    await controller.save('user')

    expect(calls.map(call => call.route)).toEqual(['/memory/state'])
    expect(store.getSnapshot().notice).toEqual({ kind: 'unchanged' })
  })

  it('reports an accepted write with the note the API returned', async () => {
    const { fetchImpl } = recordingFetch(call => call.init.method === 'GET'
      ? respond(STATE_BODY)
      : respond({
        ok: true,
        note: '更新 1 条',
        snapshot: { targets: [{ target: 'user', entries: ['称呼：小红'], chars: 5, limit: 100 }] },
      }))
    const store = createMemoryStore()
    const controller = new MemoryController(store, { fetchImpl })
    await controller.load()
    controller.setDraft('user', 0, '称呼：小红')

    await controller.save('user')

    const snapshot = store.getSnapshot()
    expect(snapshot.notice).toEqual({ kind: 'saved', detail: '更新 1 条' })
    expect(snapshot.saving).toBeNull()
    // The accepted snapshot is authoritative: staged drafts are dropped.
    expect(snapshot.sections.user.entries).toEqual(['称呼：小红'])
    expect(snapshot.sections.user.drafts).toEqual({})
  })

  it('surfaces a refused write with the message the API returned', async () => {
    const { fetchImpl } = recordingFetch(call => call.init.method === 'GET'
      ? respond(STATE_BODY)
      : respond({ ok: false, code: 'limit', message: '记忆已写满' }))
    const store = createMemoryStore()
    const controller = new MemoryController(store, { fetchImpl })
    await controller.load()
    controller.setDraft('user', 0, '称呼：小红')

    await controller.save('user')

    const snapshot = store.getSnapshot()
    expect(snapshot.notice).toEqual({ kind: 'failed', status: null, detail: '记忆已写满' })
    expect(snapshot.saving).toBeNull()
    // A refusal keeps the staged edit so the user can retry it.
    expect(snapshot.sections.user.drafts).toEqual({ 0: '称呼：小红' })
  })

  it('reports a non-2xx response as a status failure', async () => {
    const { fetchImpl } = recordingFetch(() => respond({ message: 'no' }, 403))
    const store = createMemoryStore()

    await new MemoryController(store, { fetchImpl }).load()

    const snapshot = store.getSnapshot()
    expect(snapshot.phase).toBe('error')
    expect(snapshot.notice).toEqual({ kind: 'failed', status: 403, detail: null })
  })

  it('keeps a section failure from clearing the other section', async () => {
    const { fetchImpl } = recordingFetch(call => call.init.method === 'GET'
      ? respond(STATE_BODY)
      : respond({ ok: false, code: 'conflict', message: '找不到原文' }))
    const store = createMemoryStore()
    const controller = new MemoryController(store, { fetchImpl })
    await controller.load()
    controller.setDraft('memory', 0, '项目代号是 dsh')

    await controller.save('memory')

    expect(store.getSnapshot().sections.user.entries).toEqual(['称呼：小明'])
    expect(store.getSnapshot().sections.memory.entries).toEqual(['项目代号是 tool'])
  })

  it('stops publishing once disposed', async () => {
    const { fetchImpl } = recordingFetch(() => respond({}, 403))
    const store = createMemoryStore()
    const controller = new MemoryController(store, { fetchImpl })
    const before = store.getSnapshot()

    controller.dispose()
    await controller.load()

    expect(store.getSnapshot()).toBe(before)
  })
})

describe('MemoryController staging', () => {
  /** A controller over an empty store, with no transport in play. */
  function staged(): MemoryController {
    return new MemoryController(createMemoryStore(), { fetchImpl: vi.fn() as unknown as typeof fetch })
  }

  it('stages, restores, and discards edits through the store', () => {
    const controller = staged()
    controller.addEntry('memory', '  note  ')
    controller.addEntry('memory', '   ')
    controller.dropAddition('memory', 0)
    expect(controller.store.getSnapshot().sections.memory.additions).toEqual([])

    controller.removeEntry('user', 0)
    controller.removeEntry('user', 0)
    expect(controller.store.getSnapshot().sections.user.removed).toEqual([0])
    controller.restoreEntry('user', 0)
    expect(controller.store.getSnapshot().sections.user.removed).toEqual([])

    controller.setDraft('user', 1, 'edited')
    expect(controller.store.getSnapshot().sections.user.drafts).toEqual({ 1: 'edited' })
  })
})
