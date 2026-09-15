/**
 * Memory editor state: the same-origin memory API transport plus the published
 * editing snapshot. One controller is created per plugin lifecycle in apply()
 * and shared by every session's tab through the registration's inject face.
 *
 * The API is served by the host plugin on the page's own origin, so every
 * request uses a relative URL and the required `x-dsh-memory` header. A
 * non-2xx response, or a refusal body the API returns with 2xx, is a failure
 * whose user-visible text the `memory` dictionary owns.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Request header the memory API requires; it answers 403 without it. */
const MEMORY_HEADER = 'x-dsh-memory'

/** Value sent for {@link MEMORY_HEADER}. */
const MEMORY_HEADER_VALUE = '1'

/** State route; relative so the request stays same-origin. */
const STATE_ROUTE = '/memory/state'

/** Write route; relative so the request stays same-origin. */
const WRITE_ROUTE = '/memory/write'

/** The two editable targets, in display order. */
export const MEMORY_TARGETS = ['user', 'memory'] as const

/** One editable memory target. */
export type MemoryTarget = (typeof MEMORY_TARGETS)[number]

/** One entry mutation the write route accepts. */
export type MemoryOperation =
  | { readonly action: 'add'; readonly content: string }
  | { readonly action: 'replace'; readonly oldText: string; readonly content: string }
  | { readonly action: 'remove'; readonly oldText: string }

/** One target as the state and write routes report it. */
export interface MemoryTargetReport {
  readonly target: string
  readonly entries: readonly string[]
  readonly chars: number
  readonly limit: number
}

/** `GET /memory/state` response body. */
export interface MemoryStateReport {
  readonly targets: readonly MemoryTargetReport[]
}

/** `POST /memory/write` response body: accepted, or refused with a reason. */
export type MemoryWriteReport =
  | { readonly ok: true; readonly note: string; readonly snapshot: MemoryStateReport }
  | {
    readonly ok: false
    readonly code: string
    readonly message: string
    readonly snapshot?: MemoryStateReport
  }

/** One section's staged edits over the entries the API last returned. */
export interface MemorySectionState {
  /** Entry texts as loaded; each is the `oldText` an operation refers to. */
  entries: string[]
  /** Draft text by entry index; an absent index means the entry is unchanged. */
  drafts: Record<number, string>
  /** Entry indices staged for removal. */
  removed: number[]
  /** New entries staged for the next save, in order. */
  additions: string[]
  /** Character usage the API reported for this target. */
  chars: number
  /** Character budget the API reported for this target. */
  limit: number
}

/** Outcome banner of the most recent request. */
export type MemoryNotice =
  | { readonly kind: 'saved'; readonly detail: string | null }
  | { readonly kind: 'unchanged' }
  | {
    readonly kind: 'failed'
    /** HTTP status of a transport failure, when the request reached the API. */
    readonly status: number | null
    /** Server-supplied text, rendered verbatim; `null` when the API sent none. */
    readonly detail: string | null
  }

/** Published editor state (read through the `useMemory` selector hook). */
export interface MemorySnapshot {
  /** `loading` during the first read; `error` when that read failed. */
  phase: 'loading' | 'ready' | 'error'
  /** Staged and loaded state, one section per target. */
  sections: Record<MemoryTarget, MemorySectionState>
  /** Target whose write is in flight, when any. */
  saving: MemoryTarget | null
  /** Outcome of the most recent request; cleared when the next one starts. */
  notice: MemoryNotice | null
}

/** Test seams for the memory controller. */
export interface MemoryControllerOptions {
  /** fetch override (specs inject a fake). */
  readonly fetchImpl?: typeof fetch
}

/** A memory API response outside the 2xx range. */
class MemoryHttpError extends Error {
  /** HTTP status the API answered with. */
  readonly status: number

  /**
   * @param status - HTTP status the API answered with.
   */
  constructor(status: number) {
    super(`memory API answered HTTP ${status}`)
    this.status = status
  }
}

