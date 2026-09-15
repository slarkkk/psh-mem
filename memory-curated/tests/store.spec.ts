import { describe, expect, it } from 'vitest'
import type { MemoryOperation } from '@deepseek-ai/dsh-memory'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { bootMemoryCurated, storedRecord } from './helpers/harness.ts'
import { failed, succeeded } from './helpers/results.ts'
import { measureEntries } from '../src/render.ts'

/** An entry long enough that adding it to a target holding `aaaaaaaaaa` overflows a 30-character budget. */
const OVERFLOWING_ENTRY = 'b'.repeat(20)

describe('CuratedMemoryStore', () => {
  it('starts every target empty at its configured limit', async () => {
    const harness = await bootMemoryCurated()
    expect(await harness.ctx.memory.snapshot('memory')).toEqual({
      target: 'memory',
      entries: [],
      chars: 0,
      limit: 2200,
    })
    expect(await harness.ctx.memory.snapshot('user')).toEqual({
      target: 'user',
      entries: [],
      chars: 0,
      limit: 1375,
    })
  })

  it('appends entries in order, reports usage, and persists them', async () => {
    const harness = await bootMemoryCurated()
    const result = succeeded(await harness.ctx.memory.write('memory', [
      { action: 'add', content: 'alpha' },
      { action: 'add', content: 'beta' },
    ]))
    expect(result.snapshot).toEqual({
      target: 'memory',
      entries: ['alpha', 'beta'],
      chars: measureEntries(['alpha', 'beta']),
      limit: 2200,
    })
    expect(result.note).toBe(
      'Memory "memory" holds 2 entries (1% — 12/2200 chars). '
      + 'This update is complete and must not be repeated.',
    )
    expect(await harness.ctx.memory.snapshot('memory')).toEqual(result.snapshot)
    expect(storedRecord(harness.pool, 'memory')).toEqual({ entries: ['alpha', 'beta'] })
  })

  it('settles a repeated add as a no-op success rather than a failure', async () => {
    const harness = await bootMemoryCurated()
    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'alpha' }])
    const repeated = succeeded(await harness.ctx.memory.write('memory', [{ action: 'add', content: 'alpha' }]))
    expect(repeated.snapshot.entries).toEqual(['alpha'])
    expect(repeated.note).toBe(
      'Memory "memory" holds 1 entry (0% — 5/2200 chars). '
      + 'This update is complete and must not be repeated.',
    )
  })

  it('replaces the one entry containing the addressing text', async () => {
    const harness = await bootMemoryCurated()
    await harness.ctx.memory.write('memory', [
      { action: 'add', content: 'alpha' },
      { action: 'add', content: 'beta' },
    ])
    const result = succeeded(await harness.ctx.memory.write('memory', [
      { action: 'replace', oldText: 'alp', content: 'gamma' },
    ]))
    expect(result.snapshot.entries).toEqual(['gamma', 'beta'])
  })

  it('removes the one entry containing the addressing text', async () => {
    const harness = await bootMemoryCurated()
    await harness.ctx.memory.write('memory', [
      { action: 'add', content: 'alpha' },
      { action: 'add', content: 'beta' },
    ])
    const result = succeeded(await harness.ctx.memory.write('memory', [
      { action: 'remove', oldText: 'bet' },
    ]))
    expect(result.snapshot.entries).toEqual(['alpha'])
  })

  it('treats identical duplicate entries as one match and edits the first', async () => {
    // No public write can store a duplicate (a repeated add is a no-op), so the
    // state is seeded on the medium — where a record written by an older
    // generation or by another writer would come from.
    const pool = new MemoryMediaPool()
    pool.media.set('memory', {
      tables: new Map([['targets', new Map([['memory', { entries: ['dup one', 'dup one'] }]])]]),
      global: null,
    })
    const harness = await bootMemoryCurated({ pool })
    const replaced = succeeded(await harness.ctx.memory.write('memory', [
      { action: 'replace', oldText: 'dup', content: 'next' },
    ]))
    expect(replaced.snapshot.entries).toEqual(['next', 'dup one'])
  })

  it('rejects an address that matches two distinct entries', async () => {
    const harness = await bootMemoryCurated()
    await harness.ctx.memory.write('memory', [
      { action: 'add', content: 'alpha one' },
      { action: 'add', content: 'beta alpha' },
    ])
    const replace = failed(await harness.ctx.memory.write('memory', [
      { action: 'replace', oldText: 'alpha', content: 'gamma' },
    ]))
    const result = failed(await harness.ctx.memory.write('memory', [
      { action: 'remove', oldText: 'alpha' },
    ]))
    expect(replace.code).toBe('ambiguous-match')
    expect(result.code).toBe('ambiguous-match')
    expect(result.message).toContain('matches 2 distinct entries in "memory"')
    expect(result.message).toContain('1. alpha one')
    expect(result.message).toContain('2. beta alpha')
    expect(await harness.ctx.memory.snapshot('memory')).toMatchObject({ entries: ['alpha one', 'beta alpha'] })
  })

  it('rejects an address that matches nothing', async () => {
    const harness = await bootMemoryCurated()
    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'alpha' }])
    const result = failed(await harness.ctx.memory.write('memory', [
      { action: 'replace', oldText: 'missing', content: 'next' },
    ]))
    expect(result.code).toBe('no-match')
    expect(result.message).toContain('No entry in "memory" contains "missing"')
    expect(result.message).toContain('1. alpha')
    expect(result.snapshot?.entries).toEqual(['alpha'])
  })

  it('rejects empty content and empty addressing text without storing anything', async () => {
    const harness = await bootMemoryCurated()
    const add = failed(await harness.ctx.memory.write('memory', [{ action: 'add', content: '' }]))
    expect(add.code).toBe('empty-content')
    expect(add.message).toContain('must not be empty')
    const replaceContent = failed(await harness.ctx.memory.write('memory', [
      { action: 'replace', oldText: 'alpha', content: '' },
    ]))
    expect(replaceContent.code).toBe('empty-content')
    const replaceAddress = failed(await harness.ctx.memory.write('memory', [
      { action: 'replace', oldText: '', content: 'alpha' },
    ]))
    expect(replaceAddress.code).toBe('empty-old-text')
    const removeAddress = failed(await harness.ctx.memory.write('memory', [
      { action: 'remove', oldText: '' },
    ]))
    expect(removeAddress.code).toBe('empty-old-text')
    expect(await harness.ctx.memory.snapshot('memory')).toMatchObject({ entries: [], chars: 0 })
  })

  it('fails loudly on an operation outside the closed union', async () => {
    const harness = await bootMemoryCurated()
    // Only a cast can produce this tag; a new union member must reach `assertNever`.
    const rogue = { action: 'consolidate' } as unknown as MemoryOperation
    await expect(harness.ctx.memory.write('memory', [rogue])).rejects.toThrow('memory operation')
  })

  it('measures the budget over the final result, never per operation', async () => {
    const harness = await bootMemoryCurated({ config: { memoryLimit: 30 } })
    const result = succeeded(await harness.ctx.memory.write('memory', [
      { action: 'add', content: 'aaaaaaaaaa' },
      { action: 'add', content: 'bbbbbbbbbb' },
      { action: 'remove', oldText: 'bbbbbbbbbb' },
    ]))
    expect(result.snapshot.entries).toEqual(['aaaaaaaaaa'])
    expect(result.snapshot.chars).toBe(10)
  })

  it('lets one batch free room and add in the same request', async () => {
    const harness = await bootMemoryCurated({ config: { memoryLimit: 30 } })
    await harness.ctx.memory.write('memory', [
      { action: 'add', content: 'aaaaaaaaaa' },
      { action: 'add', content: 'bbbbbbbbbb' },
    ])
    const alone = failed(await harness.ctx.memory.write('memory', [{ action: 'add', content: 'dddddddddd' }]))
    expect(alone.code).toBe('over-budget')
    const batch = succeeded(await harness.ctx.memory.write('memory', [
      { action: 'remove', oldText: 'aaaaaaaaaa' },
      { action: 'add', content: 'dddddddddd' },
    ]))
    expect(batch.snapshot.entries).toEqual(['bbbbbbbbbb', 'dddddddddd'])
  })

  it('names both counts, lists the entries, and asks for consolidation on overflow', async () => {
    const harness = await bootMemoryCurated({ config: { memoryLimit: 30 } })
    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'aaaaaaaaaa' }])
    const result = failed(await harness.ctx.memory.write('memory', [
      { action: 'add', content: 'bbbbbbbbbb' },
      { action: 'add', content: 'dddddddddd' },
    ]))
    expect(result.code).toBe('over-budget')
    expect(result.message).toContain('36/30 characters, 6 over its budget')
    expect(result.message).toContain('Current entries (1):')
    expect(result.message).toContain('1. aaaaaaaaaa')
    expect(result.message).toContain('replace or remove stale entries')
    expect(result.snapshot).toEqual({ target: 'memory', entries: ['aaaaaaaaaa'], chars: 10, limit: 30 })
    expect(storedRecord(harness.pool, 'memory')).toEqual({ entries: ['aaaaaaaaaa'] })
  })

  it('turns the third failed consolidation in one turn terminal', async () => {
    const harness = await bootMemoryCurated({ config: { memoryLimit: 30 } })
    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'aaaaaaaaaa' }])
    const overflowing: MemoryOperation[] = [{ action: 'add', content: OVERFLOWING_ENTRY }]
    const first = failed(await harness.ctx.memory.write('memory', overflowing))
    const second = failed(await harness.ctx.memory.write('memory', overflowing))
    const third = failed(await harness.ctx.memory.write('memory', overflowing))
    const fourth = failed(await harness.ctx.memory.write('memory', overflowing))
    expect(first.message).toContain('Consolidate:')
    expect(second.message).toContain('Consolidate:')
    expect(third.message).toContain('Consolidation failed 3 times in this turn')
    expect(third.message).toContain('"memory" is over its 30-character budget')
    expect(third.message).toContain('Stop calling the memory tool now')
    expect(third.message).not.toContain('Current entries')
    // Every later attempt in the same turn stays terminal.
    expect(fourth.message).toContain('Consolidation failed 4 times in this turn')
    expect(fourth.message).toContain('Stop calling the memory tool now')
    expect(fourth.message).not.toContain('Consolidate:')
  })

  it('turns the third unmatched address in one turn terminal', async () => {
    const harness = await bootMemoryCurated()
    const unmatched: MemoryOperation[] = [{ action: 'remove', oldText: 'nothing' }]
    await harness.ctx.memory.write('memory', unmatched)
    await harness.ctx.memory.write('memory', unmatched)
    const third = failed(await harness.ctx.memory.write('memory', unmatched))
    expect(third.message).toContain('Consolidation failed 3 times in this turn')
    expect(third.message).toContain('no entry in "memory" matches the text you addressed')
    expect(third.message).toContain('Stop calling the memory tool now')
  })

  it('does not spend the allowance on codes that do not ask for a retry', async () => {
    const harness = await bootMemoryCurated({ config: { memoryLimit: 30 } })
    await harness.ctx.memory.write('memory', [
      { action: 'add', content: 'alpha one' },
      { action: 'add', content: 'beta alpha' },
    ])
    const ambiguous: MemoryOperation[] = [{ action: 'remove', oldText: 'alpha' }]
    await harness.ctx.memory.write('memory', ambiguous)
    await harness.ctx.memory.write('memory', ambiguous)
    await harness.ctx.memory.write('memory', ambiguous)
    const overflow = failed(await harness.ctx.memory.write('memory', [
      { action: 'add', content: 'bbbbbbbbbb' },
      { action: 'add', content: 'dddddddddd' },
    ]))
    expect(overflow.message).toContain('Consolidate:')
  })

  it('clears the allowance on a landed write', async () => {
    const harness = await bootMemoryCurated({ config: { memoryLimit: 30 } })
    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'aaaaaaaaaa' }])
    const overflowing: MemoryOperation[] = [{ action: 'add', content: OVERFLOWING_ENTRY }]
    await harness.ctx.memory.write('memory', overflowing)
    await harness.ctx.memory.write('memory', overflowing)
    await harness.ctx.memory.write('memory', [{ action: 'remove', oldText: 'aaaaaaaaaa' }])
    const afterSuccess = failed(await harness.ctx.memory.write('memory', [
      { action: 'add', content: 'aaaaaaaaaa' },
      { action: 'add', content: OVERFLOWING_ENTRY },
    ]))
    expect(afterSuccess.message).toContain('Consolidate:')
    expect(afterSuccess.message).not.toContain('Stop calling the memory tool')
  })

  it('clears the allowance when a turn ends', async () => {
    const harness = await bootMemoryCurated({ config: { memoryLimit: 30 } })
    await harness.ctx.memory.write('memory', [{ action: 'add', content: 'aaaaaaaaaa' }])
    const overflowing: MemoryOperation[] = [{ action: 'add', content: OVERFLOWING_ENTRY }]
    await harness.ctx.memory.write('memory', overflowing)
    await harness.ctx.memory.write('memory', overflowing)
    expect(failed(await harness.ctx.memory.write('memory', overflowing)).message)
      .toContain('Consolidation failed 3 times')
    harness.store.resetTurn()
    expect(failed(await harness.ctx.memory.write('memory', overflowing)).message).toContain('Consolidate:')
  })

  it('keeps stored entries across a reopen of the same medium', async () => {
    const harness = await bootMemoryCurated()
    await harness.ctx.memory.write('user', [{ action: 'add', content: 'prefers terse answers' }])
    const reopened = await bootMemoryCurated({ pool: harness.pool })
    expect(await reopened.ctx.memory.snapshot('user')).toEqual({
      target: 'user',
      entries: ['prefers terse answers'],
      chars: 'prefers terse answers'.length,
      limit: 1375,
    })
  })
})
