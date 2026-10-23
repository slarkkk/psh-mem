/**
 * dsh-lessons —— 失败教训库（DSH profile 级插件）
 *
 * 记忆插件记「事实」，这里记「负经验」：一次非显然的失败、根因、真正有效的做法。
 * 相同信号再次出现时自动提醒，避免新会话重踩同一个坑。
 *
 *   record   记一条（title + fix 必填；symptom/cause/tags/paths/tools 可选）
 *   recall   按当前上下文或关键词找相关教训
 *   list     列出（可按标签/过期过滤）
 *   confirm  「这条仍然成立」：刷新确认时间，过期条目重新参与自动提醒
 *   forget   删除；archive 归档（保留记录但不再提醒）
 *   stats    数量、命中、高频标签、过期条目
 *
 * 自动提醒是稀有事件：只在回合开头或刚发生工具失败时评估；分数阈值 + 每轮上限 +
 * 冷却时间 + 过期排除共同保证「宁可漏提醒，也不要在每一步念旧账」。
 *
 * @module dsh-lessons
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  archiveLesson,
  confirmLesson,
  daysSince,
  emptyStore,
  forgetLesson,
  isStale,
  mergeLessons,
  normalizeStore,
  rankLessons,
  renderLesson,
  renderList,
  renderReminder,
  renderStats,
  upsertLesson,
  validateConfig,
  type Config,
  type Lesson,
  type Store,
} from './engine.ts'

/** 与 dsh-tools 的 JsonValue 同构；该包未从入口导出它。 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 插件名。 */
export const name = 'dsh-lessons'

/** 本插件使用的消息来源；在 dsh-llm 的来源映射上声明，session 格式才认。 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-lessons': { kind: 'plugin:dsh-lessons' }
  }
}

/** 依赖的服务。 */
export const inject = ['tools', 'agents']

/** 一个 agent 最近的活动与提醒状态。 */
interface Activity {
  turnText: string
  paths: string[]
  tools: string[]
  failure: boolean
  injected: Set<string>
  cooldown: Map<string, number>
}

