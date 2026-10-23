/**
 * 「记忆」tab 里的失败教训区：列出教训库、确认仍然成立、删除。
 *
 * 教训与记忆同一份数据面：都来自本机存储、都跨会话生效，所以放在同一个页面的
 * 下方，而不是再开一个 tab。组件不订阅外部源：快照由 inject 面提供的
 * `useLessons` 框架钩子读取，动作是普通回调。
 */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type { LessonsSnapshot } from './lessons.ts'
import css from './MemoryView.module.css'

/** 本插件的字典座位。 */
type MemoryTranslate = TranslateNS<typeof NS>

/** 教训区需要的注入面。 */
export interface LessonsInjected {
  hooks: {
    lessons: SnapshotStore<LessonsSnapshot>
  }
  /** 重新读取教训列表。 */
  loadLessons: () => void
  /** 确认一条教训仍然成立。 */
  confirmLesson: (id: string) => void
  /** 删除一条教训。 */
  forgetLesson: (id: string) => void
}

/** 教训区视图属性。 */
export interface LessonsSectionProps {
  t: MemoryTranslate
  useLessons: <T>(selector: (state: LessonsSnapshot) => T) => T
  loadLessons: () => void
  confirmLesson: (id: string) => void
  forgetLesson: (id: string) => void
}

/**
 * 渲染教训区。
 * @param props - 字典座位、快照钩子与三个动作。
 */
export function LessonsSection(props: LessonsSectionProps) {
  const { t, useLessons, loadLessons, confirmLesson, forgetLesson } = props
  const snapshot = useLessons(state => state)
  const report = snapshot.report
  const total = report?.counts.total ?? 0
  const stale = report?.counts.stale ?? 0

  return (
    <section className={css.section} aria-label={t('section.lessons')}>
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('section.lessons')}</h3>
        <span className={css.usage}>{t('lessons.count', { total, stale })}</span>
        <span className={css.spacer} />
        <Button variant="ghost" size="sm" onClick={loadLessons}>{t('lessons.reload')}</Button>
      </div>
      {snapshot.notice !== null && snapshot.notice.kind === 'failed' && (
        <p className={css.noticeError} role="alert">
          {t('lessons.failed')}
          <span className={css.detail}>{snapshot.notice.detail ?? ''}</span>
        </p>
      )}
      {report !== null && report.lessons.length === 0 && (
        <p className={css.empty}>{t('lessons.empty')}</p>
      )}
      <ul className={css.entries}>
        {(report?.lessons ?? []).map(lesson => (
          <li key={lesson.id} className={css.lesson}>
            <div className={css.lessonMain}>
              <span className={css.lessonTitle}>{lesson.title}</span>
              {lesson.stale && <span className={css.staleTag}>{t('lessons.stale')}</span>}
              {lesson.tags.map(tag => <span key={tag} className={css.tag}>{tag}</span>)}
            </div>
            <p className={css.lessonFix}>{lesson.fix}</p>
            {lesson.cause !== undefined && <p className={css.lessonMeta}>{t('lessons.cause', { cause: lesson.cause })}</p>}
            <div className={css.lessonActions}>
              <span className={css.lessonMeta}>{t('lessons.meta', { hits: lesson.hits, days: lesson.ageDays })}</span>
              <span className={css.spacer} />
              <Button variant="ghost" size="sm" onClick={() => { confirmLesson(lesson.id) }}>
                {t('lessons.confirm')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { forgetLesson(lesson.id) }}>
                {t('lessons.forget')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
