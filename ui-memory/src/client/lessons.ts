/**
 * 失败教训区：同源 lessons API 的传输层 + 发布给视图的快照。
 *
 * 教训库是记忆的一部分：一样跨会话、一样落在本地，只是内容形态不同
 * （现象 / 根因 / 做法，而不是一条自由文本）。控制器与记忆编辑器同生命周期，
 * 每个会话的「记忆」tab 共用这一份。
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** API 要求的自定义头；跨源页面发不出它。 */
const LESSONS_HEADER = 'x-dsh-lessons'

/** 读取路由。 */
const STATE_ROUTE = '/lessons/state'

/** 「仍然成立」路由。 */
const CONFIRM_ROUTE = '/lessons/confirm'

/** 删除路由。 */
const FORGET_ROUTE = '/lessons/forget'

/** 一条教训（与宿主 lessons 插件的 /lessons/state 对齐）。 */
export interface LessonEntry {
  readonly id: string
  readonly title: string
  readonly symptom?: string
  readonly cause?: string
  readonly fix: string
  readonly tags: readonly string[]
  readonly paths: readonly string[]
  readonly tools: readonly string[]
  readonly scope: 'workspace' | 'global'
  readonly hits: number
  /** 距最后一次「仍然成立」确认的天数。 */
  readonly ageDays: number
  /** 超过 staleDays 未确认。 */
  readonly stale: boolean
}

/** `GET /lessons/state` 响应体。 */
export interface LessonsReport {
  readonly workspace: string
  readonly counts: {
    readonly total: number
    readonly stale: number
    readonly hits: number
  }
  readonly lessons: readonly LessonEntry[]
}

/** 最近一次操作的结果。 */
export type LessonsNotice =
  | { readonly kind: 'confirmed' | 'deleted' }
  | { readonly kind: 'failed'; readonly detail: string | null }

/** 发布给视图的教训快照。 */
export interface LessonsSnapshot {
  /** 首次读取期间为 `loading`；读取失败且没有旧数据时为 `error`。 */
  phase: 'loading' | 'ready' | 'error'
  report: LessonsReport | null
  notice: LessonsNotice | null
}

/** 测试缝：specs 注入假 fetch。 */
export interface LessonsControllerOptions {
  readonly fetchImpl?: typeof fetch
}

/** 一条失败的可读描述。 */
function describeFailure(error: unknown): string | null {
  if (error instanceof Error && error.message !== '') return error.message
  return null
}

/**
 * 创建共享的教训快照存储（在 apply 里建一次，各会话的 tab 共用）。
 * @returns 发布给 `useLessons` 的快照存储。
 */
export function createLessonsStore(): SnapshotStore<LessonsSnapshot> {
  return createSnapshotStore<LessonsSnapshot>({ phase: 'loading', report: null, notice: null })
}

/** 教训区控制器：读列表、确认仍然成立、删除。 */
export class LessonsController {
  /** 发布给视图的快照（通过 `useLessons` 读取）。 */
  readonly store: SnapshotStore<LessonsSnapshot>
  private readonly fetchImpl: typeof fetch
  private disposed = false

  /**
   * @param store - apply 时创建的共享存储。
   * @param options - 测试缝（fetch）。
   */
  constructor(store: SnapshotStore<LessonsSnapshot>, options: LessonsControllerOptions = {}) {
    // 原生 fetch 需要 Window 接收者，裸调用会抛 Illegal invocation。
    this.fetchImpl = (options.fetchImpl ?? fetch).bind(globalThis)
    this.store = store
  }

  /** 停止发布；已在途的响应落地时被丢弃。 */
  dispose(): void {
    this.disposed = true
  }

  /** 读取教训列表。 */
  async load(): Promise<void> {
    this.store.update(draft => {
      if (draft.report === null) draft.phase = 'loading'
      draft.notice = null
    })
    try {
      const report = await this.request<LessonsReport>(STATE_ROUTE, { method: 'GET' })
      if (this.disposed) return
      this.store.update(draft => {
        draft.phase = 'ready'
        draft.report = report
        draft.notice = null
      })
    } catch (error) {
      this.fail(error)
    }
  }

  /**
   * 确认一条教训仍然成立（刷新确认时间，过期条目重新参与自动提醒）。
   * @param id - 教训编号。
   */
  async confirm(id: string): Promise<void> {
    await this.mutate(CONFIRM_ROUTE, id, 'confirmed')
  }

  /**
   * 删除一条教训（删除后不再自动提醒）。
   * @param id - 教训编号。
   */
  async forget(id: string): Promise<void> {
    await this.mutate(FORGET_ROUTE, id, 'deleted')
  }

  private async mutate(route: string, id: string, kind: 'confirmed' | 'deleted'): Promise<void> {
    this.store.update(draft => { draft.notice = null })
    try {
      await this.request<unknown>(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (this.disposed) return
      this.store.update(draft => { draft.notice = { kind } })
      await this.load()
    } catch (error) {
      this.fail(error)
    }
  }

  private fail(error: unknown): void {
    if (this.disposed) return
    this.store.update(draft => {
      if (draft.report === null) draft.phase = 'error'
      draft.notice = { kind: 'failed', detail: describeFailure(error) }
    })
  }

  private async request<T>(route: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(route, {
      ...init,
      headers: { [LESSONS_HEADER]: '1', ...init.headers },
    })
    if (!response.ok) {
      let detail: string | null = null
      try {
        const body: unknown = await response.json()
        if (body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
          detail = body.error
        }
      } catch {
        // 非 JSON 错误体：保留 HTTP 状态即可
      }
      throw new Error(detail ?? `HTTP ${response.status}`)
    }
    return await response.json() as T
  }
}