/** 工作区与全局两个存储的读取缓存。 */
interface StoreCache {
  workspace: Store
  global: Store
  at: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 挂载插件。
 * @param ctx Cordis 上下文。
 * @param config 来自 cordis.patch.yml 的 `config:`。
 */
export function apply(ctx: Context, config: unknown = {}): void {
  const resolved = validateConfig(config)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const caches = new Map<string, StoreCache>()
  const activity = new Map<Agent, Activity>()

  const rootOf = (agent: Agent | undefined): string => {
    const cwd = agent?.session.header.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  }

  const workspacePath = (root: string): string => join(root, '.dsh', 'lessons.json')
  const globalPath = (): string => join(home, 'storages', 'lessons.json')

  const readStore = async (path: string): Promise<Store> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      const { store, problems } = normalizeStore(parsed)
      if (problems.length > 0) ctx.logger.warn(`dsh-lessons: ${path} 有 ${problems.length} 条坏数据：${problems[0]}`)
      return store
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined
      if (code !== 'ENOENT') ctx.logger.warn(`dsh-lessons: 读取 ${path} 失败：${String(error)}`)
      return emptyStore()
    }
  }

  const writeStore = async (path: string, store: Store): Promise<void> => {
    const temporary = `${path}.tmp`
    try {
      await mkdir(join(path, '..'), { recursive: true })
      const body = `${JSON.stringify(store, null, 2)}\n`
      await writeFile(temporary, body, 'utf8')
      try {
        await rename(temporary, path)
      } catch {
        // Windows 上目标被占用时 rename 会失败，退回直接覆盖。
        await writeFile(path, body, 'utf8')
      }
    } catch (error) {
      ctx.logger.warn(`dsh-lessons: 写入 ${path} 失败：${String(error)}`)
    }
  }

  /** 读工作区与全局两个存储；2 秒内复用，避免每步都读盘。 */
  const loadStores = async (root: string): Promise<StoreCache> => {
    const cached = caches.get(root)
    if (cached !== undefined && Date.now() - cached.at < 2000) return cached
    const [workspace, global] = await Promise.all([readStore(workspacePath(root)), readStore(globalPath())])
    const next: StoreCache = { workspace, global, at: Date.now() }
    caches.set(root, next)
    return next
  }

  const invalidate = (root: string): void => { caches.delete(root) }

  const currentActivity = (agent: Agent | undefined): Activity => {
    if (agent === undefined) {
      return { turnText: '', paths: [], tools: [], failure: false, injected: new Set(), cooldown: new Map() }
    }
    let entry = activity.get(agent)
    if (entry === undefined) {
      entry = { turnText: '', paths: [], tools: [], failure: false, injected: new Set(), cooldown: new Map() }
      activity.set(agent, entry)
    }
    return entry
  }

  const recordToolActivity = (agent: Agent | undefined, exec: ToolExecution, isError: boolean): void => {
    if (agent === undefined) return
    const entry = currentActivity(agent)
    entry.tools.push(exec.name)
    if (entry.tools.length > resolved.recentTools) entry.tools.shift()
    const args = exec.arguments
    if (isRecord(args)) {
      for (const key of ['file_path', 'path', 'command', 'pattern', 'query'] as const) {
        const value = args[key]
        if (typeof value !== 'string' || value.length === 0) continue
        if (key === 'file_path' || key === 'path') {
          entry.paths.push(value)
          if (entry.paths.length > resolved.recentTools) entry.paths.shift()
        } else {
          entry.turnText = `${entry.turnText}\n${value.slice(0, 400)}`.trim()
        }
      }
    }
    if (isError) entry.failure = true
  }

  const textOfMessages = (messages: readonly { content: readonly { type: string; text?: string }[] }[]): string => {
    const parts: string[] = []
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
    }
    return parts.join('\n').trim()
  }

  const allLessons = async (root: string): Promise<Lesson[]> => {
    const { workspace, global } = await loadStores(root)
    return mergeLessons(workspace, global)
  }

  const textOutput = {
    schema: { type: 'object', additionalProperties: true } as const,
    render: (_args: unknown, value: unknown) => [{
      type: 'text' as const,
      text: isRecord(value) && typeof value.text === 'string' ? value.text : JSON.stringify(value ?? null, null, 2),
    }],
  }

  ctx.tools.register(defineTool({
    name: 'lesson',
    description: '失败教训库：记录并复用「一次非显然的失败 + 根因 + 正确做法」，避免同类问题重踩。'
      + '一次失败被修复后（尤其是花了多轮才定位、或修错了方向再改回来），用 action=record 记一条。'
      + '相同关键词、文件或工具再次出现时，系统会自动提醒相关教训；也可以用 action=recall 主动查。',
    parameters: {
      action: {
        type: 'string',
        description: 'record（记录）| recall（查相关）| list（列出）| confirm（仍然成立）| forget（删除）| archive（归档）| stats（统计）',
      },
      title: { type: 'string', description: 'record 必填：一句话说清是什么坑（≤160 字）' },
      fix: { type: 'string', description: 'record 必填：真正有效的做法' },
      symptom: { type: 'string', description: 'record 可选：当时的现象（报错原文、异常表现）' },
      cause: { type: 'string', description: 'record 可选：根因' },
      tags: { type: 'string', description: 'record 可选：触发标签，逗号分隔（如 pnpm,构建,缓存）' },
      paths: { type: 'string', description: 'record 可选：触发路径 glob，逗号分隔（如 packages/**,*.json）' },
      tools: { type: 'string', description: 'record 可选：触发工具，逗号分隔（如 bash,pwsh）；只作辅助信号' },
      scope: { type: 'string', description: 'record 可选：workspace（默认，随工作区走）| global（跨项目）' },
      id: { type: 'string', description: 'confirm / forget / archive 必填：教训编号 [#xxxxxxxx]' },
      query: { type: 'string', description: 'recall 可选：关键词；不填则用当前会话最近的请求与工具活动' },
      tag: { type: 'string', description: 'list 可选：按标签过滤' },
      limit: { type: 'number', description: '最多返回条数（默认 20）' },
    },
    output: textOutput,
    async execute(args, exec): Promise<Record<string, Json>> {
      const root = rootOf(exec.agent)
      const action = String(args.action ?? 'list').trim().toLowerCase()
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.trunc(Number(args.limit)) : 20

      if (action === 'record') {
        const scope: Lesson['scope'] = args.scope === 'global' ? 'global' : 'workspace'
        const stores = await loadStores(root)
        const target = scope === 'global' ? stores.global : stores.workspace
        const result = upsertLesson(target, {
          title: args.title,
          symptom: args.symptom,
          cause: args.cause,
          fix: args.fix,
          tags: args.tags,
          paths: args.paths,
          tools: args.tools,
          scope,
        })
        await writeStore(scope === 'global' ? globalPath() : workspacePath(root), result.store)
        invalidate(root)
        const where = scope === 'global' ? `全局（${globalPath()}）` : `工作区（${workspacePath(root)}）`
        return {
          text: `${result.created ? '已记录' : '已合并（同一条教训）'} [#${result.lesson.id}] ${result.lesson.title}\n`
            + `做法：${result.lesson.fix}\n存放：${where}`,
          id: result.lesson.id,
          created: result.created,
        }
      }

      if (action === 'recall') {
        const entry = currentActivity(exec.agent)
        const context = {
          text: typeof args.query === 'string' && args.query.trim() !== '' ? args.query : entry.turnText,
          paths: entry.paths,
          tools: entry.tools,
        }
        const matches = rankLessons(await allLessons(root), context, resolved, { limit: Math.max(limit, 1) })
        if (matches.length === 0) {
          return { text: '没有匹配的教训。要么确实是新问题，要么触发标签/路径还没覆盖到——用到时可以用 action=record 补一条。' }
        }
        return {
          text: matches.map(({ lesson, score }) => `${renderLesson(lesson, resolved)}\n匹配分：${score}`).join('\n\n'),
          ids: matches.map(({ lesson }) => lesson.id),
        }
      }

      if (action === 'list') {
        return { text: renderList(await allLessons(root), resolved, { limit, tag: typeof args.tag === 'string' ? args.tag : undefined }) }
      }

      if (action === 'stats') {
        return { text: renderStats(await allLessons(root), resolved) }
      }

      if (action === 'confirm' || action === 'forget' || action === 'archive') {
        const id = typeof args.id === 'string' ? args.id.trim().replace(/^\[#?|\]$/g, '') : ''
        if (id === '') throw new Error(`${action} 需要 id（[#xxxxxxxx]）`)
        const stores = await loadStores(root)
        const targets: [string, Store, string][] = [
          ['workspace', stores.workspace, workspacePath(root)],
          ['global', stores.global, globalPath()],
        ]
        for (const [label, store, path] of targets) {
          if (!store.lessons.some(lesson => lesson.id === id)) continue
          if (action === 'confirm') {
            await writeStore(path, confirmLesson(store, id).store)
            invalidate(root)
            return { text: `已确认 [#${id}] 仍然成立（${label}）。` }
          }
          if (action === 'archive') {
            await writeStore(path, archiveLesson(store, id))
            invalidate(root)
            return { text: `已归档 [#${id}]（${label}）：保留记录，不再自动提醒。` }
          }
          const result = forgetLesson(store, id)
          await writeStore(path, result.store)
          invalidate(root)
          return { text: `已删除 [#${id}]：${result.found?.title ?? ''}` }
        }
        throw new Error(`没有找到 [#${id}]；先 action=list 确认编号`)
      }

      throw new Error(`未知 action：${action}（可用：record | recall | list | confirm | forget | archive | stats）`)
    },
  }))

  // ---------------------------------------------------------------- 自动提醒

  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    try {
      recordToolActivity(exec.agent, exec, result.isError === true)
    } catch (error) {
      ctx.logger.warn(`dsh-lessons: 记录工具活动失败：${String(error)}`)
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      const entry = currentActivity(agent)
      if (step === 1) {
        entry.turnText = textOfMessages(messages)
        entry.injected.clear()
        entry.paths.length = 0
        entry.tools.length = 0
        entry.failure = false
      } else if (messages.length > 0) {
        entry.turnText = `${entry.turnText}\n${textOfMessages(messages)}`.trim()
      }

      // 只在两个时机评估：回合开头，或刚发生过工具失败。
      if (step !== 1 && !entry.failure) return decision

      const root = rootOf(agent)
      const matches = rankLessons(await allLessons(root), {
        text: entry.turnText,
        paths: entry.paths,
        tools: entry.tools,
      }, resolved, { limit: resolved.maxPerTurn, exclude: entry.injected })
      if (matches.length === 0) return decision

      const now = Date.now()
      const fresh = matches.filter(match => now - (entry.cooldown.get(match.lesson.id) ?? 0) > resolved.cooldownMs)
      if (fresh.length === 0) return decision
      for (const match of fresh) {
        entry.injected.add(match.lesson.id)
        entry.cooldown.set(match.lesson.id, now)
      }
      entry.failure = false
      signal.throwIfAborted()
      return {
        ...decision,
        messages: [...decision.messages, createUserMessage({
          content: [{ type: 'text', text: renderReminder(fresh) }],
          source: { kind: 'plugin:dsh-lessons' },
        })],
      }
    } catch (error) {
      // 钩子绝不能拖垮 agent 循环
      ctx.logger.warn(`dsh-lessons: 提醒评估失败：${String(error)}`)
      return decision
    }
  })

  // --------------------------------------------------------- 浏览器端点（tab）

  /** 浏览器请求必须带的头：跨源页面发不出自定义头，也就到不了这里。 */
  const LESSONS_HEADER = 'x-dsh-lessons'
  const MAX_BODY_BYTES = 64 * 1024

  /** 本进程里已打开的会话工作区，外加进程 cwd；路由只在这些目录里选。 */
  const agentRoots = (): string[] => {
    const roots = new Set<string>()
    for (const agent of ctx.agents.list()) roots.add(rootOf(agent))
    roots.add(process.cwd())
    return [...roots]
  }

  const pickRoot = (requested: string | null): string | undefined => {
    const roots = agentRoots()
    if (requested === null || requested === '') return roots[0]
    return roots.includes(requested) ? requested : undefined
  }

  const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  const readBoundedBody = async (req: IncomingMessage): Promise<string | null> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      size += buffer.byteLength
      if (size > MAX_BODY_BYTES) {
        req.resume()
        return null
      }
      chunks.push(buffer)
    }
    return Buffer.concat(chunks, size).toString('utf8')
  }

  const fence = (req: IncomingMessage, port: number): string | undefined => {
    if (req.headers[LESSONS_HEADER] !== '1') return `${LESSONS_HEADER}: 1 header is required`
    const origin = req.headers.origin
    if (origin === undefined) return req.method === 'GET' ? undefined : 'Origin header is required for this request'
    try {
      const parsed = new URL(origin)
      const own = [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
      if (own.some(candidate => new URL(candidate).href === parsed.href)) return undefined
    } catch {
      // 无法解析的 Origin 一律当作外部来源拒绝。
    }
    return `Origin ${JSON.stringify(origin)} is not this server`
  }

  ctx.inject(['webServer'], webCtx => {
    const port = (): number => {
      const listening = webCtx.webServer.port
      if (listening === undefined) throw new Error('lessons: web server has not bound a port')
      return listening
    }

    const stateHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const rejection = fence(req, port())
      if (rejection !== undefined) return sendJson(res, 403, { error: rejection })
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const root = pickRoot(url.searchParams.get('workspace'))
      if (root === undefined) return sendJson(res, 403, { error: '请求的工作区不在本进程已打开的会话里' })
      try {
        const lessons = await allLessons(root)
        const now = Date.now()
        return sendJson(res, 200, {
          workspace: root,
          workspaces: agentRoots(),
          counts: {
            total: lessons.filter(lesson => lesson.archived !== true).length,
            stale: lessons.filter(lesson => lesson.archived !== true && isStale(lesson, resolved, now)).length,
            hits: lessons.reduce((sum, lesson) => sum + lesson.hits, 0),
          },
          lessons: lessons.map(lesson => ({
            ...lesson,
            stale: isStale(lesson, resolved, now),
            ageDays: daysSince(lesson.confirmedAt, now),
          })),
        })
      } catch (error) {
        return sendJson(res, 500, { error: `读取教训库失败：${String(error)}` })
      }
    }

    const mutate = async (
      req: IncomingMessage,
      res: ServerResponse,
      applyMutation: (root: string, body: Record<string, unknown>) => Promise<unknown>,
    ): Promise<void> => {
      const rejection = fence(req, port())
      if (rejection !== undefined) return sendJson(res, 403, { error: rejection })
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      const text = await readBoundedBody(req)
      if (text === null) return sendJson(res, 413, { error: '请求体过大' })
      let body
      try {
        body = JSON.parse(text)
      } catch {
        return sendJson(res, 400, { error: '请求体必须是 JSON' })
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { error: '请求体必须是对象' })
      }
      const record = body as Record<string, unknown>
      const root = pickRoot(typeof record.workspace === 'string' ? record.workspace : null)
      if (root === undefined) return sendJson(res, 403, { error: '请求的工作区不在本进程已打开的会话里' })
      try {
        return sendJson(res, 200, await applyMutation(root, record))
      } catch (error) {
        return sendJson(res, 400, { error: String(error instanceof Error ? error.message : error) })
      }
    }

    const confirmHandler = (req: IncomingMessage, res: ServerResponse): Promise<void> => mutate(req, res, async (root, body) => {
      const id = typeof body.id === 'string' ? body.id.trim().replace(/^\[#?|\]$/g, '') : ''
      if (id === '') throw new Error('缺少 id')
      const stores = await loadStores(root)
      for (const [label, store, path] of [
        ['workspace', stores.workspace, workspacePath(root)],
        ['global', stores.global, globalPath()],
      ] as const) {
        if (!store.lessons.some(lesson => lesson.id === id)) continue
        await writeStore(path, confirmLesson(store, id).store)
        invalidate(root)
        return { ok: true, id, scope: label }
      }
      throw new Error(`没有找到 [#${id}]`)
    })

    const forgetHandler = (req: IncomingMessage, res: ServerResponse): Promise<void> => mutate(req, res, async (root, body) => {
      const id = typeof body.id === 'string' ? body.id.trim().replace(/^\[#?|\]$/g, '') : ''
      if (id === '') throw new Error('缺少 id')
      const stores = await loadStores(root)
      for (const [label, store, path] of [
        ['workspace', stores.workspace, workspacePath(root)],
        ['global', stores.global, globalPath()],
      ] as const) {
        if (!store.lessons.some(lesson => lesson.id === id)) continue
        await writeStore(path, forgetLesson(store, id).store)
        invalidate(root)
        return { ok: true, id, scope: label }
      }
      throw new Error(`没有找到 [#${id}]`)
    })

    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: '/lessons/state', handler: stateHandler }),
      'lessons: GET /lessons/state',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: '/lessons/confirm', handler: confirmHandler }),
      'lessons: POST /lessons/confirm',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: '/lessons/forget', handler: forgetHandler }),
      'lessons: POST /lessons/forget',
    )
  })

  ctx.on('agent/disposed', ({ agent }) => {
    activity.delete(agent)
  })

  ctx.effect(() => () => {
    caches.clear()
    activity.clear()
  }, 'dsh-lessons.caches')
}
