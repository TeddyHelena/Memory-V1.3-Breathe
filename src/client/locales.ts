/** Locale bundles for the memory-container settings tab. */

/** Locale keys this surface renders. */
export type MemoryTabLocaleKey =
  | 'tab'
  /** 【C-2】侧边栏条目名（面板入口） */
  | 'panel'
  | 'loading'
  | 'error'
  | 'retry'
  | 'empty'
  | 'search'
  | 'emptySearch'
  | 'hot'
  | 'archive'
  | 'longterm'
  | 'pending'
  | 'confirm'
  | 'discard'
  | 'pendingHint'
  | 'pendingDone'
  | 'count'
  | 'back'
  | 'edit'
  | 'save'
  | 'saving'
  | 'cancel'
  | 'saved'
  | 'saveFailed'
  | 'title'
  | 'tags'
  | 'tag'
  | 'addTag'
  | 'priority'
  | 'updated'
  | 'summary'
  | 'content'
  | 'readOnly'
  | 'entryNotFound'
  | 'id'
  | 'viewSphere'
  | 'viewFlat'
  | 'viewList'
  | 'linkGroup'
  | 'linkTag'
  | 'scope'
  | 'source'
  | 'sourceSession'
  | 'sourceMessage'
  | 'createdAt'
  | 'validity'
  | 'from'
  | 'to'
  | 'supersededBy'
  | 'supersedes'
  | 'outsideScope'

/** English copy. */
export const en: Record<MemoryTabLocaleKey, string> = {
  tab: 'Memory',
  panel: 'Memory',
  loading: 'Loading memory container…',
  error: 'Failed to read the memory container.',
  retry: 'Retry',
  empty: 'The memory container is empty.',
  search: 'Search',
  emptySearch: 'No entries match your search.',
  hot: 'Hot',
  archive: 'Archive',
  longterm: 'Long-term',
  pending: 'Candidates (awaiting review)',
  confirm: 'Promote',
  discard: 'Discard',
  pendingHint: 'Model inferences land here; they never enter retrieval or hot injection until a human promotes them.',
  pendingDone: 'Done.',
  count: 'entries',
  back: 'Back',
  edit: 'Edit',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  saved: 'Saved.',
  saveFailed: 'The container rejected this change; nothing was written.',
  title: 'Title',
  tags: 'Tags',
  tag: 'tag',
  addTag: 'Add tag',
  priority: 'Priority',
  updated: 'Updated',
  summary: 'Summary',
  content: 'Content',
  readOnly: 'Read-only',
  entryNotFound: 'Entry not found.',
  id: 'ID',
  viewSphere: 'Sphere',
  viewFlat: 'Graph',
  viewList: 'List',
  linkGroup: 'group relation',
  linkTag: 'shared tag',
  scope: 'Scope',
  source: 'Source',
  sourceSession: 'Source session',
  sourceMessage: 'Source message',
  createdAt: 'Created',
  validity: 'Validity',
  from: 'from',
  to: 'to',
  supersededBy: 'Superseded by',
  supersedes: 'Supersedes',
  outsideScope: 'outside current scope',
}

/** Simplified Chinese copy. */
export const zh: Record<MemoryTabLocaleKey, string> = {
  tab: '记忆',
  panel: '记忆',
  loading: '正在读取记忆容器…',
  error: '读取记忆容器失败。',
  retry: '重试',
  empty: '记忆容器为空。',
  search: '搜索',
  emptySearch: '没有匹配的条目。',
  hot: '热记忆',
  archive: '归档',
  longterm: '长期',
  pending: '候选（待确认）',
  confirm: '转正',
  discard: '丢弃',
  pendingHint: '模型推断的内容先落在候选区：未转正前不进检索、不进常驻注入。',
  pendingDone: '已处理。',
  count: '条',
  back: '返回',
  edit: '编辑',
  save: '保存',
  saving: '保存中…',
  cancel: '取消',
  saved: '已保存。',
  saveFailed: '容器拒绝了这次修改，未写入任何内容。',
  title: '标题',
  tags: '标签',
  tag: '标签',
  addTag: '添加标签',
  priority: '优先级',
  updated: '更新日期',
  summary: '摘要',
  content: '正文',
  readOnly: '只读',
  entryNotFound: '条目不存在。',
  id: 'ID',
  viewSphere: '知识球',
  viewFlat: '关系图',
  viewList: '列表',
  linkGroup: '分组钩稽',
  linkTag: '共享标签',
  scope: '作用域',
  source: '来源',
  sourceSession: '来源会话',
  sourceMessage: '来源消息',
  createdAt: '创建时间',
  validity: '有效期',
  from: '从',
  to: '至',
  supersededBy: '被替代为',
  supersedes: '替代了',
  outsideScope: '不在当前作用域',
}
