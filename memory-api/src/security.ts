/**
 * Request fence for the memory routes. The webserver carries no origin policy
 * of its own, so every route owner states one; this module is that statement
 * for `@deepseek-ai/dsh-memory-api`.
 *
 * Two independent checks guard each request. The required custom header is the
 * load-bearing one: a page on another origin cannot send a custom header
 * without a successful CORS preflight, and these routes never answer a
 * preflight, so a foreign page cannot reach them at all. The Origin comparison
 * covers the requests a browser does mark — a cross-site `fetch` always
 * carries the attacker's Origin, which is not this server's.
 *
 * A missing `Origin` is the shape a browser produces for its own same-origin
 * GET, and only that shape is accepted without one: every browser attaches
 * `Origin` to a request whose method is not GET or HEAD, so a write that
 * arrives without it came from something other than our page.
 * @module @deepseek-ai/dsh-memory-api/security
 */

import type { IncomingMessage } from 'node:http'

/**
 * Request header every memory-API request must carry. Browsers cannot set a
 * custom header cross-origin without a preflight, and the routes answer none.
 */
export const REQUEST_HEADER = 'x-dsh-memory'

/** The one accepted value of {@link REQUEST_HEADER}. */
export const REQUEST_HEADER_VALUE = '1'

/**
 * The origins this server answers for, spelled the two loopback ways a browser
 * reaches it. Read per call because the port is the listening port, not a
 * configured constant.
 * @param port - the webserver's listening port.
 * @returns the accepted `Origin` header values.
 */
function ownOrigins(port: number): readonly string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
}

/**
 * Whether an `Origin` header names this server. Comparison runs through WHATWG
 * URL parsing, so the spelling of a default port never decides the answer and
 * an unparsable value (including the literal `null` an opaque origin sends) is
 * refused.
 * @param origin - the `Origin` header value, verbatim.
 * @param port - the webserver's listening port.
 * @returns true when the origin is this server's.
 */
function isOwnOrigin(origin: string, port: number): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    // Swallows the parse failure: an Origin the URL parser rejects is not this
    // server's origin, which is the only question asked here.
    return false
  }
  return ownOrigins(port).some(candidate => new URL(candidate).href === parsed.href)
}

/**
 * Decide whether one request may reach the memory routes.
 * @param req - the incoming request; method and headers are what this fence reads.
 * @param port - the webserver's listening port.
 * @returns the rejection reason to answer with, or `undefined` when the request passes.
 */
export function requestRejection(req: IncomingMessage, port: number): string | undefined {
  if (req.headers[REQUEST_HEADER] !== REQUEST_HEADER_VALUE) {
    return `${REQUEST_HEADER}: ${REQUEST_HEADER_VALUE} header is required`
  }
  const origin = req.headers.origin
  if (origin === undefined) {
    return req.method === 'GET' ? undefined : 'Origin header is required for this request'
  }
  if (!isOwnOrigin(origin, port)) return `Origin ${JSON.stringify(origin)} is not this server`
  return undefined
}
