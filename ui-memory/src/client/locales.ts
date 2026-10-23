/**
 * `memory` namespace dictionaries: the view tab label plus the editor chrome.
 * The dictionary key set is the source of truth for both locales.
 */
export const NS = 'memory'

/** The memory editor dictionary key set (used by both locales and the specs). */
export type MemoryKey =
  | 'view.memory'
  | 'section.user'
  | 'section.memory'
  | 'section.lessons'
  | 'usage.text'
  | 'entries.empty'
  | 'entry.editorLabel'
  | 'entry.removed'
  | 'entry.remove'
  | 'entry.undo'
  | 'entry.addLabel'
  | 'entry.addPlaceholder'
  | 'entry.add'
  | 'entry.pendingAdd'
  | 'entry.discard'
  | 'actions.save'
  | 'actions.saving'
  | 'actions.reload'
  | 'status.loading'
  | 'status.loadFailed'
  | 'notice.saved'
  | 'notice.unchanged'
  | 'notice.failed'
  | 'notice.status'
  | 'lessons.count'
  | 'lessons.empty'
  | 'lessons.stale'
  | 'lessons.confirm'
  | 'lessons.forget'
  | 'lessons.meta'
  | 'lessons.cause'
  | 'lessons.failed'
  | 'lessons.reload'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The memory view tab label and editor chrome. */
    'memory': MemoryKey
  }
}

/** zh-CN dictionary (product copy language). */
export const zh: Record<MemoryKey, string> = {
  'view.memory': '记忆',
  'section.user': '用户档案',
  'section.memory': '记忆',
  'section.lessons': '失败教训',
  'usage.text': '{chars} / {limit} 字符',
  'entries.empty': '暂无条目',
  'entry.editorLabel': '条目内容',
  'entry.removed': '待移除',
  'entry.remove': '移除',
  'entry.undo': '撤销',
  'entry.addLabel': '新增条目',
  'entry.addPlaceholder': '输入需要长期记住的内容…',
  'entry.add': '添加',
  'entry.pendingAdd': '待添加',
  'entry.discard': '丢弃',
  'actions.save': '保存',
  'actions.saving': '保存中…',
  'actions.reload': '重新加载',
  'status.loading': '正在读取记忆…',
  'status.loadFailed': '无法读取记忆',
  'notice.saved': '已保存',
  'notice.unchanged': '没有需要保存的改动',
  'notice.failed': '请求失败',
  'notice.status': 'HTTP {status}',
  'lessons.count': '{total} 条（过期 {stale}）',
  'lessons.empty': '还没有记录。一次非显然的失败被修复后，让模型用 lesson 记一条。',
  'lessons.stale': '过期',
  'lessons.confirm': '仍然成立',
  'lessons.forget': '删除',
  'lessons.meta': '命中 {hits} 次 · {days} 天前确认',
  'lessons.cause': '根因：{cause}',
  'lessons.failed': '教训库请求失败',
  'lessons.reload': '重新加载教训',
}

/** en dictionary. */
export const en: Record<MemoryKey, string> = {
  'view.memory': 'Memory',
  'section.user': 'User profile',
  'section.memory': 'Memory',
  'section.lessons': 'Lessons',
  'usage.text': '{chars} / {limit} characters',
  'entries.empty': 'No entries yet',
  'entry.editorLabel': 'Entry text',
  'entry.removed': 'Marked for removal',
  'entry.remove': 'Remove',
  'entry.undo': 'Undo',
  'entry.addLabel': 'New entry',
  'entry.addPlaceholder': 'Type what should be remembered…',
  'entry.add': 'Add',
  'entry.pendingAdd': 'Pending addition',
  'entry.discard': 'Discard',
  'actions.save': 'Save',
  'actions.saving': 'Saving…',
  'actions.reload': 'Reload',
  'status.loading': 'Loading memory…',
  'status.loadFailed': 'Could not load memory',
  'notice.saved': 'Saved',
  'notice.unchanged': 'Nothing to save',
  'notice.failed': 'Request failed',
  'notice.status': 'HTTP {status}',
  'lessons.count': '{total} entries ({stale} stale)',
  'lessons.empty': 'Nothing recorded yet. After a non-obvious failure is fixed, ask the model to record it with lesson.',
  'lessons.stale': 'stale',
  'lessons.confirm': 'Still valid',
  'lessons.forget': 'Delete',
  'lessons.meta': 'used {hits} times · confirmed {days} days ago',
  'lessons.cause': 'Cause: {cause}',
  'lessons.failed': 'Lessons request failed',
  'lessons.reload': 'Reload lessons',
}
