/**
 * Every word the plugin's client half shows a person, in the three languages it
 * ships. The tables in `view.ts` and `settings.ts` stay where they are — they are
 * the runtime's English fallback and their key types are what makes a missing
 * translation a compile error here:
 *
 * `en` is the merge of both halves (`settings.ts` first, the panel last — the
 * order the runtime registration registers it), `UiKey` is the union of both key
 * types, and all three tables are declared `Record<UiKey, string>` — as an
 * annotated object literal, so the compiler reads every key of the union off the
 * literal itself and a key that exists in one language and not another does not
 * build.
 *
 * Composed here rather than at the registration site, so the merge sits at the
 * source of the two halves and is read against their own key types. That is a
 * preference, not the gate: the gate is whichever form a table is written in,
 * and both forms the translation tasks use — the annotated literal above and
 * `{ … } satisfies Record<UiKey, string>` — reject a short table the same way
 * (probed: identical `TS2740`, `… and 266 more`).
 *
 * The `zh` and `ru` tables are authored by the maintainers, not by a native
 * speaker, and are pending review: see the release notes for 0.2.0.
 *
 * @module src/client/locales/ui
 */

import { EN, NS } from '../settings.ts'
import type { LocaleKey as SettingsLocaleKey } from '../settings.ts'
import type { TabLocale } from '../tab-locale.ts'
import { en as viewEn } from '../view.ts'
import type { LocaleKey as ViewLocaleKey, Translate } from '../view.ts'

/** Every key the `settings.projectMcp` namespace carries. */
export type UiKey = ViewLocaleKey | SettingsLocaleKey

/**
 * The merged English table, built on first read rather than at module
 * evaluation. `settings.ts` imports this module for {@link uiTranslate} while
 * this module imports `EN` from `settings.ts`, so which of the two evaluates
 * first depends on the entry point — and a spread of the not-yet-initialized
 * half would silently drop every settings key from the fallback. Deferring the
 * merge past module evaluation keeps the table complete in either order.
 */
let english: Record<UiKey, string> | undefined
function mergedEnglish(): Record<UiKey, string> {
  return (english ??= { ...EN, ...viewEn })
}

/** English, and the runtime fallback for any language that lacks a key. */
export const en: Record<UiKey, string> = new Proxy({} as Record<UiKey, string>, {
  get: (_target, property) => Reflect.get(mergedEnglish(), property),
  has: (_target, property) => Reflect.has(mergedEnglish(), property),
  ownKeys: () => Reflect.ownKeys(mergedEnglish()),
  getOwnPropertyDescriptor: (_target, property) =>
    Object.getOwnPropertyDescriptor(mergedEnglish(), property),
})

/**
 * Chinese, complete across the namespace: every key of `UiKey` is written out
 * below — the view half (the tab and its blocks) first, then the settings half
 * in `settings.ts` order — so the `Record<UiKey, string>` annotation itself
 * proves completeness. Its key order is the canonical one for future
 * additions.
 */
