# @deepseek-ai/dsh-memory-api

English

## Summary

The browser-facing HTTP face of the memory capability. Two exact routes on the composition's web server let a page read every curated target this deployment owns and apply write operations to one of them, so memory can be reviewed and edited outside a model turn.

The package owns transport and request policy only. It stores nothing, decides no budget, and returns the memory service's own snapshot and write results unchanged, so a client sees exactly what `ctx.memory` reported. Every registration is an effect on this plugin's fiber: unloading removes both routes.

## Route contract

Both routes are JSON. A successful response is `application/json; charset=utf-8` with `cache-control: no-store`.

### `GET /memory/state`

```json
{
  "targets": [
    { "target": "memory", "entries": ["..."], "chars": 120, "limit": 2200 },
    { "target": "user", "entries": [], "chars": 0, "limit": 1375 }
  ]
}
```

One row per target this deployment owns, in the order `memory`, then `user`. A target whose `ctx.memory.snapshot(target)` throws contributes no row — a deployment that registers no provider for a target omits that target instead of failing the read.

### `POST /memory/write`

Body: `{ "target": "memory" | "user", "operations": MemoryOperation[] }`, where an operation is one of `{ "action": "add", "content": string }`, `{ "action": "replace", "oldText": string, "content": string }`, or `{ "action": "remove", "oldText": string }`.

The response is the `MemoryWriteResult` the memory service settled, unchanged:

```json
{ "ok": true, "snapshot": { "target": "memory", "entries": ["..."], "chars": 5, "limit": 2200 }, "note": "..." }
```

```json
{ "ok": false, "code": "no-match", "message": "...", "snapshot": { "...": "..." } }
```

A rejected write is a `200` with `ok: false`, because the service settles it as a value the caller can act on. A target no provider owns comes back the same way with `code: "unowned-target"`.

### Failure responses

| Status | When | Body |
|---|---|---|
| `400` | The body is not JSON, is not an object, names a `target` other than `memory`/`user`, carries a non-array `operations`, or carries an operation with an unknown `action` or a mistyped field. Also when the body exceeds 64 KiB. | `{ "error": string }` |
| `403` | The request fails the fence (below). | `{ "error": string }` |
| `405` | Wrong method for the route. | empty, with `allow: GET` or `allow: POST` |

Validation is strict at the wire: unknown operation fields are dropped, and a missing or mistyped field is refused rather than coerced. The body ceiling is a fixed protocol constant — a curated target holds a few thousand characters, so a well-formed request is orders of magnitude smaller.

A memory provider that throws while applying a write propagates out of the handler; the web server answers `400` and logs a warning, its documented behavior for a failing handler. The read route never propagates: a target whose snapshot throws is omitted, as described above.

## Security

The web server "carries no TLS, authentication, or origin policy of its own"; every route owner states its own. This package implements two checks on every request, in this order.

1. **Marker header.** `x-dsh-memory: 1` is required, with exactly that value. A page on another origin cannot send a custom header without a successful CORS preflight, and these routes never answer a preflight (no `OPTIONS` handling, no `access-control-*` response headers), so a foreign page cannot reach them at all. An HTML form cannot set the header either, which is why the media type is not additionally checked.
2. **Origin check.** When the request carries an `Origin`, it must be this server's: `http://127.0.0.1:<ctx.webServer.port>` or `http://localhost:<port>`, compared through WHATWG URL parsing so a default port is spelled either way and the opaque `null` origin is refused.

**A missing `Origin` is accepted only for a `GET`.** Browsers omit `Origin` on a same-origin GET — the shape of the read route's own page calling it — and attach one to every request whose method is not GET or HEAD. A write that arrives without an `Origin` therefore came from something other than our page and is refused with `403`. Every accepted-origin case is otherwise identical for both routes.

### Residual risk

**Any local process can still call these routes.** A program on the same machine can send the marker header and a same-origin `Origin` header, and the check has no way to tell it from the page. That is inherent to a loopback HTTP server with no authentication, and it is out of scope here for the same reason it is out of scope for the rest of the loopback GUI: the browser page itself is unauthenticated to anyone who can already run code as this user, and such a process could read and rewrite the memory files directly. Adding a scheme to this one route would not change what an attacker with local code execution can do.

The routes add no protection against a deployment that binds `0.0.0.0`: the fence compares the `Origin` header, not the reachable address, so a remote client that sends the marker header reaches memory exactly as a local one does. Keep the Web server on loopback unless the whole deployment is meant to be exposed.

## Configuration

```yaml
- insert:
    - id: memory-api
      name: 'G:/work/dsh-mem/memory-api/src/index.ts'
      config:
        enabled: true
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether the plugin registers its routes. Set `false` to mount the package with the HTTP face off. |

The package injects `webServer` and `memory`; both must be present in the composition.

## Mounting

This tree lives outside the harness checkout, so an entry names the source file directly:

```sh
dsh web --patch "G:/work/dsh-mem/examples/memory-api.cordis.yml" --no-open --port 0
```

The profile (or `examples/curated.cordis.yml`) must already mount the memory capability and a provider; this overlay adds only the routes, because a profile that already owns the `memory` entry id rejects a second one.

```sh
curl -H "x-dsh-memory: 1" http://127.0.0.1:<port>/memory/state
curl -X POST -H "x-dsh-memory: 1" -H "Origin: http://127.0.0.1:<port>" \
  -H "content-type: application/json" \
  --data-binary '{"target":"memory","operations":[{"action":"add","content":"..."}]}' \
  http://127.0.0.1:<port>/memory/write
```

## Verification

```sh
cd G:/work/tool
pnpm exec vitest run --config G:/work/dsh-mem/memory-api/vitest.config.mjs
pnpm exec tsc --noEmit -p G:/work/dsh-mem/memory-api/tsconfig.json
```

The checkout's own vitest config cannot collect these specs: its `include` patterns are relative to the checkout, so a path filter outside it matches no file. `vitest.config.mjs` in this package points vitest at the package instead and derives its `@deepseek-ai/*` aliases from `../tsconfig.json` — the same map the running plugin resolves through — so a spec loads the exact module instances the host loads.

## Known Limitations and Deferred Work

- **No browser page ships here.** The package serves the routes a memory editor would call; the editor itself is a separate client plugin.
- **No route answers `OPTIONS`.** A preflight gets the same `403` as any other unfenced request, which is deliberate: answering one would let a foreign page send the marker header.
- **README.i18n.yaml / README.zh.md are absent**, unlike the sibling packages, whose bilingual pair was copied from the checkout. This tree is not a documentation source and `dsh-translate-docs` owns bilingual work.
