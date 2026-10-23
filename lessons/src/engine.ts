/**
 * lessons —— 失败教训库引擎
 *
 * 记忆插件存的是「事实」（你是谁、环境怎么配）；这里存的是「负经验」：一次非显然的
 * 失败、它的根因、以及真正有效的做法。目的是让同类问题在新会话里不再重踩。
 *
 * 本模块是纯引擎：不 import DSH 包，存储是普通 JSON，因此可以在 DSH 里跑、
 * 用 CLI 跑、被单元测试直接跑，结论完全一致。
 *
 * 设计约束：
 * - 教训的 id 由 title + fix 归一化后派生：同一条教训重复记录不会产生副本。
 * - 自动提醒是**稀有事件**：分数阈值 + 每轮上限 + 冷却时间 + 过期排除，
 *   宁可漏提醒，也不要在每一步都念旧账。
 * - 过期的教训仍然可以被 recall 出来（带 stale 标记），但不再主动推送。
 *
 * @module dsh-lessons/engine
 */

import { createHash } from 'node:crypto'

/** 存储格式版本。 */
export const VERSION = 1

/** 一条教训。 */
export interface Lesson {
  /** 由 title + fix 派生的稳定短指纹。 */
  id: string
  /** 一句话说清是什么坑。 */
  title: string
  /** 当时的现象（报错原文、异常表现）。 */
  symptom?: string
  /** 根因。 */
  cause?: string
  /** 真正有效的做法。 */
  fix: string
  /** 触发标签。 */
  tags: string[]
  /** 触发路径 glob。 */
  paths: string[]
  /** 触发工具（只作辅助信号）。 */
  tools: string[]
  /** 落在工作区还是全局库。 */
  scope: 'workspace' | 'global'
  /** 首次记录时间（ISO）。 */
  createdAt: string
  /** 最后一次确认仍然成立的时间（ISO）。 */
  confirmedAt: string
  /** 被记录/确认/命中的次数。 */
  hits: number
  /** 归档后保留记录，但不再自动提醒。 */
  archived?: boolean
}

/** 一个教训库文件。 */
export interface Store {
  version: number
  lessons: Lesson[]
}

/** 插件配置；全部字段可在 cordis.yml 里覆盖。 */
export interface Config {
  version: number
  /** 超过这么多天没有被 confirm 的教训视为过期。 */
  staleDays: number
  /** 自动提醒的最低分。 */
  minScore: number
  /** 每轮最多提醒几条。 */
  maxPerTurn: number
  /** 同一条教训两次提醒之间的最短间隔（毫秒）。 */
  cooldownMs: number
  /** 最近工具活动的回看窗口。 */
  recentTools: number
  /** 标签命中的单次得分。 */
  tagWeight: number
  /** 路径（glob）命中最近触碰文件的得分。 */
  pathWeight: number
  /** 工具名命中的得分；单独命中不足以触发。 */
  toolWeight: number
}

/** 自动提醒使用的上下文。 */
export interface MatchContext {
  text: string
  paths: readonly string[]
  tools: readonly string[]
}

/** 打分结果。 */
export interface RankedLesson {
  lesson: Lesson
  score: number
}

/** 默认配置。 */
export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  version: VERSION,
  staleDays: 90,
  minScore: 4,
  maxPerTurn: 2,
  cooldownMs: 10 * 60 * 1000,
  recentTools: 8,
  tagWeight: 3,
  pathWeight: 4,
  toolWeight: 1,
})

const MAX_TITLE = 160
const MAX_TEXT = 4000
const MAX_TAGS = 12
const MAX_PATHS = 12
const MAX_TOOLS = 8

// --------------------------------------------------------------------- 配置

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(path: string, message: string): never {
  throw new Error(`lessons 配置错误：${path} ${message}`)
}

function assertNumber(value: unknown, path: string, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) fail(path, `必须是不小于 ${min} 的数字`)
  return value
}

function mergeInto(target: Json, source: Json, path: string): void {
  for (const key of Object.keys(source)) {
    if (!(key in target)) fail(path + key, `是未知字段（可用：${Object.keys(target).join('、')}）`)
    const value = source[key]
    const current = target[key]
    if (isRecord(current) && isRecord(value)) {
      mergeInto(current, value, `${path}${key}.`)
    } else {
      target[key] = value
    }
  }
}

/**
 * 合并用户配置并校验；加载期即失败。
 * @param raw 来自 cordis.yml 或配置文件的原始对象。
 * @returns 冻结后的完整配置。
 */