/** One section with nothing loaded and nothing staged. */
function emptySection(): MemorySectionState {
  return { entries: [], drafts: {}, removed: [], additions: [], chars: 0, limit: 0 }
}

/**
 * The operations one section's staged edits translate to: removals and
 * replacements in loaded entry order, then additions in staging order. An
 * entry marked for removal yields only `remove`; a draft equal to the loaded
 * text yields nothing.
 * @param section - staged section state.
 * @returns the operations to post for this target (empty when nothing changed).
 */
export function pendingOperations(section: MemorySectionState): MemoryOperation[] {
  const operations: MemoryOperation[] = []
  section.entries.forEach((text, index) => {
    if (section.removed.includes(index)) {
      operations.push({ action: 'remove', oldText: text })
      return
    }
    const draft = section.drafts[index]
    if (draft !== undefined && draft !== text) {
      operations.push({ action: 'replace', oldText: text, content: draft })
    }
  })
  for (const content of section.additions) operations.push({ action: 'add', content })
  return operations
}

/**
 * Create the shared memory editor store. Declared once at register and handed
 * to every session's tab through the registration's inject face.
 * @returns the published editor snapshot store.
 */
export function createMemoryStore(): SnapshotStore<MemorySnapshot> {
  return createSnapshotStore<MemorySnapshot>({
    phase: 'loading',
    sections: { user: emptySection(), memory: emptySection() },
    saving: null,
    notice: null,
  })
}

/**
 * Replace the named sections with a report's authoritative entries and usage,
 * dropping their staged drafts, removals, and additions. Sections the report
 * does not cover, and sections not named here, keep their staged edits.
 * @param draft - editor snapshot draft.
 * @param report - state report, or the snapshot of a write.
 * @param targets - sections to adopt.
 */
function adoptReport(
  draft: MemorySnapshot,
  report: MemoryStateReport,
  targets: readonly MemoryTarget[],
): void {
  for (const target of targets) {
    const reported = report.targets.find(candidate => candidate.target === target)
    if (reported === undefined) continue
    const section = draft.sections[target]
    section.entries = [...reported.entries]
    section.chars = reported.chars
    section.limit = reported.limit
    section.drafts = {}
    section.removed = []
    section.additions = []
  }
}

/**
 * Split a failed request into the HTTP status and any server-supplied text.
 * @param error - the thrown value.
 * @returns the status (null when the request never reached the API) and detail.
 */
function describeFailure(error: unknown): { status: number | null; detail: string | null } {
  if (error instanceof MemoryHttpError) return { status: error.status, detail: null }
  return { status: null, detail: error instanceof Error ? error.message : null }
}

/**
 * MemoryEditor controller: owns the memory API transport, the staged edits,
 * and the published snapshot. Created once per plugin lifecycle in apply();
 * dispose() stops in-flight responses from publishing.
 */
export class MemoryController {
  /** The published editor snapshot (components read it through `useMemory`). */
  readonly store: SnapshotStore<MemorySnapshot>
  private readonly fetchImpl: typeof fetch
  private disposed = false

  /**
   * @param store - the shared editor store created at register.
   * @param opts - test seams (fetch).
   */
  constructor(store: SnapshotStore<MemorySnapshot>, opts: MemoryControllerOptions = {}) {
    // Native fetch requires its `Window` receiver; detaching it into a field
    // and calling it bare throws "Illegal invocation" (test stubs are
    // `this`-agnostic).
    this.fetchImpl = (opts.fetchImpl ?? fetch).bind(globalThis)
    this.store = store
  }

  /** Stop publishing; an in-flight response is discarded when it settles. */
  dispose(): void {
    this.disposed = true
  }

  /** Read both targets' entries and usage, replacing every staged edit. */
  async load(): Promise<void> {
    this.store.update(draft => { draft.phase = 'loading'; draft.notice = null })
    try {
      const report = await this.request<MemoryStateReport>(STATE_ROUTE, { method: 'GET' })
      if (this.disposed) return
      this.store.update(draft => {
        adoptReport(draft, report, MEMORY_TARGETS)
        draft.phase = 'ready'
        draft.notice = null
      })
    } catch (error) {
      this.fail(error, true)
    }
  }

