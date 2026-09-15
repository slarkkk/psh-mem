/**
 * Test harness for the curated memory provider: boots the real storage hub,
 * domain facility, system-prompt registry, and memory service over an in-memory
 * backend, then mounts this package's plugin on top of them. Nothing here is
 * published; it exists so each spec drives the shipped composition instead of a
 * hand-built stand-in.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import MemoryService from '@deepseek-ai/dsh-memory'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  MemoryMediaPool,
  MemoryStorageBackend,
} from '../../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as memoryCurated from '../../src/index.ts'
import type { Config, CuratedMemoryStore } from '../../src/index.ts'

/** Options controlling one harness boot. */
export interface HarnessOptions {
  /** Plugin configuration handed to the provider; omitted means every default. */
  readonly config?: Config
  /** Shared media pool; pass one to reopen the same medium after a restart. */
  readonly pool?: MemoryMediaPool
  /** Backend serving the `memory` domain; omitted means an in-memory backend over `pool`. */
  readonly backend?: StorageBackend
  /** Mount the real session store, for specs that publish `session/event`. */
  readonly sessions?: boolean
}

/** One booted composition. */
export interface Harness {
  /** Root context carrying every mounted plugin. */
  readonly ctx: Context
  /** Fiber of this package's plugin; disposing it unloads the provider. */
  readonly fiber: { dispose(): Promise<void> }
  /** Media pool the backend writes into. */
  readonly pool: MemoryMediaPool
  /** The store instance the plugin registered. */
  readonly store: CuratedMemoryStore
}

/**
 * Boot the shipped composition over an in-memory storage backend.
 * @param options - configuration, media pool, backend, and session-store overrides.
 * @returns the root context, the provider fiber, and the registered store.
 */
export async function bootMemoryCurated(options: HarnessOptions = {}): Promise<Harness> {
  const pool = options.pool ?? new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', options.backend ?? new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(MemoryService)
  if (options.sessions === true) await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(memoryCurated, options.config ?? {})
  // The provider is what registers the store, so this lookup also proves the
  // registration happened.
  const store = ctx.memory.list()[0]?.store as CuratedMemoryStore
  return { ctx, fiber, pool, store }
}

/**
 * Read one target's durable record straight off the medium, bypassing the
 * domain's in-memory table, so a spec can assert what actually persisted.
 * @param pool - the harness's media pool.
 * @param target - target whose record to read.
 * @returns the stored record, or `undefined` when the target was never written.
 */
export function storedRecord(pool: MemoryMediaPool, target: string): unknown {
  return pool.media.get('memory')?.tables.get('targets')?.get(target)
}
