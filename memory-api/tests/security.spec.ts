import { afterEach, describe, expect, it } from 'vitest'
import { bootMemoryApi, type Harness } from './helpers/harness.ts'

/** The write body every accepted write in this suite sends. */
const WRITE_BODY = JSON.stringify({ target: 'memory', operations: [{ action: 'add', content: 'alpha' }] })

describe('memory-api request fence', () => {
  let harness: Harness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('refuses a read that carries no marker header', async () => {
    harness = await bootMemoryApi()

    const response = await fetch(`http://127.0.0.1:${harness.port}/memory/state`)

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'x-dsh-memory: 1 header is required' })
  })

  it('refuses a marker header carrying another value', async () => {
    harness = await bootMemoryApi()

    const response = await harness.call('/memory/state', { headers: { 'x-dsh-memory': 'true' } })

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ error: expect.stringContaining('header is required') })
  })

  it('refuses a foreign Origin on both routes', async () => {
    harness = await bootMemoryApi()

    const read = await harness.call('/memory/state', { headers: { origin: 'http://attacker.example' } })
    expect(read.status).toBe(403)
    expect(read.body).toEqual({ error: 'Origin "http://attacker.example" is not this server' })

    const write = await harness.call('/memory/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://attacker.example' },
      body: WRITE_BODY,
    })
    expect(write.status).toBe(403)
    expect((await harness.store.snapshot('memory')).entries).toEqual([])
  })

  it('refuses an opaque Origin', async () => {
    harness = await bootMemoryApi()

    const response = await harness.call('/memory/state', { headers: { origin: 'null' } })

    expect(response.status).toBe(403)
  })

  it('accepts either loopback spelling of this server origin', async () => {
    harness = await bootMemoryApi()

    expect((await harness.call('/memory/state', { headers: { origin: harness.origin } })).status).toBe(200)
    expect((await harness.call('/memory/state', { headers: { origin: harness.localhostOrigin } })).status).toBe(200)
  })

  it('accepts a read without Origin, the shape a same-origin GET navigation sends', async () => {
    harness = await bootMemoryApi()

    const response = await harness.call('/memory/state')

    expect(response.status).toBe(200)
  })

  it('refuses a write without Origin', async () => {
    harness = await bootMemoryApi()

    const response = await harness.call('/memory/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: WRITE_BODY,
    })

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'Origin header is required for this request' })
    expect((await harness.store.snapshot('memory')).entries).toEqual([])
  })

  it('answers no CORS preflight', async () => {
    harness = await bootMemoryApi()

    const response = await fetch(`http://127.0.0.1:${harness.port}/memory/write`, {
      method: 'OPTIONS',
      headers: { origin: 'http://attacker.example', 'access-control-request-headers': 'x-dsh-memory' },
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})
