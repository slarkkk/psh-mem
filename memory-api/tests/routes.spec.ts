import { afterEach, describe, expect, it } from 'vitest'
import { bootMemoryApi, type Harness, type RouteResponse } from './helpers/harness.ts'

/** The listing one state response carries. */
interface TargetRow {
  readonly target: string
  readonly entries: readonly string[]
  readonly chars: number
  readonly limit: number
}

/** Narrow a state response body to its target rows. */
function rows(response: RouteResponse): readonly TargetRow[] {
  return (response.body as { targets: readonly TargetRow[] }).targets
}

describe('memory-api routes', () => {
  let harness: Harness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('reports one row per owned target', async () => {
    harness = await bootMemoryApi()
    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'alpha' }])
    await harness.ctx.memory.write('user', [{ action: 'add', content: 'beta' }])

    const response = await harness.call('/memory/state')

    expect(response.status).toBe(200)
    expect(rows(response)).toEqual([
      { target: 'memory', entries: ['alpha'], chars: 5, limit: 100 },
      { target: 'user', entries: ['beta'], chars: 4, limit: 100 },
    ])
  })

  it('omits a target this deployment registers no provider for', async () => {
    harness = await bootMemoryApi({ targets: ['memory'] })
    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'alpha' }])

    const response = await harness.call('/memory/state')

    expect(response.status).toBe(200)
    expect(rows(response).map(row => row.target)).toEqual(['memory'])
  })

  it('applies a write and returns the service result', async () => {
    harness = await bootMemoryApi()

    const response = await harness.call('/memory/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: harness.origin },
      body: JSON.stringify({ target: 'memory', operations: [{ action: 'add', content: 'alpha' }] }),
    })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      snapshot: { target: 'memory', entries: ['alpha'], chars: 5, limit: 100 },
      note: 'applied 1 operations',
    })
    expect((await harness.store.snapshot('memory')).entries).toEqual(['alpha'])
  })

  it('applies replace and remove against an existing entry', async () => {
    harness = await bootMemoryApi()
    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'alpha' }])
    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'beta' }])

    const response = await harness.call('/memory/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: harness.origin },
      body: JSON.stringify({
        target: 'memory',
        operations: [
          { action: 'replace', oldText: 'alpha', content: 'gamma' },
          { action: 'remove', oldText: 'beta' },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ok: true, note: 'applied 2 operations' })
    expect((await harness.store.snapshot('memory')).entries).toEqual(['gamma'])
  })

  it('returns a rejected write as the service settled it, not as an HTTP failure', async () => {
    harness = await bootMemoryApi()

    const response = await harness.call('/memory/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: harness.origin },
      body: JSON.stringify({ target: 'memory', operations: [{ action: 'remove', oldText: 'missing' }] }),
    })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ok: false, code: 'no-match' })
  })

  it('returns an unowned target as the service settled it', async () => {
    harness = await bootMemoryApi({ targets: ['memory'] })

    const response = await harness.call('/memory/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: harness.origin },
      body: JSON.stringify({ target: 'user', operations: [{ action: 'add', content: 'alpha' }] }),
    })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ok: false, code: 'unowned-target' })
  })

  it('rejects a malformed body with 400', async () => {
    harness = await bootMemoryApi()
    const bodies = [
      'not json',
      '"memory"',
      JSON.stringify({ target: 'other', operations: [] }),
      JSON.stringify({ target: 'memory' }),
      JSON.stringify({ target: 'memory', operations: 'add' }),
      JSON.stringify({ target: 'memory', operations: [{ action: 'add' }] }),
      JSON.stringify({ target: 'memory', operations: [{ action: 'purge', oldText: 'a' }] }),
      JSON.stringify({ target: 'memory', operations: [{ action: 'remove', oldText: 7 }] }),
    ]

    for (const body of bodies) {
      const response = await harness.call('/memory/write', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: harness.origin },
        body,
      })
      expect(response.status, body).toBe(400)
      expect(response.body, body).toEqual({ error: 'request body must be { target, operations }' })
    }
  })

  it('accepts an empty operation list and rejects a body past the size ceiling', async () => {
    harness = await bootMemoryApi()

    const empty = await harness.call('/memory/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: harness.origin },
      body: JSON.stringify({ target: 'memory', operations: [] }),
    })
    expect(empty.status).toBe(200)
    expect(empty.body).toMatchObject({ ok: true })

    const oversized = await harness.call('/memory/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: harness.origin },
      body: JSON.stringify({ target: 'memory', operations: [{ action: 'add', content: 'x'.repeat(70_000) }] }),
    })
    expect(oversized.status).toBe(400)
    expect(oversized.body).toEqual({ error: 'request body is too large' })
  })

  it('answers the wrong method with 405 and the supported one', async () => {
    harness = await bootMemoryApi()

    const state = await harness.call('/memory/state', {
      method: 'POST',
      headers: { origin: harness.origin },
    })
    expect(state.status).toBe(405)
    expect(state.allow).toBe('GET')

    const write = await harness.call('/memory/write')
    expect(write.status).toBe(405)
    expect(write.allow).toBe('POST')
  })
})