export function validateConfig(raw: unknown = {}): Config {
  const config = structuredClone(DEFAULT_CONFIG) as unknown as Json
  if (!isRecord(raw)) fail('根', '必须是对象')
  mergeInto(config, raw, '')
  assertNumber(config.staleDays, 'staleDays', 0)
  assertNumber(config.minScore, 'minScore', 1)
  assertNumber(config.maxPerTurn, 'maxPerTurn', 1)
  assertNumber(config.cooldownMs, 'cooldownMs', 0)
  assertNumber(config.recentTools, 'recentTools', 1)
  assertNumber(config.tagWeight, 'tagWeight', 1)
  assertNumber(config.pathWeight, 'pathWeight', 1)
  assertNumber(config.toolWeight, 'toolWeight', 0)
  return Object.freeze(config) as unknown as Config
}

// --------------------------------------------------------------------- 工具

/** 稳定的短指纹。 */
export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8)
}

/** 归一化：小写、压空白、去标点，用于匹配与去重。 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[（()）【】[\]「」『』,，。.、；;：:!！?？'"`*_|/\\—–-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 把 glob 编译成匹配工作区相对路径的正则（与 ctx-guard 同一套语义）。
 * @param pattern 形如 `packages/**\/*.ts`。
 */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern.replace(/\\/g, '/')
  let out = '^'
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === '*') {
      if (source[index + 1] === '*') {
        index++
        if (source[index + 1] === '/') {
          index++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += '\\^$.|+()[]{}'.includes(char ?? '') ? `\\${char}` : char
  }
  return new RegExp(`${out}$`)
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(item => item !== '')
  if (typeof value === 'string') return value.split(/[,，;；]/).map(item => item.trim()).filter(item => item !== '')
  return []
}

// --------------------------------------------------------------------- 教训

/** 空存储。 */
export function emptyStore(): Store {
  return { version: VERSION, lessons: [] }
}

/**
 * 构造一条教训并做校验（记录入口与存储读取共用）。
 * @param input 原始字段。
 * @param now 记录时间。
 */
export function createLesson(input: unknown, now: number = Date.now()): Lesson {
  if (!isRecord(input)) throw new Error('lesson 必须是一个对象')
  const title = String(input.title ?? '').trim()
  const fix = String(input.fix ?? '').trim()
  if (title === '') throw new Error('lesson.title 不能为空')
  if (fix === '') throw new Error('lesson.fix 不能为空（真正有效的做法是什么）')
  if (title.length > MAX_TITLE) throw new Error(`lesson.title 超过 ${MAX_TITLE} 字符`)

  const symptom = String(input.symptom ?? '').trim()
  const cause = String(input.cause ?? '').trim()
  if (symptom.length > MAX_TEXT || cause.length > MAX_TEXT || fix.length > MAX_TEXT) {
    throw new Error(`lesson 的 symptom / cause / fix 不能超过 ${MAX_TEXT} 字符`)
  }

  const scope: Lesson['scope'] = input.scope === 'global' ? 'global' : 'workspace'
  const hits = typeof input.hits === 'number' && Number.isFinite(input.hits) ? Math.max(0, Math.trunc(input.hits)) : 0
  const createdAt = typeof input.createdAt === 'string' ? input.createdAt : new Date(now).toISOString()
  const confirmedAt = typeof input.confirmedAt === 'string' ? input.confirmedAt : new Date(now).toISOString()

  return {
    id: shortHash(`${normalizeText(title)}\u0000${normalizeText(fix)}`),
    title,
    ...symptom === '' ? {} : { symptom },
    ...cause === '' ? {} : { cause },
    fix,
    tags: asArray(input.tags).slice(0, MAX_TAGS),
    paths: asArray(input.paths).slice(0, MAX_PATHS),
    tools: asArray(input.tools).slice(0, MAX_TOOLS),
    scope,
    createdAt,
    confirmedAt,
    hits,
    ...input.archived === true ? { archived: true } : {},
  }
}

/**
 * 读取存储并逐条校验；坏条目跳过并计入 problems，不让一条脏数据废掉整个库。
 */
export function normalizeStore(raw: unknown): { store: Store; problems: string[] } {
  const problems: string[] = []
  if (!isRecord(raw)) return { store: emptyStore(), problems }
  const lessons: Lesson[] = []
  const seen = new Set<string>()
  const list = Array.isArray(raw.lessons) ? raw.lessons : []
  for (const [index, item] of list.entries()) {
    try {
      const lesson = createLesson(item)
      if (seen.has(lesson.id)) continue
      seen.add(lesson.id)
      lessons.push(lesson)
    } catch (error) {
      problems.push(`第 ${index + 1} 条：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { store: { version: VERSION, lessons }, problems }
}

/**
 * 同 id 视为同一条教训：合并时累加命中、刷新确认时间。
 */
export function upsertLesson(store: Store, input: unknown, now: number = Date.now()): { store: Store; lesson: Lesson; created: boolean } {
  const lesson = createLesson(input, now)
  const lessons = [...store.lessons]
  const index = lessons.findIndex(item => item.id === lesson.id)
  if (index === -1) {
    lessons.push(lesson)
    return { store: { ...store, lessons }, lesson, created: true }
  }
  const existing = lessons[index] as Lesson
  const merged: Lesson = {
    ...existing,
    ...lesson,
    createdAt: existing.createdAt,
    hits: (existing.hits ?? 0) + 1,
    confirmedAt: new Date(now).toISOString(),
  }
  lessons[index] = merged
  return { store: { ...store, lessons }, lesson: merged, created: false }
}

/** 按 id 删除；返回新存储与被删条目。 */
export function forgetLesson(store: Store, id: string): { store: Store; found: Lesson | undefined } {
  const found = store.lessons.find(item => item.id === id)
  return { store: { ...store, lessons: store.lessons.filter(item => item.id !== id) }, found }
}

/** 归档（保留记录，不再自动提醒）。 */
export function archiveLesson(store: Store, id: string): Store {
  return { ...store, lessons: store.lessons.map(item => (item.id === id ? { ...item, archived: true } : item)) }
}

/** 重新确认一条教训：刷新 confirmedAt 并累加命中。 */
export function confirmLesson(store: Store, id: string, now: number = Date.now()): { store: Store; found: Lesson | undefined } {
  let found: Lesson | undefined
  const lessons = store.lessons.map(item => {
    if (item.id !== id) return item
    found = { ...item, hits: (item.hits ?? 0) + 1, confirmedAt: new Date(now).toISOString() }
    return found
  })
  return { store: { ...store, lessons }, found }
}

/** 天数差；无法解析时视为无穷旧。 */
export function daysSince(iso: string, now: number = Date.now()): number {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY
  return Math.floor((now - parsed) / 86_400_000)
}

/** 是否过期（未确认超过 staleDays）。 */
export function isStale(lesson: Lesson, config: Config, now: number = Date.now()): boolean {
  return daysSince(lesson.confirmedAt, now) > config.staleDays
}

/** 合并工作区与全局两个存储，按 id 去重（工作区优先）。 */
export function mergeLessons(workspaceStore: Store, globalStore: Store): Lesson[] {
  const seen = new Set<string>()
  const merged: Lesson[] = []
  for (const lesson of [...workspaceStore.lessons, ...globalStore.lessons]) {
    if (seen.has(lesson.id)) continue
    seen.add(lesson.id)
    merged.push(lesson)
  }
  return merged
}

/**
 * 给一条教训打分。
 *
 * 触发信号只有三类：本轮文本里的标签、最近触碰的文件路径、最近用过的工具。
 * 工具单独命中不算数（否则每次 bash 都会命中所有写过 bash 的教训），必须叠加
 * 至少一个其他信号。
 *
 * @returns 分数；过期或已归档返回 0。
 */
export function scoreLesson(lesson: Lesson, context: MatchContext, config: Config, now: number = Date.now()): number {
  if (lesson.archived === true) return 0
  if (isStale(lesson, config, now)) return 0
  const text = normalizeText(context.text)

  let tagScore = 0
  for (const tag of lesson.tags) {
    const needle = normalizeText(tag)
    if (needle !== '' && text.includes(needle)) tagScore += config.tagWeight
  }
  tagScore = Math.min(tagScore, config.tagWeight * 2)

  let pathScore = 0
  for (const pattern of lesson.paths) {
    const matcher = globToRegExp(pattern)
    if (context.paths.some(path => matcher.test(path.replace(/\\/g, '/')))) pathScore = config.pathWeight
  }

  let toolScore = 0
  for (const tool of lesson.tools) {
    if (context.tools.includes(tool)) toolScore = config.toolWeight
  }

  // 只有工具命中时不算触发：它太泛，会制造噪音。
  if (tagScore === 0 && pathScore === 0) return 0
  return tagScore + pathScore + toolScore
}

/**
 * 选出应当提醒的教训，按分数降序。
 */
export function rankLessons(
  lessons: readonly Lesson[],
  context: MatchContext,
  config: Config,
  { now = Date.now(), limit = Number.POSITIVE_INFINITY, exclude = new Set<string>() }: { now?: number; limit?: number; exclude?: ReadonlySet<string> } = {},
): RankedLesson[] {
  const scored: RankedLesson[] = []
  for (const lesson of lessons) {
    if (exclude.has(lesson.id)) continue
    const score = scoreLesson(lesson, context, config, now)
    if (score >= config.minScore) scored.push({ lesson, score })
  }
  scored.sort((left, right) => right.score - left.score || (right.lesson.hits ?? 0) - (left.lesson.hits ?? 0))
  return scored.slice(0, limit)
}

// --------------------------------------------------------------------- 渲染

/** 渲染自动提醒：最多两行，够模型判断“要不要参考”，不多占上下文。 */
export function renderReminder(matches: readonly RankedLesson[]): string {
  const lines = ['失败教训（同类问题之前踩过，先看再动手）：']
  for (const { lesson } of matches) {
    const cause = lesson.cause === undefined ? '' : `；根因：${lesson.cause}`
    lines.push(`- ${lesson.title} → ${lesson.fix}${cause}（#${lesson.id}）`)
  }
  return lines.join('\n')
}

/** 渲染单条教训的完整内容。 */
export function renderLesson(lesson: Lesson, config: Config, now: number = Date.now()): string {
  const age = daysSince(lesson.confirmedAt, now)
  const stale = isStale(lesson, config, now) ? '（已过期：久未确认，仅供参考）' : ''
  const lines = [`[#${lesson.id}] ${lesson.title}${stale}`]
  if (lesson.symptom !== undefined) lines.push(`现象：${lesson.symptom}`)
  if (lesson.cause !== undefined) lines.push(`根因：${lesson.cause}`)
  lines.push(`做法：${lesson.fix}`)
  const meta = [
    lesson.tags.length > 0 ? `标签 ${lesson.tags.join('/')}` : '',
    lesson.paths.length > 0 ? `路径 ${lesson.paths.join('/')}` : '',
    lesson.tools.length > 0 ? `工具 ${lesson.tools.join('/')}` : '',
    `命中 ${lesson.hits} 次`,
    `${age} 天前确认`,
    lesson.scope === 'global' ? '作用域 全局' : '作用域 工作区',
  ].filter(item => item !== '')
  lines.push(meta.join(' · '))
  return lines.join('\n')
}

/** 渲染列表。 */
export function renderList(
  lessons: readonly Lesson[],
  config: Config,
  { now = Date.now(), limit = 30, tag, stale }: { now?: number; limit?: number; tag?: string; stale?: boolean } = {},
): string {
  let selected = lessons.filter(lesson => lesson.archived !== true)
  if (tag !== undefined && tag !== '') {
    const needle = normalizeText(tag)
    selected = selected.filter(lesson => lesson.tags.some(item => normalizeText(item).includes(needle)))
  }
  const staleFlags = new Map(selected.map(lesson => [lesson.id, isStale(lesson, config, now)]))
  if (stale === true) selected = selected.filter(lesson => staleFlags.get(lesson.id) === true)
  selected.sort((left, right) => right.hits - left.hits)
  const shown = selected.slice(0, limit)
  const lines = [`教训 ${selected.length} 条${selected.length > shown.length ? `（显示前 ${shown.length}）` : ''}`]
  for (const lesson of shown) {
    const flag = staleFlags.get(lesson.id) === true ? ' · 过期' : ''
    const tags = lesson.tags.length > 0 ? ` [${lesson.tags.join(',')}]` : ''
    lines.push(`- [#${lesson.id}] ${lesson.title} → ${lesson.fix}${tags}${flag}`)
  }
  if (selected.length === 0) lines.push('还没有记录。一次非显然的失败被修复后，用 lesson action=record 记下来。')
  return lines.join('\n')
}

/** 渲染统计。 */
export function renderStats(lessons: readonly Lesson[], config: Config, now: number = Date.now()): string {
  const active = lessons.filter(lesson => lesson.archived !== true)
  const stale = active.filter(lesson => isStale(lesson, config, now))
  const totals = active.reduce((sum, lesson) => sum + lesson.hits, 0)
  const byTag = new Map<string, number>()
  for (const lesson of active) {
    for (const tag of lesson.tags) byTag.set(tag, (byTag.get(tag) ?? 0) + 1)
  }
  const top = [...byTag.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8)
  const lines = [`教训库：${active.length} 条（过期 ${stale.length}），累计命中 ${totals} 次`]
  if (top.length > 0) lines.push(`高频标签：${top.map(([tag, count]) => `${tag}(${count})`).join('、')}`)
  if (stale.length > 0) {
    lines.push(`过期条目不再自动提醒，确认仍然成立后运行 lesson action=confirm：${stale.slice(0, 5).map(lesson => `#${lesson.id}`).join(' ')}`)
  }
  return lines.join('\n')
}
