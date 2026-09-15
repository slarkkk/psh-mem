import { describe, expect, it } from 'vitest'
import { Config, MEMORY_STATE_PATH, MEMORY_WRITE_PATH, inject, name } from '../src/index.ts'
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from '../src/security.ts'
import { bootMemoryApi } from './helpers/harness.ts'

describe('memory-api plugin', () => {
  it('publishes the plugin protocol slots the loader reads', () => {
    expect(name).toBe('memory-api')
    expect(inject).toEqual(['webServer', 'memory'])
  })

  it('pins the documented route contract', () => {
    expect(MEMORY_STATE_PATH).toBe('/memory/state')
    expect(MEMORY_WRITE_PATH).toBe('/memory/write')
    expect(REQUEST_HEADER).toBe('x-dsh-memory')
    expect(REQUEST_HEADER_VALUE).toBe('1')
  })

  it('enables the routes by default', async () => {
    const harness = await bootMemoryApi()
    try {
      expect(Config({})).toEqual({ enabled: true })
      expect((await harness.call(MEMORY_STATE_PATH)).status).toBe(200)
    } finally {
      await harness.dispose()
    }
  })

  it('registers no route while the deployment turns it off', async () => {
    const harness = await bootMemoryApi({ config: { enabled: false } })
    try {
      expect((await harness.call(MEMORY_STATE_PATH)).status).toBe(404)
      expect((await harness.call(MEMORY_WRITE_PATH, { method: 'POST', headers: { origin: harness.origin } })).status)
        .toBe(404)
    } finally {
      await harness.dispose()
    }
  })

  it('removes both routes when the fiber unloads', async () => {
    const harness = await bootMemoryApi()
    try {
      expect((await harness.call(MEMORY_STATE_PATH)).status).toBe(200)

      await harness.unmount()

      expect((await harness.call(MEMORY_STATE_PATH)).status).toBe(404)
      expect((await harness.call(MEMORY_WRITE_PATH, { method: 'POST', headers: { origin: harness.origin } })).status)
        .toBe(404)
    } finally {
      await harness.dispose()
    }
  })
})
