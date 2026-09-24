/**
 * The `projectMcp.host` namespace: the wire contract for every message the
 * plugin's host half produces that a human can read (F-48).
 *
 * Host messages travel as `{ code, params, message }` — a dotted, stable code
 * plus its flat params for translation, and the English `message` always
 * present as the fallback. The keys below are the contract: a code, once
 * shipped, is never renamed, and rewording happens in dictionary values only.
 * That is why this namespace is separate from `settings.projectMcp`, whose
 * camelCase copy is reworded freely.
 *
 * The tables are declared `Record<HostCode, string>`, so the compiler reads
 * every code of the union off each literal and a table that lacks one does not
 * build — the same gate F-46 put on the UI namespace. The `en` values
 * duplicate the emission-time English messages on purpose: intentional
 * redundancy across a wire, not drift (the table serves the harness's own
 * fallback chain, the payload's `message` field serves old clients and the
 * resolver's last step). `tests/host-resolve.spec.ts` asserts the two are
 * byte-identical where a test can see both.
 *
 * The `zh` and `ru` tables reuse the F-46 terminology of `./ui.ts`
 * (deployment → 部署 / установка, document → 文档 / документ) and,
 * like it, are maintainer-authored and pending review.
 *
 * @module src/client/locales/host
 */

import type { TabLocale } from '../tab-locale.ts'
import type { Translate } from '../view.ts'

/** Locale namespace the host's coded messages are registered under. */
export const NS_HOST = 'projectMcp.host'

/**
 * Every wire code the host half can emit. The union grows per task of F-48;
 * the tables below are what force per-commit completeness. Each code carries a
 * one-line comment naming the channel that emits it.
 */
export type HostCode =
  | 'write.blocked.notConfigured'
  | 'write.blocked.notWritable'
  | 'write.blocked.globalDisabled'
  // The parse channel (Task 2): parseDocument's diagnostics, plus the runtime's
  // multi-document merge warning — the code the client compares, never the prose.
  | 'parse.json.invalid'
  | 'parse.doc.notObject'
  | 'parse.server.duplicateName'
  | 'parse.server.badName'
  | 'parse.server.renamedName'
  | 'parse.server.multiDocument'
  | 'parse.entry.notObject'
  | 'parse.entry.badType'
  | 'parse.entry.typeUnknown'
  | 'parse.entry.noCommand'
  | 'parse.entry.badArgs'
  | 'parse.entry.badEnv'
  | 'parse.entry.badCwd'
  | 'parse.entry.noUrl'
  | 'parse.entry.badHeaders'
  | 'parse.ref.empty'
  | 'parse.ref.inputUnset'
  | 'parse.ref.varUnset'
  | 'parse.ref.failedInKey'
  // The lifecycle channel (Task 3): the five logLifecycle events, the two
  // sharing phrases `mount.starting` nests two-level, the twelve unmount
  // reasons `unmounting` nests, and the four idle row details.
  | 'mount.starting'
  | 'mount.sharingShared'
  | 'mount.sharingForwarded'
  | 'mount.failed'
  | 'mount.failedDetail'
  | 'mount.up'
  | 'mount.stalled'
  | 'mount.stalledDetail'
  | 'unmounting'
  | 'unmount.reason.operatorRetry'
  | 'unmount.reason.unloading'
  | 'unmount.reason.sessionGone'
  | 'unmount.reason.sessionUnlisted'
  | 'unmount.reason.sessionMoved'
  | 'unmount.reason.sessionIdle'
  | 'unmount.reason.operatorReleased'
  | 'unmount.reason.profileShown'
  | 'unmount.reason.undeclared'
  | 'unmount.reason.nameChanged'
  | 'unmount.reason.declarationChanged'
  | 'unmount.reason.nothingMountable'
  | 'idle.lazy'
  | 'idle.disabled'
  | 'idle.releasedInactive'
  | 'idle.releasedRequest'
  // The conflict channel (Task 4): the two shapes of the profile-conflict
  // report, the duplicate-document report, the two readings of a shadowed
  // row's detail, and the presentation owner's note.
  | 'conflict.profile'
  | 'conflict.profileAlias'
  | 'conflict.documents'
  | 'conflict.profileDetail'
  | 'conflict.profileAliasDetail'
  | 'present.ownerNote'
  // The save channel (Task 5): every refusal of saveEntry and of the three
  // policy writes (setPin/setPolicy/setConflictChoice). The five
  // SaveErrorCodes stay the HTTP-status axis — these code the messages.
  | 'save.noPolicyStore'
  | 'save.noLiveSession'
  | 'save.unknownMode'
  | 'save.unknownChoice'
  | 'save.serverNotDeclared'
  | 'save.noDeclaringDocument'
  | 'save.notWritable'
  | 'save.needsConsent'
  | 'save.globalDisabled'
  | 'save.declaredElsewhere'
  | 'save.documentGone'
  | 'save.documentChanged'
  | 'save.invalidJson'
  | 'save.noMcpServers'
  | 'save.noLongerDeclared'
  | 'save.entryNotParsed'
  | 'save.writeFailed'
  // The trio applyEntry (src/write.ts) throws as WriteDocError and the save
  // path reuses beside its `invalid` refusal.
  | 'write.doc.invalidJson'
  | 'write.doc.notObject'
  | 'write.doc.noMcpServers'

