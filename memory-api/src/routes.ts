/**
 * The two HTTP routes `@deepseek-ai/dsh-memory-api` registers on the
 * composition's web server, and the wire validation each one performs.
 *
 * Both routes pass the fence in `./security.ts` before anything else, then
 * state their own method, then touch memory. The read route reports the targets
 * this deployment owns and omits the rest; the write route applies a validated
 * operation list through `ctx.memory`, so a target no provider owns comes back
 * as the service's own `unowned-target` result rather than an HTTP failure.
 * Request bodies are bounded and schema-checked here: this is the browser wire,
 * the one place in the package where untrusted JSON arrives.
 * @module @deepseek-ai/dsh-memory-api/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { MemoryOperation, MemoryService, MemorySnapshot, MemoryTarget } from '@deepseek-ai/dsh-memory'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { requestRejection } from './security.ts'

/** Path of the read route. */
export const MEMORY_STATE_PATH = '/memory/state'

/** Path of the write route. */
export const MEMORY_WRITE_PATH = '/memory/write'

/** Targets the read route reports, in the order they are reported. */
export const MEMORY_TARGETS: readonly MemoryTarget[] = ['memory', 'user']

/**
 * Largest accepted write body. Curated targets hold a few thousand characters,
 * so a well-formed request is orders of magnitude smaller; the ceiling exists
 * so a hostile body is refused before it is buffered.
 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * One operation as it may appear on the wire. Every member is strict: a
 * missing or mistyped field is a refused body, never a coercion.
 */
const operationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), content: z.string() }),
  z.object({ action: z.literal('replace'), oldText: z.string(), content: z.string() }),
  z.object({ action: z.literal('remove'), oldText: z.string() }),
])

/** One write request as it may appear on the wire. Unknown fields are dropped. */
const writeRequestSchema = z.object({
  target: z.enum(['memory', 'user']),
  operations: z.array(operationSchema),
})

/** One validated write request, ready for the memory service. */
interface WriteRequest {
  /** Target the operations apply to. */
  readonly target: MemoryTarget
  /** Entry mutations, in the order the caller sent them. */
  readonly operations: readonly MemoryOperation[]
}

/** JSON response; `no-store` because every response is a live fact. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405 with the route's one supported method. */
function sendMethodNotAllowed(res: ServerResponse, allow: 'GET' | 'POST'): void {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/**
 * Collect a bounded request body as UTF-8 text.
 * @param req - the incoming request whose body to read.
 * @returns the body text, or `null` past {@link MAX_BODY_BYTES} (stream drained).
 */
async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  // An http server streams without setEncoding always yields Buffer chunks.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      // Drain the remainder so the refusal is a readable response, not a cut socket.
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Validate one write body at the wire.
 * @param text - the request body, verbatim.
 * @returns the request to apply, or `null` when the body is malformed.
 */
function parseWriteRequest(text: string): WriteRequest | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Swallows the parse failure: a body that is not JSON is exactly the
    // malformed case this function reports as null.
    return null
  }
  const parsed = writeRequestSchema.safeParse(body)
  if (!parsed.success) return null
  return { target: parsed.data.target, operations: parsed.data.operations }
}

/**
 * Build the read route: every target this deployment owns, one snapshot each.
 * @param memory - the memory capability the route reads through.
 * @param port - reads the webserver's listening port for the origin fence.
 * @returns the route to register.
 */
export function createStateRoute(memory: MemoryService, port: () => number): WebRoute {
  return {
    kind: 'exact',
    path: MEMORY_STATE_PATH,
    handler: async (req, res) => {
      const rejection = requestRejection(req, port())
      if (rejection !== undefined) {
        sendJson(res, 403, { error: rejection })
        return
      }
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      const targets: MemorySnapshot[] = []
      for (const target of MEMORY_TARGETS) {
        try {
          targets.push(await memory.snapshot(target))
        } catch {
          // Swallows every read failure: a target no provider owns has no
          // state to report, so this deployment omits it from the listing.
        }
      }
      sendJson(res, 200, { targets })
    },
  }
}

/**
 * Build the write route: apply one target's operation list.
 * @param memory - the memory capability the route writes through.
 * @param port - reads the webserver's listening port for the origin fence.
 * @returns the route to register.
 */
export function createWriteRoute(memory: MemoryService, port: () => number): WebRoute {
  return {
    kind: 'exact',
    path: MEMORY_WRITE_PATH,
    handler: async (req, res) => {
      const rejection = requestRejection(req, port())
      if (rejection !== undefined) {
        sendJson(res, 403, { error: rejection })
        return
      }
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const text = await readBoundedBody(req)
      if (text === null) {
        sendJson(res, 400, { error: 'request body is too large' })
        return
      }
      const request = parseWriteRequest(text)
      if (request === null) {
        sendJson(res, 400, { error: 'request body must be { target, operations }' })
        return
      }
      sendJson(res, 200, await memory.write(request.target, request.operations))
    },
  }
}