export const zh: Record<UiKey, string> = {
  // The tab itself: its label in the sidebar and the line under it.
  tab: '项目 MCP',
  tabDescription: '各项目声明的 MCP 服务器，以及为其会话挂载的内容',
  sync: '同步',
  retryFailed: '重试失败项',
  // Tool presentation: the tab's tools block and the settings page's Tools rows.
  toolsSeeModel: '模型所见',
  toolsPinned: '已置顶',
  toolsByCounters: '按计数器',
  toolsDisclosed: '已披露',
  toolsHidden: '已隐藏',
  toolsNotMounted: '暂无可隐藏的工具',
  toolsNotMountedHint:
    '惰性挂载：项目的服务器在会话的第一步才启动，因此工具目录在此之前为空',
  toolsNotMountedCode: 'tools[] = built-ins only · mcp__* not registered yet',
  // The declared servers of this session, on the tools block: the reason an
  // apparently empty catalog is empty.
  toolsServers: '服务器',
  toolsServersUp: '{up}/{total} 运行中',
  toolsGroupPinned: '已置顶 · 始终在请求中',
  toolsGroupCounters: '由计数器提供',
  toolsGroupDisclosed: '由模型披露 · 直至会话结束',
  toolsGroupHidden: '已隐藏',
  toolsPin: '置顶',
  toolsPinHint: '让此工具保留在此项目的每次请求中',
  toolsUnpin: '取消置顶',
  toolsUnpinHint: '取消在此项目的每次请求中置顶此工具',
  toolsHide: '隐藏',
  toolsHideHint: '放弃此次披露，不再提供此工具',
  toolsHiddenVia: '模型只能通过 mcp_search_tools 使用',
  // The tools block's own filter (F-43): the counter chips above the list stop
  // being a reading and become the tier switch, and a query narrows by name.
  toolsFilterPlaceholder: '按名称过滤…',
  toolsFilterLabel: '按注册表名过滤此会话的工具',
  toolsFilterTier: '只显示此层级；再按一次显示全部层级',
  toolsFilterClear: '清除',
  toolsFilterClearHint: '显示全部层级并清空查询',
  toolsFilterShown: '显示 {shown}/{total}',
  toolsFilterNone: '此会话没有符合过滤条件的工具。',
  // The server-level pin (F-44): one press for a whole server's names, since a
  // server is how the hidden tier and the settings page both group them.
  toolsPinAll: '全部置顶',
  toolsPinAllHint: '在每次请求中置顶此服务器的所有隐藏工具',
  // The other direction of the same press, said by both surfaces when the set
  // is already wholly pinned.
  toolsUnpinAll: '全部取消置顶',
  toolsUnpinAllHint: '取消置顶此服务器的所有隐藏工具',
  // The same press on the pinned tier, where the names it releases are the ones
  // the user pinned rather than the ones the host hid.
  toolsUnpinServerHint: '取消置顶此服务器的所有工具',
  toolsBudget: '{used}/{total} 字符 · ≈ {tokens} token',
  toolsBudgetExhausted: '预算已用尽：后续披露将被拒绝并说明原因',
  toolsBudgetFree: '腾出预算空间，或在项目设置中置顶此工具',
  toolsBudgetGateOff: '披露门控已关闭：所有已挂载的工具都会进入请求',
  toolsBudgetBreakdown: '{used}/{total}（{percent}%）',
  toolsModeOff: '此项目的 MCP 工具已关闭',
  toolsModeOffCounters: '已挂载 {mounted} 个 · 均未提供',
  toolsModeOffHint:
    '此项目的工具都不会提供给模型。在「工具」页将模式设为「披露」即可重新提供。',
  toolsModeDirect: '全部直接：所有已挂载的工具都会进入请求',
  toolsPresentationOwner: '另一个插件正在主导请求的呈现',
  toolsOtherOwner: '其他呈现所有者',
  toolsDemo: '演示',
  toolsStep: '第 {step} 步',
  // The host's own usage counters: how often one tool was called, and how
  // long one server has gone unused.
  callsOne: '1 次调用',
  callsMany: '{count} 次调用',
  callsNone: '从未调用',
  callsProject: '项目中 {count} 次',
  idleDay: '闲置 {count} 天',
  idleHour: '闲置 {count} 小时',
  idleMinute: '闲置 {count} 分钟',
  // One tool row's detail block: registry name, server, tier.
  toolServer: '服务器 {server}',
  toolTierPinned: '已置顶',
  toolTierSession: '经由：会话',
  toolTierContext: '经由：上下文',
  showTool: '显示此工具的注册表名及其提供方式',
  hideTool: '隐藏此工具的注册表名',
  // The errors and logs blocks, under their own disclosures: the event ring is
  // the plugin's own, one project at a time.
  errorsSection: '问题',
  showErrors: '显示需要查看的服务器',
  hideErrors: '隐藏需要查看的服务器',
  logsSection: '日志',
  showLogs: '显示此项目的事件',
  hideLogs: '隐藏此项目的事件',
  logsThisSession: '本会话',
  logsAllSessions: '全部会话',
  logsAllLevels: '全部级别',
  logsErrorsOnly: '错误',
  logsLevelInfo: 'info',
  logsLevelUp: 'up',
  logsLevelWarn: 'warn',
  logsLevelError: 'error',
  logsClear: '清除',
  logsClearHint: '隐藏目前已记录的所有事件；新事件仍会出现',
  logsEmptyTitle: '暂无事件',
  logsEmptyHint:
    '项目的服务器会在会话的第一步启动，或在你按下「同步」时启动；挂载、启动和停止都会显示在这里。',
  logsNoErrorsTitle: '没有错误',
  logsNoErrorsHint:
    '本项目的事件环中存有其他事件；把级别过滤器切到「全部级别」即可查看。',
  logsMore: '显示更早',
  logsMoreHint: '加载比当前屏幕上更早的事件',
  logsShown: '显示 {shown}/{total}',
  logsProjectCount: '本项目 {count} 条',
  logsLoading: '正在加载更早的事件…',
  logsLoadFailed: '无法读取更早的事件',
  // The tab's own states, in the same table for the same reason.
  noSession: '此标签页没有关联会话。',
  noSessionHint: '面板读取的是它所在会话的项目。',
  noProject: '此会话的文件夹还不在任何项目内。',
  noProjectHint:
    '宿主会从此会话的 cwd 向上查找 .git · .dsh · .kimi-code · package.json · *.sln。',
  nothingNeedsAttention: '无需关注。',
  noServersDeclared: '此项目未声明任何 MCP 服务器。',
  noServersDeclaredHint: '添加 {documents}。',
  noServersDeclaredUnknown: '请向项目添加一份 MCP 文档。',
  noServersDeclaredNowhere:
    '此部署不读取任何项目文档，因此无处声明——请在插件配置（`localFiles`）中列出一个。',
  // Surface A's own header and the vocabulary its rows are built from. The
  // segment bar is gone (F-26): the toolbar names the project and carries one
  // phrase on its right edge, and every count a mode segment used to badge lives
  // on the block it describes.
  thisSession: '本会话',
  noProjectLabel: '无项目',
  retry: '重试',
  retryHint: '立即重试此项目失败的挂载',
  sessionsSection: '会话',
  // The `sessions` section is the project's *disagreement* view: its chip counts
  // the sessions whose own reading differs from the merged rows, not the
  // sessions that exist.
  differsOne: '1 个会话不一致',
  differsMany: '{count} 个会话不一致',
  sessionsOne: '1 个会话',
  sessionsMany: '{count} 个会话',
  serversOne: '1 个服务器',
  serversMany: '{count} 个服务器',
  mergedAcrossSessions: '跨会话合并',
  release: '释放',
  nothingDeclared: '无声明',
  showSessions: '显示此项目的会话',
  hideSessions: '隐藏此项目的会话',
  showSession: '显示此会话的服务器',
  hideSession: '隐藏此会话的服务器',
  mountedPerProject: '按项目挂载',
  projectsCount: '{count} 个项目',
  nothingMounted: '尚未挂载任何内容。',
  // The status vocabulary (F-47): the word a row wears and the one-line
  // explanation its tooltip carries.
  statusActive: '运行中',
  statusConnecting: '连接中',
  statusConflict: '冲突',
  statusError: '错误',
  statusIdle: '闲置',
  statusDisabled: '已禁用',
  statusHintActive: '已挂载，其工具在本会话中可见',
  statusHintConnecting: '已挂载，尚未发布任何工具',
  statusHintIdle: '已声明但未挂载——将在下一轮挂载',
  statusHintDisabled: '以 enabled: false 声明',
  statusHintConflict: '同名 serverName 已被配置文件级实例占用',
  statusHintError: '查看详情',
  // The status line of a project or session: one template per status, the
  // count always a `{count}` placeholder.
  summaryActive: '{count} 个运行中',
  summaryConnecting: '{count} 个连接中',
  summaryIdle: '{count} 个闲置',
  summaryDisabled: '{count} 个已禁用',
  summaryError: '{count} 个错误',
  summaryConflict: '{count} 个冲突',
  summaryNone: '无声明',
  close: '关闭',
  // The frame-wide toasts (F-47): one keyed line per lifecycle moment, and the
  // quieter line weaving the project around the fact behind it.
  toastUp: '{server} 已启动',
  toastFailed: '{server} 失败',
  toastReleased: '{server} 已释放',
  toastDetail: '{project} · {detail}',
  // The sidebar plugin toggle: the poll interval's row in the tab's settings.
  refreshTitle: '刷新间隔',
  refreshDesc: '面板重新读取宿主快照的频率',
  // The design stand's own tab title and description.
  designTitle: '项目 MCP · 设计 ({variant})',
  designDesc: '设计模式：{variant} 夹具，背后没有宿主',
  // Settings half, in `settings.ts` order: the overview table, its states and
  // the read-only reasons of its rows.
  project: '项目',
  projectsOne: '1 个项目有活动会话',
  projectsMany: '{count} 个项目有活动会话',
  viewTable: '表格',
  viewFiles: '按文件',
  syncHint: '立即重新读取宿主快照',
  server: '服务器',
  transport: '传输',
  status: '状态',
  source: '来源',
  on: '开',
  servers: '服务器',
  paneEntry: '条目',
  name: '名称',
  detail: '详情',
  loading: '正在读取宿主快照…',
  loadingHint: '页面一打开就会轮询 /project-mcp/snapshot。',
  hostUnavailable: '页面没有收到插件宿主的应答。',
  hostUnavailableHint:
    '宿主侧提供 {route}；它只在 dsh web 重启后才拾取变更——请查看日志。',
  noSessions: '还没有会话关联到任何项目。',
  noSessionsHint:
    '当会话开始在项目文件夹内工作时服务器才会启动——没有会话的项目不会挂载任何内容。',
  noSessionsPaths: '读取：{paths}',
  noSessionsNoPaths:
    '此部署不读取任何 MCP 文档——请在插件配置（`localFiles`、`globalFiles`）中列出要读取的文档',
  noServers: '此项目未声明任何 MCP 服务器。',
  noServersHint: '没有任何声明，因此不会为其会话挂载任何内容。',
  noServersNoPath: '此部署不读取任何项目文档，因此无处声明。',
  documentUnknown: '声明文档未知',
  global: '全局',
  priority: '优先级 {tier}/{total}',
  overrideFrom: '↳ 覆盖来自 {from} 的 {name}',
  overrideUnpinned: '↳ 覆盖在更低优先级文档中声明的 {name}',
  nameReason: '只读：服务器名是宿主报告的声明键。',
  statusReason: '只读：状态来自运行中的宿主，而非文档。',
  sourceReason: '只读：声明文档的路径来自宿主。',
  detailReason: '只读：宿主会隐去这段文本，且从不包含参数。',
  openToEdit: '此处只读：打开服务器以编辑其条目。',
  rowActionsMore: '…',
  rowActionsHint: '在编辑器中打开此条目',
  showJson: '显示 JSON',
  hideJson: '隐藏 JSON',
  jsonPreview: '快照 JSON',
  jsonPreviewHint: '读取自宿主快照；磁盘上的文档不会被触碰。',
  back: '返回列表',
  backHint: '返回概览，不做任何更改',
  // Editor: the fields of the parsed entry.
  entryUnavailable: '宿主未能解析此条目，因此没有可编辑的内容。',
  commandField: '命令',
  argsField: '参数',
  cwdField: 'CWD',
  urlField: 'URL',
  envField: 'Env',
  headersField: '请求头',
  enabledField: '启用',
  timeoutField: '超时',
  keyField: '键',
  valueField: '值',
  argsHint: '每行一个参数；每一行都原样写入。',
  envHint: '每个键一个值；表单中删去的键会从条目中移除。',
  headersHint: '每个请求头一个值；表单中删去的键会从条目中移除。',
  timeoutHint: '毫秒；留空表示声明不设置超时。',
  enabledValue: '启用：{value}',
  absent: '未设置',
  maskedValue: '•••• 未更改——输入以替换',
  valuePlaceholder: '值',
  keyPlaceholder: 'KEY',
  credentialsNote:
    '来自外部来源——项目的 .env 或凭据文件——而非此文档：它会被原样显示并原样写回。',
  credentialValue: '来自项目的 .env 或凭据文件',
  addKey: '添加键',
  addKeyHint: '追加一个空键；未命名的键不会被写入。',
  removeKey: '✕',
  removeKeyHint: '删去此键；被删去的键会从条目中移除。',
  // Writing.
  editableNote:
    '正在编辑 {document}：「保存」会要求确认、先备份到 {backup} 并整体重写该条目。',
  writeBlocked: '只读：{reason}',
  writeBlockedUnknown: '宿主未报告此文档为何不可写入。',
  save: '保存…',
  saveHint: '打开此次写入的确认',
  saveNoChange: '还没有可保存的更改。',
  saveUnavailable: '快照没有携带可写回的声明文档或修订版本。',
  saveTimeoutInvalid: '超时不是以毫秒为单位的整数。',
  saving: '正在写入…',
  discard: '放弃',
  discardHint: '从快照恢复所有字段，不写入任何内容',
  discardReason: '还没有可恢复的更改。',
  unsaved: '未保存',
  jsonDiff: 'diff',
  jsonClean: '无更改',
  jsonUnavailable: '无已解析的条目',
  jsonInvalid: 'JSON 无法解析为条目：{reason}',
  jsonEditHint: '按文档声明的形式编辑条目',
  saveJsonInvalid: '请先修复 JSON 窗格：它无法解析为条目。',
  footerWrite: '→ {document} · .bak 副本 · 确认',
  footerReadonly: '→ {document} · 只读',
  confirmTitle: '写入 {document}？',
  confirmBackup: '当前文档会先被复制到 {backup}。',
  confirmFormat:
    '该条目会整体替换 mcpServers[{server}]。文档将以两空格缩进和末尾换行重新序列化，因此文档其余部分的缩进和键顺序会被规范化。',
  confirmConsent:
    '这是一个全局文档：每个项目都会读取它，因此写入需要明确同意。',
  consentLabel: '我理解这会重写一个所有项目共享的全局文档。',
  confirmWrite: '写入文档',
  confirmWriteHint: '通过上述检查后写入文档',
  confirmBlocked: '请先勾选同意框：没有它的全局写入会被拒绝。',
  cancel: '取消',
  saveOk: '已保存：文档已写入并重新读取。',
  saveErrorInvalid:
    '宿主拒绝了该条目：它不是此插件会挂载的条目。未写入任何内容。',
  saveErrorBlocked:
    '此层级不允许写入该文档，或缺少同意。未写入任何内容。',
  saveErrorConflict: '自此快照取得以来文档已更改。未写入任何内容。',
  saveErrorNotFound: '文档或服务器已不存在。未写入任何内容。',
  saveErrorFailed: '写入本身失败；文档保持原样。未写入任何内容。',
  hostMessage: '宿主返回：{message}',
  reRead: '重新读取',
  reReadHint: '重新获取宿主快照并据此重建表单',
  // Our own two pages, and the disclosure policy page next to `Servers`.
  tabServers: '服务器',
  tabTools: '工具',
  policyNote: '此项目遵循的模式，以及为它置顶的工具',
  checkConflicts: '检查冲突',
  checkConflictsHint:
    '宿主为此项目报告的冲突服务器名读取自其快照；此按钮会立即重新读取快照',
  conflictsNone: '此项目没有冲突的服务器名',
  conflictProfile: '配置文件级名称',
  conflictDuplicate: '重复声明',
  conflictSources: '声明于 {sources}',
  choiceLabel: '显示',
  choiceLocal: '此项目的副本，作为 {alias}',
  choiceProfileHint: '保持配置文件实例的工具原样不变',
  choiceLocalHint:
    '将此项目自己的声明挂载在配置文件声明旁边，使用本地名 {alias}',
  choiceNative: '此项目的声明，使用其自身名称',
  choiceNativeHint:
    '将此项目自己的声明按其声明的名称挂载：它在此项目中更近，因此在此它会遮蔽配置文件实例的工具，而其他所有项目仍照常看到它们',
  choiceRefused: '宿主拒绝了该选择：',
  toolsCount: '工具',
  pinned: '已置顶',
  mode: '模式',
  modeDisclosure: '披露',
  modeDirect: '全部直接',
  modeOff: 'off',
  modeHint: '立即写入，在宿主组装的下一个请求上生效',
  modeRefused: '宿主拒绝了该模式：',
  pinRefused: '宿主拒绝了该置顶：',
  pinList: '已置顶 · 手写维护，在每次请求中提供',
  pinListEmpty: '还没有置顶——在下方工具列表中开启一个',
  serverAllOffered: '其全部 {count} 个工具都直接提供',
  serverPartlyOffered: '{total} 个工具中 {offered} 个直接提供',
  // The server-level pin (F-44): one switch for the whole server row, above the
  // per-name rows it stands for.
  serverPin: '置顶此服务器的工具',
  serverPinHint: '置顶此服务器挂载的每个工具——包括隐藏的——让每个请求都携带它们',
  serverUnpin: '取消置顶此服务器的工具',
  serverUnpinHint: '停止置顶此服务器的工具',
  prefixFact: 'mcp__<server>__<tool>；前缀由注册表添加，而非本页',
  pinTag: 'pin',
  moreTools: '… 还有 {count} 个',
  requestPreview: '请求预览',
  requestPreviewTools: 'tools[] = {count}',
  requestPreviewTokens: '≈ {tokens} token',
  requestPreviewHidden: '已隐藏 {count} 个',
  requestPreviewSaved: '已隐藏 {count} 个 · 节省 ≈ {tokens} token',
  requestPreviewNoOffer: '此会话尚未向模型提供任何工具',
}