/**
 * English. Byte-identical to the literals `writeScopeFor` (`src/write.ts`)
 * emits as `reason` — the harness's own fallback chain ends here, one step
 * before the resolver falls back to the payload's `message`.
 */
export const en: Record<HostCode, string> = {
  // writeScopeFor: the document is none the deployment reads, and none is configured to write.
  'write.blocked.notConfigured':
    '{document} is not a document this deployment reads, and it configures none to write',
  // writeScopeFor: the document is not among the deployment's MCP documents; {writable} lists them.
  'write.blocked.notWritable':
    "{document} is not one of this deployment's MCP documents; only {writable} can be written",
  // writeScopeFor: a global-tier document with the deployment's allowGlobalWrite off.
  'write.blocked.globalDisabled':
    'writing the global tier is disabled by this deployment (allowGlobalWrite: false); {document} stays read-only here',
  // parseDocument: the document's text is not JSON at all.
  'parse.json.invalid': 'invalid JSON: {error}',
  // parseDocument: no `mcpServers`/`servers` map and not a flat server map either.
  'parse.doc.notObject': 'expected an object with an "mcpServers" object',
  // parseDocument: two keys sanitize to one serverName inside one document.
  'parse.server.duplicateName': 'serverName "{name}" is declared twice in this document',
  // sanitizeName: nothing of the key survives slugification.
  'parse.server.badName': '"{key}" cannot be converted into a valid serverName ({pattern})',
  // sanitizeName: the key mounts under its slug instead.
  'parse.server.renamedName': 'serverName "{key}" is not a valid mcp-client name; using "{slug}"',
  // The runtime's merge pass: a later document overrode this name's earlier declaration.
  'parse.server.multiDocument':
    'serverName "{name}" was declared in more than one document; the highest-priority definition wins',
  // toEntry: the entry's value is not an object.
  'parse.entry.notObject': 'entry must be an object',
  // toEntry: a `type`/`transport` that is not a string.
  'parse.entry.badType': '"type" must be a string',
  // toEntry: a `type` outside the four known transports.
  'parse.entry.typeUnknown': '"type" must be one of "stdio", "http", "streamable-http" or "sse"',
  // buildStdioEntry: no command to run.
  'parse.entry.noCommand': 'stdio servers require a "command"',
  // buildStdioEntry: `args` present but not a string array.
  'parse.entry.badArgs': '"args" must be an array of strings',
  // buildStdioEntry: `env` present but not a string map.
  'parse.entry.badEnv': '"env" must be an object of strings',
  // buildStdioEntry: `cwd` present but not a string.
  'parse.entry.badCwd': '"cwd" must be a string',
  // buildHttpEntry: no url to connect to.
  'parse.entry.noUrl': 'http servers require a "url"',
  // buildHttpEntry: `headers` present but not a string map.
  'parse.entry.badHeaders': '"headers" must be an object of strings',
  // resolveRef: `${input:}` with no name.
  'parse.ref.empty': 'empty ${input:} reference',
  // resolveRef: an `${input:NAME}` no source answers.
  'parse.ref.inputUnset':
    'input "{key}" is not set (looked in plugin inputs, the project .env, the environment, and the credentials file)',
  // resolveRef: a `${NAME}` no source answers.
  'parse.ref.varUnset':
    'variable "{name}" is not set (looked in the project .env, the environment, and the credentials file)',
  // expandRecord: a reference failed inside an env/headers value; {name} is the inner message.
  'parse.ref.failedInKey': '{key}: {name}',
  // mount(): a mount is registered. {sharing} is the two-level nesting of
  // mount.sharingShared / mount.sharingForwarded, substituted from sharingCode.
  'mount.starting': 'mounting for session {sessionId} (trigger: {trigger}; {sharing})',
  // mount(): the session shares the project's instance directly (parent-linked).
  'mount.sharingShared': 'one shared instance for every session of this project',
  // mount(): the session's key could not be linked, so the bridge forwards.
  'mount.sharingForwarded':
    "one shared instance for this project, forwarded into this session's own layer",
  // recordMountFailure(): the activation or the registration threw.
  'mount.failed': 'mount failed — {error}',
  // failureDetail(): one template, three lines — the name and the error, the
  // endpoint, the declaring document.
  'mount.failedDetail': '{name}: mount failed — {error}\nendpoint: {endpoint}\ndeclared in: {source}',
  // refreshStatuses(): the mount's tools became visible to the session.
  'mount.up': 'is up — tools visible to session {sessionId} after {elapsed}',
  // refreshStatuses(): the connect watchdog fired.
  'mount.stalled': 'no tool appeared in {elapsed}',
  // stallDetail(): the same three facts as mount.failedDetail, for a stall.
  'mount.stalledDetail': '{name}: no tool appeared in {elapsed}\nendpoint: {endpoint}\ndeclared in: {source}',
  // logUnmount(): a mount is going away. {reason} is the two-level nesting of
  // one of the unmount.reason.* codes, substituted from reasonCode.
  'unmounting': 'unmounting — {reason} (it ran for {ran})',
  // retry(): the dropped error mount is being replaced by the operator pass.
  'unmount.reason.operatorRetry': 'an operator retry replaces it',
  // disposeAll(): the whole runtime is going down.
  'unmount.reason.unloading': 'the plugin is unloading',
  // agent scope event: the session's agent disappeared.
  'unmount.reason.sessionGone': 'the session went away',
  // session sweep: the host registry dropped the session.
  'unmount.reason.sessionUnlisted': 'the registry no longer lists the session',
  // syncAgent()/holdProject(): the session's cwd resolved to another root.
  'unmount.reason.sessionMoved': 'the session moved to another project',
  // evictIdle(): the session was quiet past idleTimeoutMs.
  'unmount.reason.sessionIdle': 'the session went idle',
  // release(): the operator asked for the release.
  'unmount.reason.operatorReleased': 'an operator released it',
  // syncAgent(): a reserved name whose shadowing declaration disappeared.
  'unmount.reason.profileShown': 'this project shows the profile-level copy instead',
  // syncAgent(): the documents stopped declaring the mounted name.
  'unmount.reason.undeclared': 'the documents no longer declare it',
  // syncAgent(): the chosen local alias changed under a live mount.
  'unmount.reason.nameChanged': 'its local name changed',
  // syncAgent(): the declaration's fingerprint changed under a live mount.
  'unmount.reason.declarationChanged': 'its declaration changed',
  // syncAgent(): the declarations left mount nothing.
  'unmount.reason.nothingMountable': 'nothing it declares is mountable any more',
  // syncAgent(): a declaration `lazy` has not mounted yet.
  'idle.lazy': 'not mounted yet — this session has not started a turn (lazy mounting is on)',
  // syncAgent(): the entry declares `enabled: false`.
  'idle.disabled': 'declared with enabled: false',
  // evictIdle() via releaseMounts(): the idle release's row detail.
  'idle.releasedInactive':
    'released after {seconds} without activity — {count} server(s) stopped; the next turn mounts them again',
  // release() via releaseMounts(): the requested release's row detail.
  'idle.releasedRequest':
    'released on request — {count} server(s) stopped; the next turn mounts them again',
  // conflictsFor(): a profile-level instance owns the name, and this project
  // has no local alias to offer.
  'conflict.profile':
    '"{name}" is owned by a profile-level mcp-client instance, so the project entry does not mount under it; remove the profile entry to use the project one everywhere, or let this project\'s copy take the name in this project\'s sessions alone.',
  // conflictsFor(): the same, with the local alias the choice would mount under.
  'conflict.profileAlias':
    '"{name}" is owned by a profile-level mcp-client instance; this project\'s copy mounts as "{alias}" when chosen beside it, or under the contested name when chosen to shadow it in this project\'s sessions, and does not mount at all while the profile\'s copy is the one shown.',
  // conflictsFor(): one name declared by {count} documents; {winner} is the
  // document the merge kept.
  'conflict.documents':
    '"{name}" is declared in {count} documents; {winner} wins and the other declaration is not mounted.',
  // conflictDetail(): the shadowed row's detail, no alias to offer.
  'conflict.profileDetail':
    'serverName "{name}" is already provided by a profile-level mcp-client instance — remove that entry from the profile to use the project one everywhere, or choose this project\'s copy to let it take the name in this project\'s sessions',
  // conflictDetail(): the shadowed row's detail, with the local alias.
  'conflict.profileAliasDetail':
    'serverName "{name}" is already provided by a profile-level mcp-client instance — choose this project\'s copy to mount it as "{alias}", or under the contested name to shadow the profile instance here',
  // presentationOwner(): why this plugin and a second owner cannot shape one
  // request. No params — one fixed sentence.
  'present.ownerNote':
    'a second presentation owner rewrites assembly.tools after this plugin does, so the two never combine in one request: either this plugin shapes only its own mcp__* entries, or the other owner is unmounted.',
  // setPin/setPolicy/setConflictChoice: the host was built without a policy store.
  'save.noPolicyStore': 'this host has no tool-policy store',
  // setPin/setPolicy/setConflictChoice: the named project has no live session here.
  'save.noLiveSession': 'no live session in {projectRoot}',
  // setPolicy: a mode no assembly knows; {mode} is the JSON-stringified value.
  'save.unknownMode': 'unknown tool mode {mode}',
  // setConflictChoice: an answer no build knows; {choice} is the JSON-stringified value.
  'save.unknownChoice': 'unknown conflict choice {choice}',
  // saveEntry: no live row of this project carries the name.
  'save.serverNotDeclared': 'server "{server}" is not declared for {projectRoot}',
  // saveEntry: the row names no declaring document to write to.
  'save.noDeclaringDocument': 'server "{server}" has no declaring document to write',
  // saveEntry: the defensive readonly fallback — writeScopeFor's own reason
  // arrives coded (write.blocked.*) and is reused instead whenever it exists.
  'save.notWritable': '{document} is not writable',
  // saveEntry: a global-tier write submitted without the explicit consent.
  'save.needsConsent': 'writing {document} needs explicit consent',
  // saveEntry: a global-tier write with the deployment's allowGlobalWrite off.
  'save.globalDisabled': 'writing the global tier is disabled by this deployment (allowGlobalWrite: false)',
  // saveEntry: the editor's document no longer declares the name.
  'save.declaredElsewhere': 'server "{server}" is now declared by {document}',
  // saveEntry: the declaring document could not be read back at all.
  'save.documentGone': 'the declaring document {document} is gone',
  // saveEntry: the document's revision moved past the one the editor read.
  'save.documentChanged': '{document} changed since the entry was read; reload it and edit again',
  // saveEntry: the document read back is not JSON any more.
  'save.invalidJson': 'the declaring document is not valid JSON: {error}',
  // saveEntry: the document holds no "mcpServers" object to rewrite.
  'save.noMcpServers': '{document} does not use an "mcpServers" object, so this editor cannot rewrite it',
  // saveEntry: the document parses, but no key of it names the server.
  'save.noLongerDeclared': 'server "{server}" is no longer declared in {document}',
  // saveEntry: the written-back entry failed the mount path's own parse. When
  // the parse named its failure, that failure's own code (parse.*) is reused
  // instead — this code names only the shapeless fallback.
  'save.entryNotParsed': 'the edited entry "{server}" did not parse',
  // saveEntry: writeDocument threw (the backup, the temporary write or the rename).
  'save.writeFailed': 'writing {document} failed: {error}',
  // applyEntry: the document text is not JSON at all.
  'write.doc.invalidJson': 'the document is not valid JSON: {error}',
  // applyEntry: the document parses to something that is not an object.
  'write.doc.notObject': 'the document is not a JSON object',
  // applyEntry: the document holds no "mcpServers" object.
  'write.doc.noMcpServers': 'the document has no "mcpServers" object',
}

