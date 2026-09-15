import { describe, expect, it } from 'vitest'
import type { MemorySnapshot, MemoryTarget } from '@deepseek-ai/dsh-memory'
import {
  ENTRY_DELIMITER,
  createSectionText,
  measureEntries,
  renderCuratedSection,
  renderUsage,
} from '../src/render.ts'

/** Build a snapshot the way the store does, so measurements stay in one place. */
function snapshot(target: MemoryTarget, entries: readonly string[], limit = 100): MemorySnapshot {
  return { target, entries, chars: measureEntries(entries), limit }
}

/** A read function over a mutable, per-run entry map. */
function reader(state: { memory: string[]; user: string[] }): (target: MemoryTarget) => MemorySnapshot {
  return target => snapshot(target, state[target])
}

describe('measureEntries', () => {
  it('counts the entry delimiter between entries', () => {
    expect(ENTRY_DELIMITER).toBe('\n§\n')
    expect(measureEntries([])).toBe(0)
    expect(measureEntries(['abc'])).toBe(3)
    expect(measureEntries(['abc', 'de'])).toBe(3 + 3 + 2)
  })
})

describe('renderUsage', () => {
  it('reads as a percentage and a count against the limit', () => {
    expect(renderUsage(snapshot('memory', ['abcdefghij'], 100))).toBe('10% — 10/100 chars')
    expect(renderUsage(snapshot('memory', [], 100))).toBe('0% — 0/100 chars')
    expect(renderUsage(snapshot('user', ['abcdefghij'], 1000))).toBe('1% — 10/1000 chars')
  })
})

describe('renderCuratedSection', () => {
  it('renders nothing at all when neither target holds entries', () => {
    expect(renderCuratedSection(reader({ memory: [], user: [] }))).toBe('')
  })

  it('renders one block per target that holds entries, in target order', () => {
    const both = renderCuratedSection(reader({ memory: ['alpha', 'beta'], user: ['terse answers'] }))
    expect(both).toContain('Curated memory')
    expect(both).toContain('frozen for the current session')
    expect(both.indexOf('## memory')).toBeLessThan(both.indexOf('## user'))
    expect(both).toContain(`## memory (12% — ${measureEntries(['alpha', 'beta'])}/100 chars)\nalpha${ENTRY_DELIMITER}beta`)
    expect(both).toContain('## user (13% — 13/100 chars)\nterse answers')

    const onlyUser = renderCuratedSection(reader({ memory: [], user: ['terse answers'] }))
    expect(onlyUser).not.toContain('## memory')
    expect(onlyUser).toContain('## user')
  })
})

describe('createSectionText', () => {
  it('freezes the text at a scope\'s first assembly and re-reads for a new scope', () => {
    const state = { memory: ['alpha'], user: [] }
    const text = createSectionText(reader(state))
    const scope = {}
    const first = text({ scope })
    expect(first).toContain('alpha')

    state.memory = ['beta']
    expect(text({ scope })).toBe(first)
    const later = text({ scope: {} })
    expect(later).toContain('beta')
    expect(later).not.toBe(first)
  })

  it('freezes the unscoped assembly once as well', () => {
    const state = { memory: ['alpha'], user: [] }
    const text = createSectionText(reader(state))
    const first = text({})
    state.memory = ['beta']
    expect(text({})).toBe(first)
    expect(first).toContain('alpha')
  })

  it('freezes an empty render rather than re-evaluating it', () => {
    const state = { memory: [] as string[], user: [] as string[] }
    const text = createSectionText(reader(state))
    expect(text({})).toBe('')
    state.memory = ['alpha']
    expect(text({})).toBe('')
    const scope = {}
    expect(text({ scope })).toContain('alpha')
    state.memory = ['beta']
    expect(text({ scope })).toContain('alpha')
  })
})
