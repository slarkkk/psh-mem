import { describe, expect, it } from 'vitest'
import { Config, MEMORY_TARGETS, resolveConfig } from '../src/index.ts'

describe('resolveConfig', () => {
  it('fills every documented default', () => {
    expect(resolveConfig({})).toEqual({
      limits: { memory: 2200, user: 1375 },
      consolidationFailureLimit: 3,
      providerName: 'curated',
      sectionOrder: 700,
    })
  })

  it('keeps every configured value', () => {
    expect(resolveConfig({
      memoryLimit: 10,
      userLimit: 20,
      consolidationFailureLimit: 1,
      providerName: 'notes',
      sectionOrder: 1500,
    })).toEqual({
      limits: { memory: 10, user: 20 },
      consolidationFailureLimit: 1,
      providerName: 'notes',
      sectionOrder: 1500,
    })
  })

  it('defaults fields the loader schema also defaults', () => {
    const validated = (Config as unknown as (input: unknown) => Record<string, unknown>)({})
    expect(validated).toEqual({
      memoryLimit: 2200,
      userLimit: 1375,
      consolidationFailureLimit: 3,
      providerName: 'curated',
      sectionOrder: 700,
    })
  })
})

describe('MEMORY_TARGETS', () => {
  it('lists the two owned targets in render order', () => {
    expect(MEMORY_TARGETS).toEqual(['memory', 'user'])
  })
})