/** Chinese, complete across the namespace: the `Record<HostCode, string>` annotation proves it. */
export const zh: Record<HostCode, string> = {
  'write.blocked.notConfigured': '{document} 不是此部署读取的文档，它也未配置任何可写入的文档',
  'write.blocked.notWritable': '{document} 不是此部署的 MCP 文档之一；只能写入 {writable}',
  'write.blocked.globalDisabled':
    '此部署已禁用全局级的写入（allowGlobalWrite: false）；{document} 在此处保持只读',
  'parse.json.invalid': '无效的 JSON：{error}',
  'parse.doc.notObject': '预期是一个带有 "mcpServers" 对象的对象',
  'parse.server.duplicateName': 'serverName "{name}" 在此文档中声明了两次',
  'parse.server.badName': '"{key}" 无法转换为有效的 serverName（{pattern}）',
  'parse.server.renamedName': 'serverName "{key}" 不是有效的 mcp-client 名称；改用 "{slug}"',
  'parse.server.multiDocument': 'serverName "{name}" 在不止一份文档中声明；优先级最高的定义生效',
  'parse.entry.notObject': '条目必须是对象',
  'parse.entry.badType': '"type" 必须是字符串',
  'parse.entry.typeUnknown': '"type" 必须是 "stdio"、"http"、"streamable-http" 或 "sse" 之一',
  'parse.entry.noCommand': 'stdio 服务器需要 "command"',
  'parse.entry.badArgs': '"args" 必须是字符串数组',
  'parse.entry.badEnv': '"env" 必须是字符串组成的对象',
  'parse.entry.badCwd': '"cwd" 必须是字符串',
  'parse.entry.noUrl': 'http 服务器需要 "url"',
  'parse.entry.badHeaders': '"headers" 必须是字符串组成的对象',
  'parse.ref.empty': '空的 ${input:} 引用',
  'parse.ref.inputUnset': '输入 "{key}" 未设置（已在插件 inputs、项目 .env、环境和凭据文件中查找）',
  'parse.ref.varUnset': '变量 "{name}" 未设置（已在项目 .env、环境和凭据文件中查找）',
  'parse.ref.failedInKey': '{key}：{name}',
  'mount.starting': '正在为会话 {sessionId} 挂载（触发方式：{trigger}；{sharing}）',
  'mount.sharingShared': '此项目的所有会话共享一个实例',
  'mount.sharingForwarded': '此项目共享一个实例，已转发进此会话自己的层',
  'mount.failed': '挂载失败 — {error}',
  'mount.failedDetail': '{name}：挂载失败 — {error}\n端点：{endpoint}\n声明于：{source}',
  'mount.up': '已就绪 — {elapsed} 后工具对会话 {sessionId} 可见',
  'mount.stalled': '{elapsed} 内没有出现任何工具',
  'mount.stalledDetail': '{name}：{elapsed} 内没有出现任何工具\n端点：{endpoint}\n声明于：{source}',
  'unmounting': '正在卸载 — {reason}（已运行 {ran}）',
  'unmount.reason.operatorRetry': '操作员发起的重试将取代它',
  'unmount.reason.unloading': '插件正在退出',
  'unmount.reason.sessionGone': '会话已消失',
  'unmount.reason.sessionUnlisted': '注册表不再列出该会话',
  'unmount.reason.sessionMoved': '会话已移动到另一个项目',
  'unmount.reason.sessionIdle': '会话已空闲',
  'unmount.reason.operatorReleased': '操作员释放了它',
  'unmount.reason.profileShown': '此项目改为显示配置文件级的副本',
  'unmount.reason.undeclared': '文档不再声明它',
  'unmount.reason.nameChanged': '它的本地名称已更改',
  'unmount.reason.declarationChanged': '它的声明已更改',
  'unmount.reason.nothingMountable': '它声明的内容不再有可挂载的',
  'idle.lazy': '尚未挂载 — 此会话还没有开始任何一轮对话（惰性挂载已开启）',
  'idle.disabled': '以 enabled: false 声明',
  'idle.releasedInactive': '在 {seconds} 无活动后释放 — 已停止 {count} 个服务器；下一轮对话会重新挂载它们',
  'idle.releasedRequest': '已按请求释放 — 已停止 {count} 个服务器；下一轮对话会重新挂载它们',
  'conflict.profile':
    '"{name}" 已由配置文件级的 mcp-client 实例占用，因此项目条目不会以该名称挂载；请从配置文件中移除该条目以在各处使用项目副本，或让此项目的副本仅在此项目的会话中使用该名称。',
  'conflict.profileAlias':
    '"{name}" 已由配置文件级的 mcp-client 实例占用；选择并存时此项目的副本以 "{alias}" 挂载，选择遮蔽时则在此项目的会话中使用被争用的名称，而在显示配置文件副本期间完全不挂载。',
  'conflict.documents': '"{name}" 在 {count} 份文档中声明；{winner} 生效，另一份声明不会被挂载。',
  'conflict.profileDetail':
    'serverName "{name}" 已由配置文件级的 mcp-client 实例提供 — 从配置文件中移除该条目以在各处使用项目副本，或选择此项目的副本让它在此项目的会话中使用该名称',
  'conflict.profileAliasDetail':
    'serverName "{name}" 已由配置文件级的 mcp-client 实例提供 — 选择此项目的副本将其挂载为 "{alias}"，或选择被争用的名称以在此处遮蔽配置文件实例',
  'present.ownerNote':
    '第二个呈现所有者会在此插件之后重写 assembly.tools，因此两者永远不会在同一请求中合并：要么此插件只塑造自己的 mcp__* 条目，要么卸载另一个所有者。',
  'save.noPolicyStore': '此宿主没有工具策略存储',
  'save.noLiveSession': '{projectRoot} 中没有活跃会话',
  'save.unknownMode': '未知的工具模式 {mode}',
  'save.unknownChoice': '未知的冲突选择 {choice}',
  'save.serverNotDeclared': '服务器 "{server}" 未在 {projectRoot} 中声明',
  'save.noDeclaringDocument': '服务器 "{server}" 没有可写入的声明文档',
  'save.notWritable': '{document} 不可写入',
  'save.needsConsent': '写入 {document} 需要明确同意',
  'save.globalDisabled': '此部署已禁用全局级的写入（allowGlobalWrite: false）',
  'save.declaredElsewhere': '服务器 "{server}" 现在由 {document} 声明',
  'save.documentGone': '声明文档 {document} 已不存在',
  'save.documentChanged': '{document} 自读取条目后已更改；请重新加载后再编辑',
  'save.invalidJson': '声明文档不是有效的 JSON：{error}',
  'save.noMcpServers': '{document} 未使用 "mcpServers" 对象，因此此编辑器无法重写它',
  'save.noLongerDeclared': '服务器 "{server}" 不再在 {document} 中声明',
  'save.entryNotParsed': '编辑后的条目 "{server}" 无法解析',
  'save.writeFailed': '写入 {document} 失败：{error}',
  'write.doc.invalidJson': '文档不是有效的 JSON：{error}',
  'write.doc.notObject': '文档不是 JSON 对象',
  'write.doc.noMcpServers': '文档没有 "mcpServers" 对象',
}