/**
 * Russian, complete across the namespace: every key of `UiKey` is written out
 * below, so the `Record<UiKey, string>` annotation itself proves completeness.
 */
export const ru: Record<UiKey, string> = {
  // The tab itself: its label in the sidebar and the line under it.
  tab: 'MCP проекта',
  tabDescription:
    'MCP-серверы, которые объявляет проект, и что смонтировано для его сессий',
  sync: 'Синхронизировать',
  retryFailed: 'Повторить неудачные',
  // Tool presentation: the tab's tools block and the settings page's Tools rows.
  toolsSeeModel: 'что видит модель',
  toolsPinned: 'закреплённые',
  toolsByCounters: 'по счётчикам',
  toolsDisclosed: 'раскрытые',
  toolsHidden: 'скрытые',
  toolsNotMounted: 'Пока скрывать нечего',
  toolsNotMountedHint:
    'ленивое монтирование: серверы проекта поднимаются на первом шаге сессии, поэтому каталог пока пуст',
  toolsNotMountedCode: 'tools[] = built-ins only · mcp__* not registered yet',
  // The declared servers of this session, on the tools block.
  toolsServers: 'Серверы',
  toolsServersUp: '{up}/{total} работают',
  toolsGroupPinned: 'закреплённые · всегда в запросе',
  toolsGroupCounters: 'предлагаются счётчиками',
  toolsGroupDisclosed: 'раскрыты моделью · до конца сессии',
  toolsGroupHidden: 'скрытые',
  toolsPin: 'Закрепить',
  toolsPinHint: 'Держать этот инструмент в каждом запросе проекта',
  toolsUnpin: 'Открепить',
  toolsUnpinHint: 'Больше не закреплять этот инструмент в запросах проекта',
  toolsHide: 'Скрыть',
  toolsHideHint: 'Снять это раскрытие и перестать предлагать инструмент',
  toolsHiddenVia: 'доступен модели только через mcp_search_tools',
  // The tools block's own filter: the tier switch and the name query.
  toolsFilterPlaceholder: 'фильтр по имени…',
  toolsFilterLabel: 'фильтр инструментов сессии по имени в реестре',
  toolsFilterTier: 'Показать только этот уровень; ещё раз — все уровни',
  toolsFilterClear: 'Сбросить',
  toolsFilterClearHint: 'Показать все уровни и убрать запрос',
  toolsFilterShown: 'показано {shown} из {total}',
  toolsFilterNone: 'Ни один инструмент сессии не подходит под фильтр.',
  // The server-level pin: one press for a whole server's names.
  toolsPinAll: 'Закрепить все',
  toolsPinAllHint: 'Закрепить каждый скрытый инструмент этого сервера в каждом запросе',
  // The other direction of the same press.
  toolsUnpinAll: 'Открепить все',
  toolsUnpinAllHint: 'Открепить все скрытые инструменты этого сервера',
  // The same press on the pinned tier.
  toolsUnpinServerHint: 'Открепить все инструменты этого сервера',
  toolsBudget: '{used} симв. из {total} · ≈ {tokens} токенов',
  toolsBudgetExhausted: 'бюджет исчерпан: дальнейшие раскрытия отклоняются с указанием причины',
  toolsBudgetFree: 'освободите место в бюджете или закрепите инструмент в настройках проекта',
  toolsBudgetGateOff: 'контроль раскрытий выключен: каждый смонтированный инструмент попадает в запрос',
  toolsBudgetBreakdown: '{used} из {total} ({percent}%)',
  toolsModeOff: 'MCP-инструменты этого проекта выключены',
  toolsModeOffCounters: 'смонтировано: {mounted} · не предлагаются',
  toolsModeOffHint:
    'Ничто из этого проекта не предлагается модели. Включите режим «Раскрытие» на странице инструментов, чтобы снова их предлагать.',
  toolsModeDirect: 'ничего не откладывается: каждый смонтированный инструмент попадает в запрос',
  toolsPresentationOwner: 'Другой плагин формирует запрос',
  toolsOtherOwner: 'Другой владелец представления',
  toolsDemo: 'демо',
  toolsStep: 'шаг {step}',
  // The host's own usage counters: how often one tool was called, and how
  // long one server has gone unused.
  callsOne: '1 вызов',
  callsMany: 'вызовов: {count}',
  callsNone: 'ни разу не вызывался',
  callsProject: '{count} в проекте',
  idleDay: 'простой {count}д',
  idleHour: 'простой {count}ч',
  idleMinute: 'простой {count}мин',
  // One tool row's detail block: registry name, server, tier.
  toolServer: 'сервер {server}',
  toolTierPinned: 'закреплён',
  toolTierSession: 'через: сессия',
  toolTierContext: 'через: контекст',
  showTool: 'показать имя инструмента в реестре и способ предложения',
  hideTool: 'скрыть имя инструмента в реестре',
  // The errors and logs blocks, under their own disclosures.
  errorsSection: 'Проблемы',
  showErrors: 'показать серверы, требующие внимания',
  hideErrors: 'скрыть серверы, требующие внимания',
  logsSection: 'Журнал',
  showLogs: 'показать события проекта',
  hideLogs: 'скрыть события проекта',
  logsThisSession: 'эта сессия',
  logsAllSessions: 'все сессии',
  logsAllLevels: 'все уровни',
  logsErrorsOnly: 'ошибки',
  logsLevelInfo: 'info',
  logsLevelUp: 'up',
  logsLevelWarn: 'warn',
  logsLevelError: 'error',
  logsClear: 'Очистить',
  logsClearHint: 'Скрыть все записанные события; новые всё равно появятся',
  logsEmptyTitle: 'Событий пока нет',
  logsEmptyHint:
    'Серверы проекта поднимаются на первом шаге сессии или при нажатии «Синхронизировать»; монтирование, запуск и остановка появятся здесь.',
  logsNoErrorsTitle: 'Ошибок нет',
  logsNoErrorsHint:
    'Кольцо проекта содержит другие события; переключите фильтр уровней на «все уровни», чтобы их увидеть.',
  logsMore: 'Показать более ранние',
  logsMoreHint: 'Загрузить события старше показанных',
  logsShown: 'показано {shown} из {total}',
  logsProjectCount: '{count} в этом проекте',
  logsLoading: 'загрузка старых событий…',
  logsLoadFailed: 'старые события не удалось прочитать',
  // The tab's own states.
  noSession: 'К этой вкладке не привязана сессия.',
  noSessionHint: 'Панель читает проект сессии, в которой открыта.',
  noProject: 'Папка этой сессии пока не входит в проект.',
  noProjectHint:
    'Хост поднимается от cwd сессии в поисках .git · .dsh · .kimi-code · package.json · *.sln.',
  nothingNeedsAttention: 'Внимания не требуется.',
  noServersDeclared: 'Этот проект не объявляет MCP-серверы.',
  noServersDeclaredHint: 'Добавьте {documents}.',
  noServersDeclaredUnknown: 'Добавьте в проект MCP-документ.',
  noServersDeclaredNowhere:
    'Эта установка не читает документы проекта, так что объявлять некуда — укажите один в конфигурации плагина (`localFiles`).',
  // Surface A's own header and the vocabulary its rows are built from.
  thisSession: 'эта сессия',
  noProjectLabel: 'нет проекта',
  retry: 'Повторить',
  retryHint: 'Повторить неудачные монтирования проекта сейчас',
  sessionsSection: 'сессии',
  // The `sessions` section is the project's *disagreement* view.
  differsOne: '1 расходится',
  differsMany: '{count} расходятся',
  sessionsOne: '1 сессия',
  sessionsMany: 'сессий: {count}',
  serversOne: '1 сервер',
  serversMany: 'серверов: {count}',
  mergedAcrossSessions: 'объединено между сессиями',
  release: 'Освободить',
  nothingDeclared: 'ничего не объявлено',
  showSessions: 'показать сессии этого проекта',
  hideSessions: 'скрыть сессии этого проекта',
  showSession: 'показать серверы этой сессии',
  hideSession: 'скрыть серверы этой сессии',
  mountedPerProject: 'Смонтировано по проектам',
  projectsCount: '{count} проект(ов)',
  nothingMounted: 'Пока ничего не смонтировано.',
  // The status vocabulary (F-47): the word a row wears and the one-line
  // explanation its tooltip carries.
  statusActive: 'активен',
  statusConnecting: 'подключается',
  statusConflict: 'конфликт',
  statusError: 'ошибка',
  statusIdle: 'простой',
  statusDisabled: 'отключён',
  statusHintActive: 'смонтирован, его инструменты видны в этой сессии',
  statusHintConnecting: 'смонтирован, инструменты ещё не опубликованы',
  statusHintIdle: 'объявлен, но не смонтирован — смонтируется на следующем шаге',
  statusHintDisabled: 'объявлен с enabled: false',
  statusHintConflict: 'то же имя serverName занято экземпляром уровня профиля',
  statusHintError: 'см. подробности',
  // The status line of a project or session: one template per status, the
  // count always a `{count}` placeholder. The counted forms are the genitive
  // plural or an invariant construction — the documented 2–4 compromise.
  summaryActive: '{count} активных',
  summaryConnecting: '{count} подключающихся',
  summaryIdle: '{count} в простое',
  summaryDisabled: '{count} отключено',
  summaryError: '{count} с ошибкой',
  summaryConflict: '{count} в конфликте',
  summaryNone: 'ничего не объявлено',
  close: 'Закрыть',
  // The frame-wide toasts (F-47): one keyed line per lifecycle moment, and the
  // quieter line weaving the project around the fact behind it.
  toastUp: '{server} поднят',
  toastFailed: '{server}: сбой',
  toastReleased: '{server} освобождён',
  toastDetail: '{project} · {detail}',
  // The sidebar plugin toggle: the poll interval's row in the tab's settings.
  refreshTitle: 'Интервал обновления',
  refreshDesc: 'Как часто панель перечитывает снимок хоста',
  // The design stand's own tab title and description.
  designTitle: 'MCP проекта · дизайн ({variant})',
  designDesc: 'режим дизайна: фикстура {variant}, хоста за ней нет',
  // Settings half, in `settings.ts` order: the overview table, its states and
  // the read-only reasons of its rows.
  project: 'Проект',
  projectsOne: '1 проект с активной сессией',
  projectsMany: 'проектов с активными сессиями: {count}',
  viewTable: 'Таблица',
  viewFiles: 'По файлам',
  syncHint: 'Перечитать снимок хоста сейчас',
  server: 'Сервер',
  transport: 'Транспорт',
  status: 'Статус',
  source: 'Источник',
  on: 'Вкл',
  servers: 'Серверы',
  paneEntry: 'Запись',
  name: 'Имя',
  detail: 'Подробности',
  loading: 'Чтение снимка хоста…',
  loadingHint: 'Страница опрашивает /project-mcp/snapshot сразу после открытия.',
  hostUnavailable: 'Страница не получила ответа от хоста плагина.',
  hostUnavailableHint:
    'Хостовая половина обслуживает {route}; изменения она подхватывает только после перезапуска dsh web — проверьте журнал.',
  noSessions: 'К проекту пока не привязана ни одна сессия.',
  noSessionsHint:
    'Серверы поднимаются, когда сессия начинает работать в папке проекта, — без сессии для проекта ничего не монтируется.',
  noSessionsPaths: 'читаются: {paths}',
  noSessionsNoPaths:
    'эта установка не читает ни одного MCP-документа — перечислите документы для чтения в конфигурации плагина (`localFiles`, `globalFiles`)',
  noServers: 'Этот проект не объявляет MCP-серверы.',
  noServersHint: 'Ничего не объявлено, поэтому для его сессий ничего не монтируется.',
  noServersNoPath: 'Эта установка не читает документы проекта, так что объявлять некуда.',
  documentUnknown: 'документ объявления неизвестен',
  global: 'глобальный',
  priority: 'приоритет {tier}/{total}',
  overrideFrom: '↳ переопределяет {name} из {from}',
  overrideUnpinned: '↳ переопределяет {name}, объявленное в документе с более низким приоритетом',
  nameReason: 'Только чтение: имя сервера — ключ объявления, который сообщает хост.',
  statusReason: 'Только чтение: статус приходит от работающего хоста, а не из документа.',
  sourceReason: 'Только чтение: путь объявляющего документа приходит от хоста.',
  detailReason: 'Только чтение: хост скрывает этот текст и никогда не включает аргументы.',
  openToEdit: 'Здесь только чтение: откройте сервер, чтобы изменить его запись.',
  rowActionsMore: '…',
  rowActionsHint: 'Открыть эту запись в редакторе',
  showJson: 'Показать JSON',
  hideJson: 'Скрыть JSON',
  jsonPreview: 'JSON снимка',
  jsonPreviewHint: 'Читается из снимка хоста; документ на диске не затрагивается.',
  back: 'Назад к списку',
  backHint: 'Вернуться к обзору, ничего не меняя',
  // Editor: the fields of the parsed entry.
  entryUnavailable: 'Хост не смог разобрать эту запись, так что редактировать нечего.',
  commandField: 'Команда',
  argsField: 'Аргументы',
  cwdField: 'CWD',
  urlField: 'URL',
  envField: 'Env',
  headersField: 'Заголовки',
  enabledField: 'Включён',
  timeoutField: 'Таймаут',
  keyField: 'Ключ',
  valueField: 'Значение',
  argsHint: 'Один аргумент на строку; каждая строка записывается как есть.',
  envHint: 'Одно значение на ключ; ключ, убранный в форме, удаляется из записи.',
  headersHint: 'Одно значение на заголовок; заголовок, убранный в форме, удаляется из записи.',
  timeoutHint: 'Миллисекунды; пусто — объявление не задаёт таймаут.',
  enabledValue: 'включён: {value}',
  absent: 'отсутствует',
  maskedValue: '•••• без изменений — введите текст, чтобы заменить',
  valuePlaceholder: 'значение',
  keyPlaceholder: 'KEY',
  credentialsNote:
    'Приходит из внешнего источника — из .env проекта или файла учётных данных, — а не из этого документа: показывается и записывается обратно без изменений.',
  credentialValue: 'из .env проекта или файла учётных данных',
  addKey: 'Добавить ключ',
  addKeyHint: 'Добавить пустой ключ; безымянный ключ не записывается.',
  removeKey: '✕',
  removeKeyHint: 'Убрать этот ключ; убранный ключ удаляется из записи.',
  // Writing.
  editableNote:
    'Редактируется {document}: «Сохранить» попросит подтверждение, сохранит резервную копию в {backup} и перезапишет запись целиком.',
  writeBlocked: 'Только чтение: {reason}',
  writeBlockedUnknown: 'хост не сообщил, почему этот документ нельзя записывать.',
  save: 'Сохранить…',
  saveHint: 'Открыть подтверждение этой записи',
  saveNoChange: 'Пока нечего сохранять.',
  saveUnavailable: 'В снимке нет ни объявляющего документа, ни ревизии, в которую можно было бы записать.',
  saveTimeoutInvalid: 'Таймаут — не целое число миллисекунд.',
  saving: 'Запись…',
  discard: 'Отменить',
  discardHint: 'Восстановить все поля из снимка и ничего не записывать',
  discardReason: 'Пока нечего восстанавливать.',
  unsaved: 'не сохранено',
  jsonDiff: 'diff',
  jsonClean: 'нет изменений',
  jsonUnavailable: 'нет разобранной записи',
  jsonInvalid: 'JSON не разбирается в запись: {reason}',
  jsonEditHint: 'Редактировать запись в том виде, в каком её объявляет документ',
  saveJsonInvalid: 'Сначала исправьте панель JSON: она не разбирается в запись.',
  footerWrite: '→ {document} · копия .bak · подтверждение',
  footerReadonly: '→ {document} · только чтение',
  confirmTitle: 'Записать {document}?',
  confirmBackup: 'Сначала текущий документ копируется в {backup}.',
  confirmFormat:
    'Запись заменяет mcpServers[{server}] целиком. Документ сериализуется заново с отступом в два пробела и завершающим переводом строки, поэтому отступы и порядок ключей в остальной части документа нормализуются.',
  confirmConsent:
    'Это глобальный документ: его читает каждый проект, поэтому запись требует явного согласия.',
  consentLabel: 'Я понимаю, что это перезапишет глобальный документ, общий для всех проектов.',
  confirmWrite: 'Записать документ',
  confirmWriteHint: 'Записать документ после проверок выше',
  confirmBlocked: 'Сначала отметьте согласие: глобальная запись без него отклоняется.',
  cancel: 'Отмена',
  saveOk: 'Сохранено: документ записан и перечитан.',
  saveErrorInvalid:
    'Хост отклонил запись: этот плагин не стал бы монтировать такую. Ничего не записано.',
  saveErrorBlocked:
    'Документ нельзя записать на этом уровне, либо нет согласия. Ничего не записано.',
  saveErrorConflict: 'Документ изменился с момента снятия этого снимка. Ничего не записано.',
  saveErrorNotFound: 'Документа или сервера больше нет. Ничего не записано.',
  saveErrorFailed: 'Сама запись не удалась; документ оставлен как был. Ничего не записано.',
  hostMessage: 'Хост ответил: {message}',
  reRead: 'Перечитать',
  reReadHint: 'Заново запросить снимок хоста и перестроить по нему форму',
  // Our own two pages, and the disclosure policy page next to `Servers`.
  tabServers: 'Серверы',
  tabTools: 'Инструменты',
  policyNote: 'режим, которому следует проект, и закреплённые для него инструменты',
  checkConflicts: 'Проверить конфликты',
  checkConflictsHint:
    'конфликтующие имена серверов, которые хост сообщает для этого проекта, читаются из его снимка; кнопка перечитывает его сейчас',
  conflictsNone: 'в этом проекте нет конфликтующих имён серверов',
  conflictProfile: 'имя из профиля',
  conflictDuplicate: 'дубликат объявления',
  conflictSources: 'объявлено в {sources}',
  choiceLabel: 'показать',
  choiceLocal: 'копию этого проекта как {alias}',
  choiceProfileHint: 'оставить инструменты экземпляра профиля как есть',
  choiceLocalHint:
    'смонтировать собственное объявление этого проекта рядом с профильным, под локальным именем {alias}',
  choiceNative: 'объявление этого проекта под его собственным именем',
  choiceNativeHint:
    'смонтировать собственное объявление этого проекта под именем, которое оно объявляет: в этом проекте оно ближе, поэтому здесь оно затеняет инструменты экземпляра профиля, а все остальные проекты продолжают их видеть',
  choiceRefused: 'Хост отклонил выбор:',
  toolsCount: 'инструменты',
  pinned: 'Закреплённые',
  mode: 'Режим',
  modeDisclosure: 'раскрытие',
  modeDirect: 'все напрямую',
  modeOff: 'off',
  modeHint: 'записывается сразу, в следующий запрос, который соберёт хост',
  modeRefused: 'Хост отклонил режим:',
  pinRefused: 'Хост отклонил закрепление:',
  pinList: 'закреплённые · записаны вручную, предлагаются в каждом запросе',
  pinListEmpty: 'закреплений пока нет — включите одно в списке инструментов ниже',
  serverAllOffered: 'все {count} его инструментов предлагаются напрямую',
  serverPartlyOffered: '{offered} из {total} инструментов предлагаются напрямую',
  // The server-level pin (F-44): one switch for the whole server row, above the
  // per-name rows it stands for.
  serverPin: 'закрепить инструменты этого сервера',
  serverPinHint: 'Закрепить каждый инструмент, который монтирует этот сервер, — и скрытые тоже, — чтобы их нёс каждый запрос',
  serverUnpin: 'открепить инструменты этого сервера',
  serverUnpinHint: 'Перестать закреплять инструменты этого сервера',
  prefixFact: 'mcp__<server>__<tool>; префикс добавляет реестр, а не эта страница',
  pinTag: 'pin',
  moreTools: '… ещё {count}',
  requestPreview: 'предпросмотр запроса',
  requestPreviewTools: 'tools[] = {count}',
  requestPreviewTokens: '≈ {tokens} токенов',
  requestPreviewHidden: 'скрыто {count}',
  requestPreviewSaved: 'скрыто {count} · сэкономлено ≈ {tokens} токенов',
  requestPreviewNoOffer: 'эта сессия пока ничего не предложила',
}

/** English text for a key, with `{name}` placeholders substituted. */
export function uiFallback(key: string, params?: Record<string, unknown>): string {
  const template = (en as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  )
}

/**
 * A translator bound to this namespace that never shows a raw key when English
 * knows it.
 *
 * Both translate seats route through here — the sidebar tab's `tabTranslate`
 * and the settings page's label — so the fallback is one code path: the bound
 * seat answers first, and when it can only echo the key (the active language's
 * dictionary lacks it) the merged English table of this module answers instead.
 * A key even English lacks renders as itself — a documented last resort, made
 * unreachable by construction (compile-time completeness of the three tables,
 * plus the parity spec), not by hiding the branch.
 * @param locale - the shell's locale service, when there is one.
 * @returns a translate function that always answers.
 */
export function uiTranslate(locale: TabLocale | undefined): Translate {
  if (locale === undefined) return uiFallback
  let bound: Translate
  try {
    bound = locale.bind(NS) as Translate
  } catch {
    // A service that refuses the namespace leaves the surface its own English.
    return uiFallback
  }
  return (key, params) => {
    const text = bound(key, params)
    return text === key ? uiFallback(key, params) : text
  }
}
