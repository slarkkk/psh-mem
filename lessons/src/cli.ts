#!/usr/bin/env node
/**
 * lessons CLI —— 不启动 DSH 也能记录/查询教训库，用于命令行、脚本与 CI。
 *
 *   node lib/cli.js record --title "…" --fix "…" [--tags a,b] [--paths glob] [--tools bash] [--scope global]
 *   node lib/cli.js list [--tag 构建] [--limit 20] [--json]
 *   node lib/cli.js recall "关键词" [--json]
 *   node lib/cli.js confirm <id> | forget <id> | archive <id>
 *   node lib/cli.js stats
 *   node lib/cli.js export
 *
 * 工作区库默认是 <workspace>/.dsh/lessons.json；全局库是 $DSH_HOME/storages/lessons.json。
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  archiveLesson,
  confirmLesson,
  emptyStore,
  forgetLesson,
  mergeLessons,
  normalizeStore,
  rankLessons,
  renderLesson,
  renderList,
  renderStats,
  upsertLesson,
  validateConfig,
  type Store,
} from './engine.ts'

const USAGE = `lessons —— 失败教训库

  record --title <标题> --fix <做法> [--symptom <现象>] [--cause <根因>]
         [--tags a,b] [--paths glob1,glob2] [--tools bash,pwsh] [--scope workspace|global]
  list   [--tag <标签>] [--limit N] [--json]
  recall <关键词...> [--json]
  confirm <id> | forget <id> | archive <id>
  stats
  export

  通用：--workspace <dir>（默认当前目录）  --home <DSH_HOME>
`

interface Options {
  workspace: string
  home?: string
  title?: string
  fix?: string
  symptom?: string
  cause?: string
  tags?: string
  paths?: string
  tools?: string
  scope?: string
  tag?: string
  limit?: number
  json?: boolean
  help?: boolean
  command?: string
  rest: string[]
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { workspace: process.cwd(), rest: [] }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string
    const take = (): string => argv[++index] as string
    if (arg === '--workspace') options.workspace = take()
    else if (arg === '--home') options.home = take()
    else if (arg === '--title') options.title = take()
    else if (arg === '--fix') options.fix = take()
    else if (arg === '--symptom') options.symptom = take()
    else if (arg === '--cause') options.cause = take()
    else if (arg === '--tags') options.tags = take()
    else if (arg === '--paths') options.paths = take()
    else if (arg === '--tools') options.tools = take()
    else if (arg === '--scope') options.scope = take()
    else if (arg === '--tag') options.tag = take()
    else if (arg === '--limit') options.limit = Number(take())
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`)
    else options.rest.push(arg)
  }
  options.workspace = resolve(options.workspace)
  options.command = options.rest.shift()
  return options
}

async function readStore(path: string): Promise<Store> {
  try {
    return normalizeStore(JSON.parse(await readFile(path, 'utf8'))).store
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT') return emptyStore()
    throw new Error(`读取 ${path} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeStore(path: string, store: Store): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true || options.command === undefined) {
    process.stdout.write(USAGE)
    return 0
  }
  const config = validateConfig({})
  const home = resolve(options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const workspaceFile = join(options.workspace, '.dsh', 'lessons.json')
  const globalFile = join(home, 'storages', 'lessons.json')
  const readAll = async (): Promise<ReturnType<typeof mergeLessons>> => (
    mergeLessons(await readStore(workspaceFile), await readStore(globalFile))
  )

  if (options.command === 'record') {
    const target = options.scope === 'global' ? globalFile : workspaceFile
    const store = await readStore(target)
    const result = upsertLesson(store, {
      title: options.title,
      fix: options.fix,
      symptom: options.symptom,
      cause: options.cause,
      tags: options.tags,
      paths: options.paths,
      tools: options.tools,
      scope: options.scope,
    })
    await writeStore(target, result.store)
    process.stdout.write(`${result.created ? '已记录' : '已合并'} [#${result.lesson.id}] ${result.lesson.title}\n`)
    return 0
  }

  if (options.command === 'list') {
    const lessons = await readAll()
    if (options.json === true) process.stdout.write(`${JSON.stringify(lessons, null, 2)}\n`)
    else process.stdout.write(`${renderList(lessons, config, { tag: options.tag, limit: options.limit ?? 20 })}\n`)
    return 0
  }

  if (options.command === 'recall') {
    const query = options.rest.join(' ')
    if (query.trim() === '') throw new Error('recall 需要关键词')
    const matches = rankLessons(await readAll(), { text: query, paths: [], tools: [] }, config, { limit: options.limit ?? 5 })
    if (options.json === true) process.stdout.write(`${JSON.stringify(matches.map(({ lesson, score }) => ({ ...lesson, score })), null, 2)}\n`)
    else if (matches.length === 0) process.stdout.write('没有匹配的教训。\n')
    else process.stdout.write(`${matches.map(({ lesson }) => renderLesson(lesson, config)).join('\n\n')}\n`)
    return 0
  }

  if (options.command === 'stats') {
    process.stdout.write(`${renderStats(await readAll(), config)}\n`)
    return 0
  }

  if (options.command === 'export') {
    const lessons = await readAll()
    process.stdout.write(`${JSON.stringify({ version: 1, lessons }, null, 2)}\n`)
    return 0
  }

  if (['confirm', 'forget', 'archive'].includes(options.command)) {
    const id = (options.rest[0] ?? '').replace(/^\[#?|\]$/g, '')
    if (id === '') throw new Error(`${options.command} 需要 id`)
    for (const path of [workspaceFile, globalFile]) {
      const store = await readStore(path)
      if (!store.lessons.some(lesson => lesson.id === id)) continue
      if (options.command === 'confirm') {
        await writeStore(path, confirmLesson(store, id).store)
        process.stdout.write(`已确认 [#${id}] 仍然成立。\n`)
      } else if (options.command === 'archive') {
        await writeStore(path, archiveLesson(store, id))
        process.stdout.write(`已归档 [#${id}]。\n`)
      } else {
        await writeStore(path, forgetLesson(store, id).store)
        process.stdout.write(`已删除 [#${id}]。\n`)
      }
      return 0
    }
    throw new Error(`没有找到 [#${id}]`)
  }

  throw new Error(`未知命令：${options.command}（可用：record | list | recall | confirm | forget | archive | stats | export）`)
}

/** 只有被直接执行时才跑；被 import 时保持无副作用。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  main().then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write(`lessons: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  })
}
