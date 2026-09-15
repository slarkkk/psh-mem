/**
 * Test harness for the memory HTTP routes: boots the real webserver on an
 * OS-assigned loopback port, the real memory service, and a stub provider
 * owning the targets a spec asks for, then mounts this package's plugin on top.
 * Nothing here is published; it exists so each spec drives the shipped route
 * registration over a real socket instead of a hand-built request object.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import MemoryService from '@deepseek-ai/dsh-memory'
import type {
  MemoryOperation,
  MemorySnapshot,
  MemoryStoreFacet,
  MemoryTarget,
  MemoryWriteResult,
} from '@deepseek-ai/dsh-memory'
import * as memoryApi from '../../src/index.ts'
import type { Config } from '../../src/index.ts'
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from '../../src/security.ts'

/** One route response as a spec reads it. */
export interface RouteResponse {
  /** HTTP status code. */
  readonly status: number
  /** The `allow` response header, the method list a 405 reports. */
  readonly allow: string | null
  /** Parsed JSON body, or `undefined` when the route sent none. */
  readonly body: unknown
}

/** In-memory curated store standing in for a deployed memory provider. */
export class StubStore implements MemoryStoreFacet {
  private readonly entries = new Map<MemoryTarget, string[]>()

  /** Character budget every snapshot reports. */
  readonly limit: number

  /**
   * @param limit - character budget every snapshot reports.
   */
  constructor(limit = 100) {
    this.limit = limit
  }

  /**
   * Read one target's stored entries.
   * @param target - target to read.
   * @returns that target's snapshot.
   */
  async snapshot(target: MemoryTarget): Promise<MemorySnapshot> {
    const entries = this.entries.get(target) ?? []
    return { target, entries: [...entries], chars: entries.join('\n').length, limit: this.limit }
  }

  /**
   * Apply entry mutations in order; a `no-match` failure leaves the target as it was.
   * @param target - target to mutate.
   * @param operations - mutations to apply.
   * @returns the settled outcome with the resulting or rejected snapshot.
   */
  async write(target: MemoryTarget, operations: readonly MemoryOperation[]): Promise<MemoryWriteResult> {
    const entries = [...(this.entries.get(target) ?? [])]
    for (const operation of operations) {
      if (operation.action === 'add') {
        entries.push(operation.content)
        continue
      }
      const at = entries.findIndex(entry => entry.includes(operation.oldText))
      if (at === -1) {
        return {
          ok: false,
          code: 'no-match',
          message: `no ${target} entry contains ${JSON.stringify(operation.oldText)}`,
          snapshot: await this.snapshot(target),
        }
      }
      if (operation.action === 'replace') entries[at] = operation.content
      else entries.splice(at, 1)
    }
    this.entries.set(target, entries)
    return { ok: true, snapshot: await this.snapshot(target), note: `applied ${operations.length} operations` }
  }
}

/** Options controlling one harness boot. */
export interface HarnessOptions {
  /** Plugin configuration; omitted means every default. */
  readonly config?: Config
  /** Targets the stub provider owns; omitted means both curated targets. */
  readonly targets?: readonly MemoryTarget[]
}

/** One booted composition. */
export interface Harness {
  /** Root context carrying every mounted plugin. */
  readonly ctx: Context
  /** The stub provider's store, for asserting what a write stored. */
  readonly store: StubStore
  /** The webserver's listening port. */
  readonly port: number
  /** This server's origin as the fence sees it. */
  readonly origin: string
  /** The other accepted spelling of this server's origin. */
  readonly localhostOrigin: string
  /** Issue one request, carrying the required marker header unless the spec overrides it. */
  call(path: string, init?: RequestInit): Promise<RouteResponse>
  /** Unmount this package's plugin, leaving the listener up. */
  unmount(): Promise<void>
  /** Unmount the plugin and close the listener. */
  dispose(): Promise<void>
}

/**
 * Boot the shipped composition over a real loopback listener.
 * @param options - configuration and target-ownership overrides.
 * @returns the mounted context, its port and origins, and its teardown.
 */
export async function bootMemoryApi(options: HarnessOptions = {}): Promise<Harness> {
  const ctx = new Context()
  const serverFiber = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(MemoryService)
  const store = new StubStore()
  const targets = options.targets ?? ['memory', 'user']
  ctx.effect(() => ctx.memory.register({ name: 'stub', targets, store }))
  const fiber = await ctx.plugin(memoryApi, options.config ?? {})
  const port = ctx.webServer.port
  return {
    ctx,
    store,
    port,
    origin: `http://127.0.0.1:${port}`,
    localhostOrigin: `http://localhost:${port}`,
    async call(path, init = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: { [REQUEST_HEADER]: REQUEST_HEADER_VALUE, ...init.headers },
      })
      const text = await response.text()
      return {
        status: response.status,
        allow: response.headers.get('allow'),
        body: text === '' ? undefined : JSON.parse(text),
      }
    },
    async unmount() {
      await fiber.dispose()
    },
    async dispose() {
      await fiber.dispose()
      await serverFiber.dispose()
    },
  }
}