/** Russian, complete across the namespace on the same annotation. */
export const ru: Record<HostCode, string> = {
  'write.blocked.notConfigured':
    '{document} — не документ, который читает эта установка, и она не настраивает ни одного для записи',
  'write.blocked.notWritable':
    '{document} не входит в MCP-документы этой установки; записать можно только {writable}',
  'write.blocked.globalDisabled':
    'запись в глобальный уровень отключена этой установкой (allowGlobalWrite: false); {document} остаётся здесь доступным только для чтения',
  'parse.json.invalid': 'недопустимый JSON: {error}',
  'parse.doc.notObject': 'ожидался объект с объектом "mcpServers"',
  'parse.server.duplicateName': 'serverName "{name}" объявлен в этом документе дважды',
  'parse.server.badName': '"{key}" невозможно преобразовать в допустимый serverName ({pattern})',
  'parse.server.renamedName':
    'serverName "{key}" не является допустимым именем mcp-client; используется "{slug}"',
  'parse.server.multiDocument':
    'serverName "{name}" объявлен более чем в одном документе; побеждает определение с наивысшим приоритетом',
  'parse.entry.notObject': 'запись должна быть объектом',
  'parse.entry.badType': '"type" должно быть строкой',
  'parse.entry.typeUnknown': '"type" должно быть одним из "stdio", "http", "streamable-http" или "sse"',
  'parse.entry.noCommand': 'stdio-серверы требуют "command"',
  'parse.entry.badArgs': '"args" должно быть массивом строк',
  'parse.entry.badEnv': '"env" должно быть объектом из строк',
  'parse.entry.badCwd': '"cwd" должно быть строкой',
  'parse.entry.noUrl': 'http-серверы требуют "url"',
  'parse.entry.badHeaders': '"headers" должно быть объектом из строк',
  'parse.ref.empty': 'пустая ссылка ${input:}',
  'parse.ref.inputUnset':
    'input "{key}" не задан (искали в inputs плагина, в .env проекта, в окружении и в файле учётных данных)',
  'parse.ref.varUnset':
    'переменная "{name}" не задана (искали в .env проекта, в окружении и в файле учётных данных)',
  'parse.ref.failedInKey': '{key}: {name}',
  'mount.starting': 'монтирование для сессии {sessionId} (триггер: {trigger}; {sharing})',
  'mount.sharingShared': 'один общий экземпляр для каждой сессии этого проекта',
  'mount.sharingForwarded':
    'один общий экземпляр на этот проект, проброшенный в собственный слой этой сессии',
  'mount.failed': 'монтирование не удалось — {error}',
  'mount.failedDetail':
    '{name}: монтирование не удалось — {error}\nэндпоинт: {endpoint}\nобъявлено в: {source}',
  'mount.up': 'поднят — инструменты видны сессии {sessionId} спустя {elapsed}',
  'mount.stalled': 'за {elapsed} не появилось ни одного инструмента',
  'mount.stalledDetail':
    '{name}: за {elapsed} не появилось ни одного инструмента\nэндпоинт: {endpoint}\nобъявлено в: {source}',
  'unmounting': 'снятие — {reason} (проработал {ran})',
  'unmount.reason.operatorRetry': 'его заменяет повторная попытка оператора',
  'unmount.reason.unloading': 'плагин выгружается',
  'unmount.reason.sessionGone': 'сессия исчезла',
  'unmount.reason.sessionUnlisted': 'реестр больше не содержит эту сессию',
  'unmount.reason.sessionMoved': 'сессия перешла в другой проект',
  'unmount.reason.sessionIdle': 'сессия простаивает',
  'unmount.reason.operatorReleased': 'оператор освободил его',
  'unmount.reason.profileShown': 'этот проект вместо него показывает копию уровня профиля',
  'unmount.reason.undeclared': 'документы больше не объявляют его',
  'unmount.reason.nameChanged': 'его локальное имя изменилось',
  'unmount.reason.declarationChanged': 'его объявление изменилось',
  'unmount.reason.nothingMountable': 'ничего из объявленного им больше нельзя смонтировать',
  'idle.lazy':
    'ещё не смонтирован — эта сессия ещё не начала ни одного шага (ленивое монтирование включено)',
  'idle.disabled': 'объявлен с enabled: false',
  'idle.releasedInactive':
    'освобождено после {seconds} без активности — остановлено серверов: {count}; следующий шаг смонтирует их снова',
  'idle.releasedRequest':
    'освобождено по запросу — остановлено серверов: {count}; следующий шаг смонтирует их снова',
  'conflict.profile':
    '"{name}" принадлежит экземпляру mcp-client уровня профиля, поэтому запись проекта не монтируется под этим именем; удалите запись из профиля, чтобы использовать проектную везде, или позвольте копии этого проекта занять имя только в сессиях этого проекта.',
  'conflict.profileAlias':
    '"{name}" принадлежит экземпляру mcp-client уровня профиля; копия этого проекта монтируется как "{alias}" при выборе рядом с ним или под спорным именем при выборе затенения в сессиях этого проекта и не монтируется вовсе, пока показана копия профиля.',
  'conflict.documents':
    '"{name}" объявлен в документах: {count}; побеждает {winner}, а другое объявление не монтируется.',
  'conflict.profileDetail':
    'serverName "{name}" уже предоставлен экземпляром mcp-client уровня профиля — удалите эту запись из профиля, чтобы использовать проектную везде, или выберите копию этого проекта, чтобы она заняла имя в сессиях этого проекта',
  'conflict.profileAliasDetail':
    'serverName "{name}" уже предоставлен экземпляром mcp-client уровня профиля — выберите копию этого проекта, чтобы смонтировать её как "{alias}", или спорное имя, чтобы затенить экземпляр профиля здесь',
  'present.ownerNote':
    'второй владелец представления перезаписывает assembly.tools после этого плагина, поэтому оба никогда не объединяются в одном запросе: либо этот плагин формирует только свои записи mcp__*, либо другой владелец выгружается.',
  'save.noPolicyStore': 'у этого хоста нет хранилища политики инструментов',
  'save.noLiveSession': 'нет активной сессии в {projectRoot}',
  'save.unknownMode': 'неизвестный режим инструментов {mode}',
  'save.unknownChoice': 'неизвестный выбор конфликта {choice}',
  'save.serverNotDeclared': 'сервер "{server}" не объявлен для {projectRoot}',
  'save.noDeclaringDocument': 'у сервера "{server}" нет объявляющего документа для записи',
  'save.notWritable': '{document} недоступен для записи',
  'save.needsConsent': 'запись {document} требует явного согласия',
  'save.globalDisabled': 'запись в глобальный уровень отключена этой установкой (allowGlobalWrite: false)',
  'save.declaredElsewhere': 'сервер "{server}" теперь объявлен в {document}',
  'save.documentGone': 'объявляющий документ {document} исчез',
  'save.documentChanged': '{document} изменился с момента чтения записи; перезагрузите его и отредактируйте заново',
  'save.invalidJson': 'объявляющий документ не является допустимым JSON: {error}',
  'save.noMcpServers': '{document} не использует объект "mcpServers", поэтому этот редактор не может его переписать',
  'save.noLongerDeclared': 'сервер "{server}" больше не объявлен в {document}',
  'save.entryNotParsed': 'изменённая запись "{server}" не разобралась',
  'save.writeFailed': 'запись {document} не удалась: {error}',
  'write.doc.invalidJson': 'документ не является допустимым JSON: {error}',
  'write.doc.notObject': 'документ не является JSON-объектом',
  'write.doc.noMcpServers': 'в документе нет объекта "mcpServers"',
}