  /**
   * Post one target's staged operations. A section with no staged change
   * saves nothing; an accepted write adopts the snapshot the API returned.
   * @param target - section to write.
   */
  async save(target: MemoryTarget): Promise<void> {
    const operations = pendingOperations(this.store.getSnapshot().sections[target])
    if (operations.length === 0) {
      this.store.update(draft => { draft.notice = { kind: 'unchanged' } })
      return
    }
    this.store.update(draft => { draft.notice = null; draft.saving = target })
    try {
      const report = await this.request<MemoryWriteReport>(WRITE_ROUTE, {
        method: 'POST',
        body: JSON.stringify({ target, operations }),
        json: true,
      })
      if (this.disposed) return
      this.store.update(draft => {
        // Only the written target is re-derived from the API: the response
        // carries every target, and adopting all of them would silently drop
        // edits the user has staged in the other section.
        if (!report.ok && report.snapshot !== undefined) adoptReport(draft, report.snapshot, [target])
        if (report.ok) {
          adoptReport(draft, report.snapshot, [target])
          draft.phase = 'ready'
        }
        draft.saving = null
        draft.notice = report.ok
          ? { kind: 'saved', detail: report.note === '' ? null : report.note }
          : { kind: 'failed', status: null, detail: report.message }
      })
    } catch (error) {
      this.fail(error, false)
    }
  }

  /**
   * Record one entry's draft text.
   * @param target - owning section.
   * @param index - loaded entry index.
   * @param text - draft text.
   */
  setDraft(target: MemoryTarget, index: number, text: string): void {
    this.store.update(draft => { draft.sections[target].drafts[index] = text })
  }

  /**
   * Stage one loaded entry for removal.
   * @param target - owning section.
   * @param index - loaded entry index.
   */
  removeEntry(target: MemoryTarget, index: number): void {
    this.store.update(draft => {
      const section = draft.sections[target]
      if (!section.removed.includes(index)) section.removed.push(index)
    })
  }

  /**
   * Undo a staged removal.
   * @param target - owning section.
   * @param index - loaded entry index.
   */
  restoreEntry(target: MemoryTarget, index: number): void {
    this.store.update(draft => {
      const section = draft.sections[target]
      section.removed = section.removed.filter(candidate => candidate !== index)
    })
  }

  /**
   * Stage a new entry. Blank text stages nothing.
   * @param target - owning section.
   * @param text - entry text.
   */
  addEntry(target: MemoryTarget, text: string): void {
    const content = text.trim()
    if (content === '') return
    this.store.update(draft => { draft.sections[target].additions.push(content) })
  }

  /**
   * Drop one staged addition.
   * @param target - owning section.
   * @param index - staged addition index.
   */
  dropAddition(target: MemoryTarget, index: number): void {
    this.store.update(draft => { draft.sections[target].additions.splice(index, 1) })
  }

  /** Send one request and decode its JSON body. */
  private async request<T>(
    route: string,
    init: { method: 'GET' | 'POST'; body?: string; json?: boolean },
  ): Promise<T> {
    const headers: Record<string, string> = { [MEMORY_HEADER]: MEMORY_HEADER_VALUE }
    if (init.json === true) headers['content-type'] = 'application/json'
    const response = await this.fetchImpl(route, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    if (!response.ok) throw new MemoryHttpError(response.status)
    return await response.json() as T
  }

  /** Publish the banner for a failed request. */
  private fail(error: unknown, loading: boolean): void {
    if (this.disposed) return
    const failure = describeFailure(error)
    this.store.update(draft => {
      if (loading) draft.phase = 'error'
      draft.saving = null
      draft.notice = { kind: 'failed', status: failure.status, detail: failure.detail }
    })
  }
}
