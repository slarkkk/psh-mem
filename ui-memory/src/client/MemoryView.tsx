/**
 * The memory conversation-view tab: one section per editable target, each
 * listing that target's entries, its character usage, and the edits staged for
 * the next save. The view reads the shared editor snapshot through the
 * `useMemory` hook the renderer binds from the inject `hooks` compartment and
 * drives the controller through the injected callbacks — no ctx, no
 * subscriptions of its own.
 */
import { useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS, type MemoryKey } from './locales.ts'
import {
  MEMORY_TARGETS, pendingOperations,
  type MemoryNotice, type MemorySectionState, type MemorySnapshot, type MemoryTarget,
} from './state.ts'
import css from './MemoryView.module.css'

/** Translate seat of this plugin's dictionary. */
type MemoryTranslate = TranslateNS<typeof NS>

/**
 * Business face injected into every session's memory tab (one shared editor).
 */
export interface MemoryViewInjected {
  hooks: {
    memory: SnapshotStore<MemorySnapshot>
  }
  /** Read both targets' entries and usage. */
  load: () => void
  /** Post one target's staged operations. */
  save: (target: MemoryTarget) => void
  /** Record one entry's draft text. */
  setDraft: (target: MemoryTarget, index: number, text: string) => void
  /** Stage one loaded entry for removal. */
  removeEntry: (target: MemoryTarget, index: number) => void
  /** Undo a staged removal. */
  restoreEntry: (target: MemoryTarget, index: number) => void
  /** Stage a new entry. */
  addEntry: (target: MemoryTarget, text: string) => void
  /** Drop one staged addition. */
  dropAddition: (target: MemoryTarget, index: number) => void
}

/** Full view props: the conversation-view standard kit + inject face + locale seat. */
export type MemoryViewProps =
  & ConvViewProps
  & InjectFace<MemoryViewInjected>
  & PropsLocale<typeof NS>

/** Section titles, in section order. */
const SECTION_TITLE: Record<MemoryTarget, MemoryKey> = {
  user: 'section.user',
  memory: 'section.memory',
}

/** Exhaustiveness guard for the closed notice union. */
function assertNever(value: never): never {
  throw new Error(`unhandled memory notice: ${JSON.stringify(value)}`)
}

/**
 * Render the memory editor page for both targets.
 * @param props - view props (framework kit, injected face, locale seat).
 */
export function MemoryView(props: MemoryViewProps) {
  const {
    useMemory, t, load, save, setDraft, removeEntry, restoreEntry, addEntry, dropAddition,
  } = props
  const snapshot = useMemory(state => state)

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.title}>{t('view.memory')}</span>
        <Button variant="outline" size="sm" disabled={snapshot.phase === 'loading'} onClick={load}>
          {t('actions.reload')}
        </Button>
      </div>
      {snapshot.notice !== null && <Notice notice={snapshot.notice} t={t} />}
      {snapshot.phase !== 'ready' && (
        <p className={css.status}>
          {t(snapshot.phase === 'loading' ? 'status.loading' : 'status.loadFailed')}
        </p>
      )}
      <div className={css.sections}>
        {MEMORY_TARGETS.map(target => (
          <MemorySection
            key={target}
            title={t(SECTION_TITLE[target])}
            t={t}
            section={snapshot.sections[target]}
            saving={snapshot.saving === target}
            onSave={() => { save(target) }}
            onDraft={(index, text) => { setDraft(target, index, text) }}
            onRemove={index => { removeEntry(target, index) }}
            onRestore={index => { restoreEntry(target, index) }}
            onAdd={text => { addEntry(target, text) }}
            onDropAddition={index => { dropAddition(target, index) }}
          />
        ))}
      </div>
    </div>
  )
}

/** Outcome banner of the most recent request. */
function Notice({ notice, t }: { notice: MemoryNotice, t: MemoryTranslate }) {
  switch (notice.kind) {
    case 'saved':
      return (
        <p className={css.noticeOk} role="status">
          {t('notice.saved')}
          {notice.detail !== null && <span className={css.detail}>{notice.detail}</span>}
        </p>
      )
    case 'unchanged':
      return <p className={css.noticeNeutral} role="status">{t('notice.unchanged')}</p>
    case 'failed':
      return (
        <p className={css.noticeError} role="alert">
          {t('notice.failed')}
          <span className={css.detail}>
            {notice.detail ?? (notice.status === null ? '' : t('notice.status', { status: notice.status }))}
          </span>
        </p>
      )
    default:
      return assertNever(notice)
  }
}

/** One target's section: usage, loaded entries, staged additions, and save. */
function MemorySection(props: {
  title: string
  t: MemoryTranslate
  section: MemorySectionState
  saving: boolean
  onSave: () => void
  onDraft: (index: number, text: string) => void
  onRemove: (index: number) => void
  onRestore: (index: number) => void
  onAdd: (text: string) => void
  onDropAddition: (index: number) => void
}) {
  const { title, t, section, saving, onSave, onDraft, onRemove, onRestore, onAdd, onDropAddition } = props
  const [draft, setDraft] = useState('')
  const staged = pendingOperations(section).length

  return (
    <section className={css.section} aria-label={title}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{title}</h3>
        <span className={css.usage}>{t('usage.text', { chars: section.chars, limit: section.limit })}</span>
      </div>
      {section.entries.length === 0 && <p className={css.empty}>{t('entries.empty')}</p>}
      <ul className={css.entries}>
        {section.entries.map((text, index) => {
          const removed = section.removed.includes(index)
          return (
            <li key={index} className={removed ? css.entryRemoved : css.entry}>
              {removed
                ? (
                  <>
                    <span className={css.pendingTag}>{t('entry.removed')}</span>
                    <span className={css.pendingText}>{text}</span>
                    <Button variant="ghost" size="sm" onClick={() => { onRestore(index) }}>
                      {t('entry.undo')}
                    </Button>
                  </>
                )
                : (
                  <>
                    <textarea
                      className={css.textarea}
                      aria-label={t('entry.editorLabel')}
                      rows={2}
                      value={section.drafts[index] ?? text}
                      onChange={event => { onDraft(index, event.target.value) }}
                    />
                    <Button variant="ghost" size="sm" onClick={() => { onRemove(index) }}>
                      {t('entry.remove')}
                    </Button>
                  </>
                )}
            </li>
          )
        })}
        {section.additions.map((content, index) => (
          <li key={`add-${index}`} className={css.pendingRow}>
            <span className={css.pendingTag}>{t('entry.pendingAdd')}</span>
            <span className={css.pendingText}>{content}</span>
            <Button variant="ghost" size="sm" onClick={() => { onDropAddition(index) }}>
              {t('entry.discard')}
            </Button>
          </li>
        ))}
      </ul>
      <div className={css.addRow}>
        <textarea
          className={css.textarea}
          aria-label={t('entry.addLabel')}
          placeholder={t('entry.addPlaceholder')}
          rows={2}
          value={draft}
          onChange={event => { setDraft(event.target.value) }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={draft.trim() === ''}
          onClick={() => { onAdd(draft); setDraft('') }}
        >
          {t('entry.add')}
        </Button>
      </div>
      <div className={css.actions}>
        <Button variant="primary" size="sm" disabled={staged === 0 || saving} onClick={onSave}>
          {t(saving ? 'actions.saving' : 'actions.save')}
        </Button>
      </div>
    </section>
  )
}
