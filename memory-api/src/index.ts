/**
 * `@deepseek-ai/dsh-memory-api`: the browser-facing HTTP face of the memory
 * capability. Two exact routes on the composition's web server let a page read
 * every target this deployment owns and apply write operations to one of them,
 * so memory can be reviewed and edited outside a model turn.
 *
 * The package owns the transport and the request policy only: it stores
 * nothing, decides no budget, and returns the memory service's own snapshot and
 * write results unchanged. Every route is registered as an effect on this
 * plugin's fiber, so unloading removes both routes with the rest of the fiber.
 *
 * Both routes are fenced (see `./security.ts`): the `x-dsh-memory: 1` header is
 * required on every request and a present `Origin` must be this server's. The
 * README states the residual risk that remains for other processes on the same
 * machine.
 * @module @deepseek-ai/dsh-memory-api
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-memory'
import { MEMORY_STATE_PATH, MEMORY_WRITE_PATH, createStateRoute, createWriteRoute } from './routes.ts'

export { MEMORY_STATE_PATH, MEMORY_TARGETS, MEMORY_WRITE_PATH, createStateRoute, createWriteRoute } from './routes.ts'
export { REQUEST_HEADER, REQUEST_HEADER_VALUE } from './security.ts'

/** Cordis function-plugin name. */
export const name = 'memory-api'

/** Services this plugin needs: the route carrier and the memory capability. */
export const inject = ['webServer', 'memory']

/** Memory-API configuration. */
export interface Config {
  /**
   * Whether this plugin registers its routes. Default `true`; a deployment that
   * mounts the package for the rest of its composition can turn the HTTP face
   * off without removing the entry.
   */
  enabled?: boolean
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
})

/**
 * Register the memory routes on the composition's web server.
 * @param ctx - plugin context carrying `webServer` and `memory`.
 * @param config - plugin configuration; a loader-supplied one already carries every default.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return
  // Read per request: the route outlives any single bind, and the fence
  // compares against whatever port this server is listening on. The getter is
  // `number | undefined` because it is unbound before `listen`; a request can
  // only arrive after the listener bound, so an undefined port here is a
  // server-side defect rather than a reachable state.
  const port = (): number => {
    const listening = ctx.webServer.port
    if (listening === undefined) throw new Error('memory-api: the web server has not bound a port')
    return listening
  }
  ctx.effect(
    () => ctx.webServer.register(createStateRoute(ctx.memory, port)),
    `memory-api: GET ${MEMORY_STATE_PATH}`,
  )
  ctx.effect(
    () => ctx.webServer.register(createWriteRoute(ctx.memory, port)),
    `memory-api: POST ${MEMORY_WRITE_PATH}`,
  )
}