/**
 * The translator of last resort: every code echoes, so {@link resolveHost}
 * reads the harness's miss signal and falls back to the payload's `message`.
 */
const echo: Translate = (key) => key

/**
 * A translator bound to the host namespace — and nothing more.
 *
 * This is deliberately not `uiTranslate`'s shape: the UI seat falls back to
 * the merged English table of its module, but this namespace has no merged
 * English table — the per-message fallback is the design, and it lives in
 * {@link resolveHost}, which detects the echo itself. Without a locale
 * service, or when the service refuses the namespace, the seat echoes, which
 * is exactly the miss signal the resolver reads.
 * @param locale - the shell's locale service, when there is one.
 * @returns a translate seat over `projectMcp.host`.
 */
export function hostTranslate(locale: TabLocale | undefined): Translate {
  if (locale === undefined) return echo
  try {
    return locale.bind(NS_HOST) as Translate
  } catch {
    // A service that refuses the namespace leaves the payload its own English.
    return echo
  }
}

/**
 * Resolve one host payload to the sentence the screen shows.
 *
 * The chain: the bound namespace answers first (the harness's own fallback —
 * active language, then this namespace's `en` table — rides inside it); a
 * miss, which the harness signals by echoing the code, falls back to the
 * payload's English `message`; a payload without a code renders its `message`
 * directly, so an old host's prose shows exactly as it did before codes
 * existed. The raw code survives only when the payload is malformed (no
 * `message` either) — the documented last resort.
 *
 * Params are flat, with one two-level convention: a param whose name ends in
 * `Code` is itself a wire code, resolved through `bound` first and substituted
 * under the plain name (`reasonCode` → `reason`). A nested lookup that misses —
 * the harness echoes the sub-code, which substituted would put a raw code on
 * screen inside an otherwise translated sentence — fails the whole lookup:
 * the payload's `message` answers instead.
 * @param bound - the host-namespace seat from {@link hostTranslate}.
 * @param code - the payload's wire code, when it carries one.
 * @param params - the payload's flat params, when it carries any.
 * @param message - the payload's English fallback text.
 * @returns the sentence to render.
 */
export function resolveHost(
  bound: Translate,
  code: string | undefined,
  params: Record<string, string> | undefined,
  message: string | undefined,
): string {
  if (code === undefined) return message ?? ''
  const resolved = resolveParams(bound, params)
  if (resolved.missed) return message ?? code
  const text = bound(code, resolved.params)
  return text === code ? (message ?? code) : text
}

/**
 * The params a bound seat is called with: `*Code` values resolved two-level.
 * `missed` is the nested miss signal: a sub-code the namespace does not know
 * echoes, and an echo is never substituted into a sentence.
 */
function resolveParams(
  bound: Translate,
  params: Record<string, string> | undefined,
): { params: Record<string, string> | undefined; missed: boolean } {
  if (params === undefined) return { params: undefined, missed: false }
  const resolved: Record<string, string> = {}
  let missed = false
  for (const [name, value] of Object.entries(params)) {
    if (name.endsWith('Code') && name.length > 'Code'.length) {
      const nested = bound(value)
      if (nested === value) missed = true
      resolved[name.slice(0, -'Code'.length)] = nested
    } else {
      resolved[name] = value
    }
  }
  return { params: resolved, missed }
}
