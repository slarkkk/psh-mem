// ../dsh-mem/memory-api/src/index.ts
import z2 from "@deepseek-ai/schemastery";

// ../dsh-mem/memory-api/src/routes.ts
import { z } from "zod";

// ../dsh-mem/memory-api/src/security.ts
var REQUEST_HEADER = "x-dsh-memory";
var REQUEST_HEADER_VALUE = "1";
function ownOrigins(port) {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}
function isOwnOrigin(origin, port) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return ownOrigins(port).some((candidate) => new URL(candidate).href === parsed.href);
}
function requestRejection(req, port) {
  if (req.headers[REQUEST_HEADER] !== REQUEST_HEADER_VALUE) {
    return `${REQUEST_HEADER}: ${REQUEST_HEADER_VALUE} header is required`;
  }
  const origin = req.headers.origin;
  if (origin === void 0) {
    return req.method === "GET" ? void 0 : "Origin header is required for this request";
  }
  if (!isOwnOrigin(origin, port)) return `Origin ${JSON.stringify(origin)} is not this server`;
  return void 0;
}

// ../dsh-mem/memory-api/src/routes.ts
var MEMORY_STATE_PATH = "/memory/state";
var MEMORY_WRITE_PATH = "/memory/write";
var MEMORY_TARGETS = ["memory", "user"];
var MAX_BODY_BYTES = 64 * 1024;
var operationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), content: z.string() }),
  z.object({ action: z.literal("replace"), oldText: z.string(), content: z.string() }),
  z.object({ action: z.literal("remove"), oldText: z.string() })
]);
var writeRequestSchema = z.object({
  target: z.enum(["memory", "user"]),
  operations: z.array(operationSchema)
});
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader("allow", allow);
  res.end();
}
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}
function parseWriteRequest(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = writeRequestSchema.safeParse(body);
  if (!parsed.success) return null;
  return { target: parsed.data.target, operations: parsed.data.operations };
}
function createStateRoute(memory, port) {
  return {
    kind: "exact",
    path: MEMORY_STATE_PATH,
    handler: async (req, res) => {
      const rejection = requestRejection(req, port());
      if (rejection !== void 0) {
        sendJson(res, 403, { error: rejection });
        return;
      }
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      const targets = [];
      for (const target of MEMORY_TARGETS) {
        try {
          targets.push(await memory.snapshot(target));
        } catch {
        }
      }
      sendJson(res, 200, { targets });
    }
  };
}
function createWriteRoute(memory, port) {
  return {
    kind: "exact",
    path: MEMORY_WRITE_PATH,
    handler: async (req, res) => {
      const rejection = requestRejection(req, port());
      if (rejection !== void 0) {
        sendJson(res, 403, { error: rejection });
        return;
      }
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }
      const text = await readBoundedBody(req);
      if (text === null) {
        sendJson(res, 400, { error: "request body is too large" });
        return;
      }
      const request = parseWriteRequest(text);
      if (request === null) {
        sendJson(res, 400, { error: "request body must be { target, operations }" });
        return;
      }
      sendJson(res, 200, await memory.write(request.target, request.operations));
    }
  };
}

// ../dsh-mem/memory-api/src/index.ts
var name = "memory-api";
var inject = ["webServer", "memory"];
var Config = z2.object({
  enabled: z2.boolean().default(true)
});
function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  const port = () => {
    const listening = ctx.webServer.port;
    if (listening === void 0) throw new Error("memory-api: the web server has not bound a port");
    return listening;
  };
  ctx.effect(
    () => ctx.webServer.register(createStateRoute(ctx.memory, port)),
    `memory-api: GET ${MEMORY_STATE_PATH}`
  );
  ctx.effect(
    () => ctx.webServer.register(createWriteRoute(ctx.memory, port)),
    `memory-api: POST ${MEMORY_WRITE_PATH}`
  );
}
export {
  Config,
  MEMORY_STATE_PATH,
  MEMORY_TARGETS,
  MEMORY_WRITE_PATH,
  REQUEST_HEADER,
  REQUEST_HEADER_VALUE,
  apply,
  createStateRoute,
  createWriteRoute,
  inject,
  name
};
