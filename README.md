# dsh-project-mcp

Per-project MCP servers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

DSH normally configures MCP once per **profile** (`cordis.patch.yml`), so every
session of the process sees the same servers. This plugin adds the missing
plane: a project declares its MCP servers in its own files, and those servers
are mounted **only for the sessions working in that project**.

Which files a project is read from is a **setting**: `localFiles` lists documents
relative to the project root, `globalFiles` lists the ones read before them. The
shipped default reads one document — `<project>/.dsh/mcp.json` — and nothing
global, so a project mounts exactly what it declares. A Kimi Code project (or any
other tool's file) is one config line away, never an implicit second source.

```jsonc
// <project>/.dsh/mcp.json
{
  "mcpServers": {
    "rider": {
      "type": "http",
      "url": "http://127.0.0.1:64343/stream",
      "headers": { "IJ_MCP_SERVER_PROJECT_PATH": "/abs/path/to/project/src/App" }
    },
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
    "tracker": {
      "command": "uvx",
      "args": ["yandex-tracker-mcp@latest"],
      "env": { "TRACKER_TOKEN": "${YANDEX_TOKEN}" }
    }
  }
}
```

## Table of contents

- [Install](#install)
- [Sources and priority](#sources-and-priority) — [entry mapping](#entry-mapping), [variables](#variables)
- [Configuration](#configuration) — [`profileWins`](#profilewins)
- [Runtime status](#runtime-status)
- [Usage counters](#usage-counters)
- [Tool policy: mode and pins](#tool-policy-mode-and-pins)
- [Tool activation and `mcp_search_tools`](#tool-activation-and-mcp_search_tools)
- [Project guidance in the system prompt](#project-guidance-in-the-system-prompt)
- [Lazy mounting and idle release](#lazy-mounting-and-idle-release)
- [Sidebar panel](#sidebar-panel) — [settings page](#settings-page), [writing entries](#writing-entries)
- [Diagnostics](#diagnostics)
- [Resource behaviour](#resource-behaviour)
- [Runtimes](#runtimes)
- [Verifying](#verifying)
- [Limitations](#limitations)
- [Dogfooding](#dogfooding)

Implementation notes: [how it works](#how-it-works) · [bundle format](#bundle-format-do-not-fix-this) · [layout](#layout)

## Install

```bash
pnpm install && pnpm check        # typecheck + build + tests under the coverage gate + resource audit
pnpm coverage                     # the same suite with the coverage report only
pnpm pack                         # -> dsh-project-mcp-0.2.0.tgz
mv dsh-project-mcp-0.2.0.tgz ~/.dsh/packages/
dsh plugin --profile web add file:$HOME/.dsh/packages/dsh-project-mcp-0.2.0.tgz
```

`pnpm check` runs the suite through `--coverage`, and `vitest.config.ts` gates all
four readings at **80%** over `src/**`: a surface added without its tests fails
the command a reviewer runs, not a later reading of a report.

Bun works as the package manager and runner too:

```bash
bun install && bun run build
bun test tests                    # same suite through the Bun test runner
```

`dsh plugin add` appends the bundle to `dsh.profile.bundles` and reconciles
`~/.dsh/profiles/web/package.json`; the bundle's own `cordis.patch.yml` mounts
the row. Restart the web GUI afterwards. To iterate without re-packing, install
with `link:/abs/path/to/dsh-project-mcp` and rebuild (`pnpm build`).

## Sources and priority

Read for the project of each session, lowest priority first — a later document
overrides an earlier entry with the same `serverName`. The order is exactly the
`globalFiles` list followed by the `localFiles` list:

| # | Document | Setting |
|---|---|---|
| 1 … | the global documents this deployment names | `globalFiles`, default `[]` — none read |
| … n | the project's own documents, in list order | `localFiles`, default `['.dsh/mcp.json']` |

A spec is read the way a shell reads it: `~/…` is `$HOME/…`, `$DSH_HOME/…` is the
plugin's own home, an absolute path is itself, and anything else is relative to
the base it belongs to — the project root for `localFiles`, `$HOME` for
`globalFiles`. So `localFiles: ['.kimi-code/mcp.json', '.dsh/mcp.json']` reads a
Kimi Code project's file first and lets the DSH file override it, and
`globalFiles: ['~/.dsh/mcp.json']` adds a machine-wide document below both.

A document may be `{ "mcpServers": { ... } }`, `{ "servers": { ... } }`, or a
bare `name → entry` map. Unknown fields are ignored; a broken row never blocks
the rest of the document — it surfaces as an `error` row.

### Entry mapping

| Input | Result |
|---|---|
| `command` / `args` / `env` / `cwd` | `transport: 'stdio'`, `cwd` defaults to the project root |
| `url` / `headers` | `transport: 'streamable-http'` |
| `type: 'stdio' \| 'http' \| 'streamable-http' \| 'sse'` | explicit transport; otherwise inferred from `url` |
| `enabled: false` / `disabled: true` | row stays visible as `disabled`, never mounted |
| `serverName` | the `mcpServers` key; must match `[A-Za-z0-9_-]{1,32}`, otherwise it is slugified with a warning |
| `"${VAR}"` | the project's own `.env` files → `process.env.VAR` → the credentials file, else an entry error |
| `"${input:NAME}"` | plugin `inputs.NAME` → the same chain as `${VAR}` |
| invalid JSON / bad row | `error` row with the reason; siblings still mount |

`${...}` references are expanded in `command`, `args`, `env`, `cwd`, `url` and
`headers`. Secrets stay out of the project document: they live in
`process.env`, in the project's own `.env` files, or in
`~/.dsh/.credentials.yaml`.

### Variables

A value a reference needs is looked up in one fixed order, project-local first:

| # | Source | Gate |
|---|---|---|
| 1 | `<project>/.dsh/.env` | `envFiles` (default `true`) |
| 2 | `<project>/.env` | `envFiles` (default `true`) |
| 3 | `process.env` | — |
| 4 | `KEY` in the credentials file | `credentialsFile` (default `$DSH_HOME/.credentials.yaml`) |

Plugin `inputs` sit above all four for `${input:NAME}`. The project-local files
are ordinary dotenv documents — one `KEY=value` per line, an optional `export `,
single or double quotes, `#` comments on their own line or after whitespace — and
an empty value counts as unset, so a blank entry cannot shadow a real one.

Both document shapes work: `${VAR}` (what a `mcp.json` written by hand usually
carries) and `${input:VAR}` (the VS Code spelling). Each document is re-read only
when its mtime/size changes, and a change to any of the four sources re-expands
the references and re-mounts the affected servers **without** the `mcp.json`
being touched. A key any of these sources answered is never written back by the
editor: it stays masked in the panel and its declared `${...}` text stays in the
file. `envFiles: false` narrows the chain back to `process.env` + credentials. Keep
the dotenv documents out of version control — the plugin only ever reads them, but a
committed `.env` is a committed secret.

## Configuration

Plugin config is the `cordis.patch.yml` row (defaults shown):

```yaml
- id: project-mcp
  config:
    enabled: true          # master switch
    localFiles: ['.dsh/mcp.json']   # project documents, lowest priority first
    globalFiles: []        # documents read before a project's own; [] reads none
    envFiles: true         # read <project>/.env and <project>/.dsh/.env for ${...}
    inputs: {}             # explicit ${input:NAME} values, e.g. COVERAGE_MCP_ALLOWED_ROOT: /repo
    toolCallTimeoutMs: 60000
    failOnStartupError: false   # true = a dead server fails its mount instead of reconnecting
    connectTimeoutMs: 60000     # a mount with no tool after this window becomes an error row; 0 disables
    lazy: true             # mount a session's project on its first turn, not at session creation
    idleTimeoutMs: 300000  # release a session's mounts after this much inactivity; 0 disables
    activationWaitMs: 2000 # how long the first step of a turn may wait for a pending mount; 0 never waits
    profileWins: true      # a profile-level serverName wins; the project row becomes `conflict`
    watch: true            # watch project documents for edits
    debounceMs: 300
    rescanIntervalMs: 10000
    credentialsFile: ''    # default: $DSH_HOME/.credentials.yaml
    allowGlobalWrite: false # let the editor write the documents of globalFiles
    activationEnabled: true   # offer MCP tools through `mcp_search_tools` + activation
    activationSeeded: 8       # counter-seeded tools that are always offered
    activationMinCalls: 5     # calls one tool needs before it is seeded
    toolIdleMs: 1800000       # drop a session-activated tool after this long without a call; 0 disables
    guidanceEnabled: true     # one short project-MCP guidance section in the session system prompt
    activationAutoLimit: 12   # names the task-context tier may offer at once; 0 disables that tier
    activationAutoStickySteps: 2  # extra user messages a context offer stays offered
    activationToolBudgetChars: 40000  # serialized MCP surface above which tools are deferred; 0 defers always
    projectMarkers: ['.git', '.dsh', '.kimi-code', 'package.json']
    fileMarkers: ['.sln', '.slnx', '.csproj']
```

### Live editing

On DSH ≥ 0.1.7 the keys below are **volatile**: the host serves them as a
config form, an edit commits into the running plugin without a restart, and the
runtime picks the new value up on the loader's `loader/volatile-update` event.
Every other key — `localFiles`, `globalFiles`, `inputs`, the marker lists,
`failOnStartupError`, `watch`, `credentialsFile` — is structural and still
needs a remount (restart or config reload) to take effect. An older host just
hands over plain values, and nothing about the boot path changes.

Volatile keys: `activationEnabled`, `activationSeeded`, `activationMinCalls`,
`toolIdleMs`, `guidanceEnabled`, `activationAutoLimit`,
`activationAutoStickySteps`, `activationToolBudgetChars`, `allowGlobalWrite`,
`envFiles`, `lazy`, `localPrefix`, `profileWins`, `connectTimeoutMs`,
`toolCallTimeoutMs`, `idleTimeoutMs`, `debounceMs`, `activationWaitMs`.

### `profileWins`

- `true` (default) — a project entry whose `serverName` is already live in the
  profile is **not** mounted; its row reads `conflict` with the hint to remove
  the profile entry. Safe: no duplicate processes, no shadowing.
- `false` — the project instance is mounted too. Nearer scopes shadow the
  profile's tools for that session, so the project's own configuration (for
  example a project-specific `IJ_MCP_SERVER_PROJECT_PATH`) wins. Costs one
  server process/connection per server for as long as a session of that project
  holds it.

## Runtime status

The plugin publishes a `projectMcp` service (`snapshot()` reads, `save()` writes
one entry back, and `setPin()` / `setPolicy()` write the project's tool policy):

```ts
ctx.get('projectMcp').snapshot()
// { ready, watchedFiles,
//   projects: [{ projectRoot, policy, sessionIds, rows, issues, sessions, usage }] }
// row.status: 'active' | 'connecting' | 'idle' | 'disabled' | 'conflict' | 'error'
// row.entry: the parsed body the editor starts from; row.writeScope / documentRevision
// sessions: [{ id, rows, issues }] — the same rows split per session
// policy: { mode, pins } — the project's tool policy, defaulted until it is changed
// usage: { [serverName]: ServerUsage } — absent until something was counted
ctx.get('projectMcp').syncNow(root?)  // reconcile and await it; `root` scopes it to one project
ctx.get('projectMcp').syncSoon(root?)  // same pass, answered at once — the panel's `Sync`
ctx.get('projectMcp').retry(root?)     // drop the failed mounts, then re-mount them in the background
ctx.get('projectMcp').subscribe(change => …) // push: the current SnapshotChange at once, then one per change
// SnapshotChange: { revision, snapshot } — every frame carries the whole snapshot
ctx.get('projectMcp').save({ projectRoot, server, document, revision, entry })
// { ok: true, snapshot } | { ok: false, code: 'invalid' | 'blocked' | 'conflict' | 'not-found' | 'failed' }
ctx.get('projectMcp').setPin({ projectRoot, tool, pinned })
ctx.get('projectMcp').setPolicy({ projectRoot, mode })
// { ok: true, snapshot } | { ok: false, code: 'invalid' | 'not-found' | 'failed' }
```

`projects[].rows` is the merge across that project's sessions, in document
order. Sessions mount independently, so when they disagree about one server the
most actionable status wins — `error` > `active` > `connecting` > `conflict` >
`idle` > `disabled` — and a running or failing server is never reported as idle
just because a session that has not turned yet was registered first.
`projects[].sessions` carries the same data split per session, which is what says
*which* session holds a mount.

## Usage counters

The host half counts every tool call whose server **this plugin** mounted, keyed
by project root and `serverName`, so a project's numbers outlive the sessions
that produced them:

```ts
ctx.get('projectMcp').snapshot().projects[0].usage
// { alpha: { calls: 12, errors: 1, tools: { search: 9, fetch: 3 },
//            lastUsedAt: '2024-05-06T07:08:09.000Z' } }
```

- `calls` counts every dispatched call, `errors` those whose result carried an
  error, and `lastUsedAt` (ISO) moves on success only. `tools` keys the tool name
  as the server declares it, without the `mcp__<serverName>__` prefix.
- Attribution never parses the prefix blindly: only tool names belonging to a
  server this plugin mounted for the calling agent's project are counted, so a
  profile-level `mcp__*` server never lands in a project's counters, and a
  registry name truncated to the function-name budget still resolves to its own
  server.
- The counters live in `$DSH_HOME/dsh-project-mcp-usage.json`, a versioned
  document (`{ version: 1, projects: … }`) written atomically (temp file +
  rename) on a debounce — never on the tool-call path. A missing, unparsable or
  older-version document starts clean, and a failed write is logged and dropped:
  counting is never a reason for a tool call or the plugin to fail.
- `usage` is absent for a project with no counted calls yet.

## Tool policy: mode and pins

The panel's `Tools` surface overrides the shipped presentation per project, and
that decision is **plugin state**, not project configuration: it lives in
`$DSH_HOME/dsh-project-mcp-policy.json`, the same kind of document as the counters
(versioned, written atomically through a temp file + rename, written on a debounce,
and a missing, corrupt or older-version file starting from the defaults rather
than failing):

```json
{ "version": 1, "projects": { "<root>": { "mode": "disclosure", "pins": ["mcp__tglider__workspace"] } } }
```

- **Mode** (`ProjectSnapshot.policy.mode`):
  - `disclosure` (default) — everything *Tool activation* below describes: the
    budget, the counter baseline, on-demand activations, the context tier and
    `mcp_search_tools`.
  - `direct` — defers nothing: the request carries the whole mounted catalogue,
    `deferring` is `false` and the discovery tool is not advertised.
  - `off` — offers none of the project's tools: the assembly listener adds
    nothing. Registering `mcp_search_tools` in the session scope cannot be
    cancelled (a DSH limitation, not a choice), so it stays registered but is not
    advertised either.
  - The mode is read on **every** assembly, so a change applies from the next
    model step on, with no re-mint of the session scope.
  - The mode decides all three fields of `SessionTools`, because that row is
    *this plugin's contribution* to the request, not what the model finally sees:

    | Mode | `baseline` | `deferred` | `deferring` |
    |---|---|---|---|
    | `disclosure` | pins ∪ hot names | mounted minus offered | surface over budget |
    | `direct` | pins ∪ hot names | empty | `false` |
    | `off` | **empty** | **every mounted name** | `false` |

    `deferring` is about the budget, never about the mode: `direct` and `off`
    defer nothing by size, they either filter nothing or offer nothing. A panel
    has to read `policy.mode` before the numbers — in `off` it says "this
    project's tools are off" rather than "N hidden", because a model can still
    see them when no other presentation plugin filters the assembly.
- **Pins** (`ProjectSnapshot.policy.pins`) — the names the user insists on:
  - A pinned name is offered from the first step of every request, whatever the
    counters and the budget say. It joins `SessionTools.baseline`, so the panel
    counts it as offered and it never lands in `deferred` — `baseline` is pins
    plus the names the counters heated up, and `deferred.length` is what is
    hidden.
  - A pin is project state, not session state: it survives idle pruning and
    `compaction/end` exactly like the counter baseline.
  - A name the project no longer mounts stays pinned — the declaration may come
    back, and a pin that silently disappeared would be a surprise. The list is
    delivered separately from the rest of `baseline`, because it is what the user
    pinned by hand rather than what the counters seeded.
  - `off` does not erase pins; it just does not offer them — the row's
    `baseline` is empty and every mounted name is `deferred` — so switching back
    to `disclosure` finds them again.

Both changes go over the panel routes, in the same envelope as a save and without
a rescan — the policy is not part of any declaring document, so the snapshot is
rebuilt in place:

```ts
POST /project-mcp/pin     { projectRoot, tool, pinned }   // PinRequest
POST /project-mcp/policy  { projectRoot, mode }           // PolicyRequest
// 200 { ok: true, value: <fresh snapshot> }
// 400 unknown project (not-found) or unknown mode (invalid)
```

## Tool activation and `mcp_search_tools`

A project can mount a large MCP surface, and every one of those tools in every
request is expensive. The host half presents them the way a progressive-tools
deployment wants, without touching the registry (this is the `disclosure` mode of
*Tool policy* above; a project can be switched to `direct` or `off` instead):

- **Hot tools are offered directly.** A tool whose project counters reached
  `activationMinCalls` (default 5) is seeded into a **baseline** that appears in
  the request from the first step on; `activationSeeded` (default 8) caps how
  many names the counters may seed. The counters are the ones above, so the
  baseline is remembered across sessions and restarts.
- **Matching tools are offered from the task context.** The host ranks the
  project's mounted tools against the newest task text with BM25 — over the tool
  name and description, tokenized on case boundaries, separators and punctuation,
  `k1 = 1.2`, `b = 0.75`, name matches weighted above description ones — and
  offers the best matches. `activationAutoLimit` (default 12) caps how many
  names one task may offer; matches below a score floor are dropped, and a tool
  that does not match stays reachable through `mcp_search_tools`.
- **Only a large surface is deferred at all.** The session's mounted schemas are
  measured as the request would carry them — name, description and serialized
  parameters. If that total is at or below `activationToolBudgetChars` (default
  `40000`, roughly 10K tokens) every tool is offered exactly as the rest of the
  harness assembled it. `0` switches the gate off and defers every surface.
  The counters keep accumulating either way, so the decision follows a project
  as it grows.
- **The offered set is sticky, so it rarely changes.** A name stays offered for
  the task text that offered it plus `activationAutoStickySteps` (default 2)
  later messages, one input per recomputation, so several steps share one tool
  list instead of following every dip of the ranking. Because the inner listeners
  rebuild the registry list on every step, the additions are re-applied each time
  from what those listeners actually returned; when that list already carries
  everything, the listener hands back the **identical** assembly object. A
  changing tool list rewrites the prompt prefix and invalidates the model's
  cache, so the plugin changes it deliberately and rarely.
- **The rest are found, not listed.** The plugin registers `mcp_search_tools` in
  the session's own scope and also offers it from its own assembly listener — a
  presentation plugin that trims the list to an allowlist would otherwise drop
  the one tool that makes the deferred layer reachable. The discovery tool is
  **pinned**: it appears in every `disclosure` assembly, whatever the budget
  says, so the model can always discover tools as the project grows. A call
  searches the MCP tools of *this project* — never a profile-level tool or
  another project's server — activates up to `limit` (default 8) matches, and
  returns their names and descriptions. The query matches case-insensitively
  and **word by word**: the whole query as one substring of a name or
  description ranks highest, and every word of it then scores its own hit (a
  word in a name outweighs the same word in a description; words shorter than
  two characters are ignored, and only the first eight distinct words count),
  so `issue get create update` finds `…-issue_get`, `…-issue_create` and
  `…-issue_update` even though no tool contains that phrase verbatim. The
  activated tools join the offered
  list from the **next** model step on; only the tools already listed are
  reliable until then.
- **Everything falls away again.** A session-activated tool that is not called
  within `toolIdleMs` (default 30 minutes) is dropped at the next `agent/status`
  transition, and a `compaction/end` clears the session's activations and the
  context offers outright. The counter baseline survives both — it is derived
  from durable counters, not from the session — and a pin survives them for the
  same reason (*Tool policy* above).

**Where the task text comes from.** The context tier reads the session's own
`session/event` stream: the newest committed `user/message` supplies the text,
and `tool/call` events supply recently called names (a called tool is offered
only when the plugin mounted it for this project). Only a message whose source
is `user` counts: the same event type carries every plugin-authored context
injection — runtime-context snapshots, agent instructions, skill catalogues,
memory recalls, cron notices — and ranking a tool offer against one of those
instead of the task would be worse than ranking against nothing. The timing
follows the harness: a turn's messages reach the log *after* the assembly that
opens the turn, so the first step of a turn ranks against the previous message
and the current one takes effect from the next step. Idle pruning, the counter
baseline, and `mcp_search_tools` are unaffected by this read.

This is presentation, not permission. A tool the model cannot see is still
callable when the model already knows its name, and the model may call it
directly; only what is *listed* changes. Nothing is ever unregistered: each
request gets the registry's own tool list plus the active schemas, deduplicated
by name, and `activationEnabled: false` turns the whole mechanism off (every
mounted tool is listed exactly as before, and no search tool is registered).

Implementation note — the presentation rides the agent's own
`system-prompt/assemble` waterfall, registered *prepended* so it runs outermost
and sees the list after other presentation plugins (for example
`dsh-progressive-tools`) filtered it. That listener is contained: if this
plugin's own work fails, the assembly the rest of the harness produced is
returned unchanged, so a broken probe can never break a model request. One
residual ordering risk remains: a presentation plugin that trims the list to its
own allowlist and ends up *outside* this listener (it registered its own
prepended listener later) drops the schemas this plugin added, leaving only the
tools that plugin allows. What that surfaces looked like is why the discovery
tool is offered by this listener rather than left to the registry — but it is
still trimmed in that nesting. A deployment that wants the discovery path in
spite of it can name `mcp_search_tools` in that plugin's own allowlist (in
`dsh-progressive-tools` that is `eagerTools`), which makes the tool survive in
either nesting; the MCP schemas themselves cannot be pinned that way, because
they are project data, not configuration.

## Project guidance in the system prompt

The per-server `mcp:<server>` sections mcp-client publishes say what a server
*is*, and the activation surface above makes many of its tools invisible — but
nothing told the model that a tool it cannot see may still be asked for. The
host half adds one short section (`guidanceEnabled: true`, the default) that
says exactly that, next to the mounts it describes:

```text
## Project MCP servers

Project `project1` mounts 2 MCP server(s) in this session.

- memory (stdio, active)
- tglider (stdio, active) — code intelligence

Most used in this project's sessions, offered from the first step on: recall,
find_symbol — call them directly, no search needed.

3 of 14 MCP tool(s) are offered directly; the other 11 are offered on demand —
call `mcp_search_tools` with a keyword or a tool name (several words are
matched one by one), and a tool it activates becomes callable from the next
step. Search once with the best keywords you have; when the search reports no
match, this project mounts no such tool — report the gap instead of rephrasing
the search or guessing a name.

On demand right now: batch_rename, changed_symbols, diagnostics, find_callers
+7 more — every one of them runs when called by its exact full name
`mcp__<server>__<tool>`; search a name with `mcp_search_tools` first to see its
description and parameters.
```

- **Deterministic and bounded.** Servers are listed in code-unit name order,
  and the deferred surface is one flat names line — sorted, deduped, capped at
  twelve names with `+N more`. The whole section is capped at 1200 characters,
  so an extreme project loses trailing server bullets (folded into
  `… and N more server(s)`) before it loses the on-demand instruction and the
  names line.
- **A names line instead of schemas.** Descriptions and parameters are the
  expensive part, so the section lists bare names only: the model picks the
  tool it needs and runs one targeted `mcp_search_tools` query instead of
  probing blindly. The line also states the direct-call contract — deferral
  trims the assembled request list, it never unregisters the tool, so a call by
  the exact full name `mcp__<server>__<tool>` still executes; searching first
  is how the model sees the description and parameters, not a gate.
- **A most-used line from the durable counters.** When the seeded baseline is
  non-empty, the section names the project's hot tools (most-called first, up
  to four names with `+N more`) and says they are offered from the first step
  on — so the model calls them directly instead of searching for what it
  already has. With `activationEnabled: false` the line is dropped, like the
  rest of the activation story.
- **An anti-loop hint.** The on-demand paragraph ends with the search
  etiquette: one search with the best description at hand, and a no-match
  answer means the project mounts no such tool — report the gap instead of
  rephrasing the search or inventing a name.
- **Placed with the MCP sections.** The section is registered through
  `ctx.inject(['systemPrompt'], …)` at the `MCP_SERVERS` order, with a name
  (`mcp-project-guidance`) whose code-unit order precedes every `mcp:<server>`
  instruction block — the same convention `mcp-resource-servers` uses — so the
  guidance is read ahead of the servers it introduces.
- **Live, and released with the scope.** `text` is a callback: it reads the
  session's mounts and the registry at every assembly, so a rescan that mounted
  or dropped a server changes the text without re-registering anything. The
  registration is owned by the agent scope and released exactly where its mounts
  are (`projectMcp.release()`, idle timeout, agent disposal).
- **No local identifiers.** The project is named by its `~`-collapsed directory
  label, never by its absolute root, and the section carries no endpoint, no
  argument and no document path. A section that fails to build returns `''`
  rather than failing the model request that asked for the assembly.

`guidanceEnabled: false` registers no section at all. With `activationEnabled:
false` the section still lists the mounts but drops the on-demand paragraph,
the names line and the most-used line, because nothing is deferred and nothing
is seeded.

## Lazy mounting and idle release

A profile with twenty project folders must not start twenty projects' worth of
servers. A session's project is mounted on its **first turn**, and the mount is
scoped to the session that asked for it:

```
session created            → nothing runs; rows read `idle`
one session's turn         → that session's project starts, nothing else
idle for idleTimeoutMs     → scope disposed; rows read `idle` again
next turn                  → mounted again from scratch
```

The isolation rule is one pure, exported function — `mountTrigger` in
`src/runtime.ts`. A pass starts a session's servers only when *that* session
asks: its own turn, an operator request that names it, `lazy: false`, or a
session that already holds mounts and is being reconciled. A session that is
merely live — restored, listed, idle, or another session's neighbour — never
starts anything, so a twenty-project profile stays at zero children until one of
its own sessions works there.

Two agent-plane events drive it: `agent/status` (`idle`/`running`) marks
activity, and `agent/pre-step` is awaited by the loop, so the plugin can wait
for a pending mount (`activationWaitMs`, default 2 s) and the step's request
already sees the project's tools. The hook always continues the waterfall — a
project MCP server is never a reason to block an agent step.

A mount is released on the first path that exists; only the quiet session needs
a clock:

- a session the host no longer lists releases its mounts on the next pass — no
  timer, no status event, and it works with `idleTimeoutMs: 0`;
- `agent/disposed`, an explicit `projectMcp.release()`, and a move to another
  project dispose the session's scope where it lives;
- the idle sweep releases a quiet session after `idleTimeoutMs`. It reads the
  host's own `agent.status` where the composition publishes one, so a session
  whose `idle` transition never reaches the plugin cannot pin its mounts behind
  a stale flag.

- `lazy: false` restores eager mounting at session creation; idle release still applies.
- `activationWaitMs: 0` never waits: the first request of a reactivated session
  may run without the project's tools, which appear from the next step on.
- An operator call — `projectMcp.syncNow()`, `projectMcp.syncSoon()`,
  `projectMcp.retry()` — requests every listed session, or only one project's
  when it names a root, so it mounts a lazy declaration without a turn. That is
  the one path that starts a server for a session which is not working, and it
  is deliberate: the `POST sync|retry` routes and scripted reconciliation call
  it. `syncSoon()` and `retry()` answer as soon as the request is accepted — the
  pass is background work, and the panel reads its outcome off the status
  channel instead of holding a response open for `connectTimeoutMs`.
- Every created process writes exactly one `info` line naming the session, the
  project root its working directory resolved to, and the trigger (`turn`,
  `mounted`, `eager`, `operator`). It is written when the mount is created, never
  by a rescan pass that re-derives the same mount.

## Sidebar panel

The package has a browser half (`./client`) that registers a tab with
[`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar). A tab
belongs to one conversation, so it shows **only that session's project** — never
another one: the servers it declares and their merged live status, then the same
project broken down **per session** — which session holds a mount, which has not
turned yet, which one is this tab's — with `Sync` / `Release` actions. `Release`
gives one session's hold back: the shared instance keeps running while another
session of the project holds it, and stops when it was the last holder.

Both operator actions are **scoped to the project the surface shows**: the tab
and the settings page name that root in the request, the host touches only its
servers and answers with its slice of the snapshot (the settings page asks for
the whole snapshot back, since it lists every project), and the pass is queued
rather than awaited — the answer arrives immediately, not after the servers have
settled.

Four view modes, switched in the toolbar and remembered in `localStorage`:
`Servers` (everything, the default), `Tools` (what the model sees of this
project — pins, disclosed and hidden tools, the budget line), `Problems` (only
`error` / `conflict` / `connecting`, grouped in that order, with `Retry failed`
alongside `Sync`) and `Logs` (the plugin's own event ring, below). Every state
that has nothing to list names what is missing instead of showing an empty box —
no session, no project marker above the session cwd, no declared server, or
nothing that needs attention.

The same tab declares its own settings panel in the side card settings popup, and
that panel is where the whole picture lives: **every** project with a live
session, not just this tab's, plus the panel's poll interval, persisted in the
sidebar's `pluginSettings`.

`ctx.betterSidebar` exists only in the browser half, so the panel does not call
the runtime in process: the host half registers HTTP routes on the DSH web server
(`/project-mcp/snapshot|events|logs|sync|retry|release|save|pin|policy`, see
`src/ui.ts`) and the panel fetches them. Responses are `{ ok: true, value }` or
`{ ok: false, error }`.

`GET /project-mcp/events` is the status channel: Server-Sent Events, one frame
per change (`event: change`, `data: { revision, snapshot }`), and a `hello` frame
carrying the current picture the moment a panel subscribes. DSH's web server
hands a route the raw response and exempts `text/event-stream` from its gzip
filter, so the stream is not buffered; a comment frame every 15 s keeps an idle
connection warm. The panel stops polling while the stream is open and falls back
to its poll — `DEFAULT_REFRESH_MS`, or the interval from the settings popup —
whenever it is not (an older host half, a browser without `EventSource`, a
dropped connection, which `EventSource` reconnects on its own).

`Logs` is the tab's fourth mode and reads the plugin's own event ring
(`src/logs.ts`): up to 200 events per project, the snapshot carrying the latest
50 and `GET /project-mcp/logs` paging the rest (`before` cursor, `limit`). One
event is `info` / `up` / `warn` / `error`, carries the project root, optionally a
session and a server, and one line of message. The runtime publishes each of its
five lifecycle events once, through the notification service
(`src/notifications.ts`) — mounting, `is up`, a stall, a failed mount, unmounting
— and both readers subscribe to that publication: the ring, and the line the host
log gets. The tab and the log therefore carry the same event, with no second
write path to keep in step. Filters (`this session` / `all sessions`, `all levels` /
`errors`) are client-side and remembered per browser; the level opens on `errors`
and an empty list under that filter says the ring holds other events instead of
claiming there are none. `Clear` is a client mark in `localStorage` (`logsClearedAt`) —
there is no clear route. A page that fails to arrive is a line under the list,
not a broken tab.

Toasts are the same picture on the frame: a server that starts or stops while a
panel is subscribed floats a banner in DSH's `shell.overlay` floating layer
(`src/client/toasts.ts`) instead of only changing a row in a tab nobody is
looking at. They are fed by the same status channel — `serverTransitions()` diffs
what the `change` frames of `GET /project-mcp/events` say, and the baseline
`hello` frame only resets it, so a page load or a reconnect never reads as twenty
servers starting at once.

```
browser:  ctx.inject(['betterSidebar'], s => s.betterSidebar.registerTab({ … }))
          fetch('/project-mcp/snapshot')
host:     ctx.webServer.register({ kind: 'prefix', path: '/project-mcp', … })
```

Requirements: `react` in the composition. If the host already provides a
`betterSidebar` service, the sidebar tab is registered; otherwise the host half
keeps mounting servers. Client changes hot-reload (hard-refresh the browser);
host changes need a `dsh web` restart.

### Settings page

The browser half also contributes a page to DSH's own Settings
(`settings.section`, kind `list`, scope `root`, declared by the settings shell), a
Plugins settings section). That is the one surface where **every** project with a
live session is visible: a project picker plus two remembered views — `Table` (a
dense overview of server, transport, status, source and the `enabled` switch) and
`By files` (one card per declaring document, in priority order, each card showing
the servers it declares and the `overrides <name> from <file>` line a later
document caused). The view is remembered in browser-local storage
(`dsh-project-mcp:settings-view`); the page has no `pluginSettings` blob of its
own.

Alongside the two server views the same section carries the project's `Tools`
page, and every figure on it is the host's own: the mode and the pin list come
from the project policy (`setPin` / `setPolicy` write them back), the per-server
counters are read from the session's visible and deferred tool names by the
`mcp__<server>__` prefix, and the request preview is the visible list plus the
serialized sizes (`visibleChars` / `deferredChars`, tokens = characters / 4).
There is no slot figure and no prefix switch: the budget is measured in
characters, and the `mcp__<server>__` prefix is applied by
`@deepseek-ai/dsh-mcp-client`, not configured here.

Selecting a server opens the split editor: the project's servers on the left, the
parsed entry as a form in the middle, and a JSON pane on the right showing the
difference between what the document declares and the edit. The host half serves
the write path behind that form (`POST /project-mcp/save`, see *Writing entries*
below and `docs/design/contracts/write-path.md`); creating and deleting servers is a
separate step and is not part of it.

Registration is two-step and deliberately partial:

```ts
ctx.inject(['slots', 'locale'], (scope) => {          // optional client services
  scope.locale.addLanguage({ id: 'ru', label: 'Русский', fallback: 'en' })
  scope.effect(() => scope.locale.register(NS, { zh, en, ru }))  // + a second register for projectMcp.host
  // The slot is declared by the Plugins section at runtime, and
  // `slots.register` throws while it is undeclared — so wait for it.
  scope.slots.inject('settings.section', () => scope.slots.register({ … }, SettingsTab))
})
```

The module-level `inject` is empty, and neither `betterSidebar` nor `locale` is
listed there: an entry that waits on an optional service stays **pending**, and
DSH's web boot audit refuses to start while any entry is pending. Both are read
without gating the entry instead — the sidebar tab parks behind
`ctx.inject(['betterSidebar'], …)` (so it registers whenever that service exists,
in a composition that has one), and the tab's translate seat comes from
`ctx.get('locale')`. A property read of a service the fiber did not declare
throws `cannot get property "…" without inject` and fails the entry, which is
what took the whole GUI down in 0.1.9. The host half and every slot-based surface
continue without either service. The bundle requests
`@deepseek-ai/dsh-client-ui-slots` (a baseline platform module) and
`package.json` declares `@deepseek-ai/dsh-client-locale` and
`@deepseek-ai/dsh-client-ui-settings` under `dsh.client.inject` — package-name
materialization edges, not Cordis services.

### Writing entries

`POST /project-mcp/save` writes **one existing entry** back to the document that
declares it (`ServerRow.source` — even when a higher-priority document overrides
it, because that is where the entry lives). The request carries the entry body,
the declaring document and the `documentRevision` the editor was built from.

Tiers (`ServerRow.writeScope`):

| Tier | Documents | Condition |
|---|---|---|
| `project` | the resolved `localFiles` of the project | form confirmation |
| `global` | the resolved `globalFiles` of the deployment | `consent: true` **and** `allowGlobalWrite: true` |
| `readonly` | profile, `<DSH_HOME>`, bundled | never; `writeBlockedReason` says why |

Order of the checks, all before a byte is written: the row exists (`not-found`);
the document belongs to a writable tier and, for `global`, both gates are open
(`blocked`); the request's revision equals the document's (`conflict`,
`documentRevision` is a short SHA-256 prefix of the bytes); the edited entry
passes the same parse path as mounting (`invalid`). Only then is the document
replaced: `<document>.bak` first, then a temporary file in the same directory,
then `rename` over the original — a failure at any step leaves the document
exactly as it was, and a write failure answers `failed`. Formatting is
normalized (two spaces, trailing newline) while every other key of the document
and every key the editor does not present are preserved. After the write the
project is rescanned and the answer carries the fresh snapshot
(`{ ok: true, value: <snapshot> }`).

Secrets: `env`/`headers` values are handed to the editor only when the document
holds them literally. A masked key submitted without a `value` keeps what the
document declares, a key with a `value` writes that value, and a key the
submission omits is removed — so an editor that cannot see a secret can neither
erase nor replace it (`value: ''` is an empty value, not an omission). A key
answered outside the document — by the project's `.env` or by the credentials file
— is marked `fromCredentials` and its resolved value is never written back: the
declared text (usually a `${input:NAME}` reference) stays as it is.

Errors keep the plugin's envelope and code: `400` for `invalid`, `blocked`,
`not-found`; `409` for `conflict`; `500` for `failed`.

## Diagnostics

A server that never comes up is the one failure a project-scoped mount cannot
recover from on its own, so it is reported instead of being retried forever.

- **`connecting`** — mounted, no tool yet. Normal while a command boots.
- **`error` after `connectTimeoutMs`** — the mount produced no `mcp__<name>__*`
tool inside the window. The row (and a matching `issues[]` entry) then carries a
facts an operator needs: the server name and how long it has been waiting, its
endpoint, and the document that declared it.

  ```
  gateway: no tool appeared in 4m 27s
  endpoint: stdio docker
  declared in: /repo/.dsh/mcp.json
  ```

  Facts only, on purpose: the row already carries the status, the transport chip
and a `Retry` button, and a stdio server's own reason is on its stderr — in the
DSH log.

  The watchdog is read-only: it never disposes a slow server, and a mount that
connects later goes back to `active` with the detail cleared.
- **`error` from activation** — with `failOnStartupError: true` the failing
attempt itself rejects, and the row carries the underlying error plus the same
context; such a mount is never retried implicitly.
- **No respawn storms** — a failed or stalled mount is not re-mounted on later
passes. Fix the cause, then call `projectMcp.retry()` (or edit the declaration,
which re-mounts it too).

Error text is redacted on purpose: it names the command but never its arguments,
and an HTTP endpoint keeps its path but drops the query string, because both can
carry credentials.

## Resource behaviour

Measured by `scripts/audit.mjs` against the real `mcp-client` and real child
processes (with a 400-tool catalog stub) on Node 24.13 and Bun 1.4.2 — every
check passes on both:

| scenario | result |
|---|---|
| idle project, 4 s | 0 passes, 0 catalog scans, ~1 ms CPU (Node) |
| 600 unrelated writes (`node_modules`, `dist`, `.git`) | 3 watch events → 1 pass, 0 catalog scans, 0 remounts |
| mount → dispose | MCP child process exits, its pid file is removed |
| server that cannot start | one detailed `error` row, no respawn storm, no leaked child |
| 10 × session create/dispose | 0 surviving children, file descriptors flat, heap +0.9 MB |
| two sessions, one project | 1 mount attempt, 1 child, 1 creation line — the second session's turn reuses it |
| a release while another session holds | child stays up for the remaining holder, goes down with the last one |
| teardown | watchers closed, descriptors released, 0 passes and ~1 ms CPU afterwards |

What keeps it that way: only the project's own document directories are watched
recursively (a flat watch on the project root notices a config directory
appearing), watcher events are debounced, a rescan compares config digests and
returns without doing anything when nothing changed, and the rescan timer,
watchers and every scope the plugin minted — per session and per project — are
released by the plugin fiber.

## Runtimes

Verified with **Node 24.13** and **Bun 1.4.2** — both the plugin and its checks:

| | Node | Bun |
|---|---|---|
| `test` | `pnpm test` (vitest) | `bun test tests` |
| resource audit | `pnpm audit` | `bun scripts/audit.mjs` |
| live smoke | `node scripts/live-smoke.mjs` | `bun scripts/live-smoke.mjs` |
| build | `pnpm build` | `bun run build` |
| host runtime | `dsh` (Node) | `bun $(which dsh)` |

The plugin imports only `node:fs`, `node:os` and `node:path`, reads the ambient
`process.env`, and spawns MCP servers through `@deepseek-ai/dsh-mcp-client`, so it
behaves the same under either runtime. Watches prefer `fs.watch({ recursive: true })`
and fall back to flat watches on the project root and each config directory when a
runtime or platform cannot watch a tree recursively — the rescan timer covers the
rest either way.

## Verifying

```bash
# real Cordis host + real @deepseek-ai/dsh-mcp-client + a fixture stdio server
pnpm build && node scripts/live-smoke.mjs     # prints the registered tool + snapshot
bun scripts/live-smoke.mjs                    # same check under Bun

# mount a real project's own documents and report what the servers publish
pnpm check:config .                           # -> tools: mcp__tglider__*
CHECK_CONFIG_TOOL=mcp__tglider__server_status pnpm check:config .   # call one tool

# the sidebar tab against the frozen surface contract, out of a live profile
# (needs a profile that links this checkout: `dsh plugin --profile test-web add link:<workspace>`)
pnpm design:parity                            # PASS / ACCEPTED / SKIP / FAIL per element
```

`design:parity` boots the `test-web` profile's own `dsh web` (which must
`link:<workspace>` this checkout), opens the tab and compares the computed
styles of what the panel draws, row by row, with the expected values frozen as
literals inside `scripts/design-parity.mjs` — in the live shell's own theme.
The rationale for each rule lives in `docs/design/contracts/surfaces.md` §9 and
`docs/design/contracts/single-surface.md`: the doc explains, the script decides,
and a surface change updates both in the same pass. The gate no longer diffs
against a picture: the design stand (`docs/design/mockups/harness.html`) is a
proposal allowed to run ahead of the product. The panel is fed a payload of the host's own
shape, because a profile started only for this measurement has no live agent
until a session runs a turn, and the plugin publishes a project only for a live
agent: the fixture puts every state the contract names on screen at once. It
prints the profile, the session and the bundle (path, size, build time, sha256)
it used. `ACCEPTED` is a documented exception with its authority named in the
contract, and it fails as soon as that authority moves under it; `SKIP` is a row
the run could not observe, and is never counted as a pass. `--dump` prints both
raw captures, `--watch` the panel's own reading once a second.

Manual acceptance on a running GUI:

1. A session whose `cwd` is inside a project with `.dsh/mcp.json` (or whichever
   document `localFiles` names) sees that project's `mcp__<name>__*` tools (check
   the session tool catalog), and a second live session of the same project
   resolves the same instance rather than a second process.
2. A session in a project without such a file sees **no** project tools.
3. Two sessions in two projects see different sets; the same `serverName` in
   both projects resolves to different servers.
4. Editing the file adds/removes tools after the debounce (~300 ms), without a
   restart and without disturbing the profile-level servers.

## Limitations

- Per-project cost: one MCP instance per project per server, shared by every
  session working there (a subagent in the same project does not start a second
  one). HTTP servers are cheap; `npx`/`uvx`/`dnx` stdio servers spawn a process
  each, so a wide multi-project session graph still costs one child per project.
  Use `enabled: false`, or keep a server in the profile when every project needs
  it.
- Writes edit existing entries only: the editor replaces
  `mcpServers[<server>]` in the document that declares it. Creating and deleting
  servers, and writing a document that does not use an `mcpServers` object, are
  not supported (the latter answers `blocked`).
- A config edit that keeps `JSON.stringify` of the generated config identical is
  a no-op by design (no remount, no dropped connections).
- `profileWins` cannot un-mount a profile entry; remove it from
  `cordis.patch.yml` to hand a server over to the project plane.

## Dogfooding

This repository declares its own MCP server in `.dsh/mcp.json` — `tglider`
(TypeScript/JavaScript code intelligence) with `--workspace .`, which the plugin
resolves against the project root it launches in. `pnpm check:config .` mounts
that file through the plugin and lists the published `mcp__tglider__*` tools.

## How it works

1. **Project discovery** — for every live agent (session), the plugin walks up
   from `agent.session.header.cwd` to the first directory carrying a project
   marker (`.git`, `.dsh`, `.kimi-code`, `package.json`, `*.sln`/`*.slnx`/`*.csproj`).
2. **Scope minting** — the project's servers are mounted **once per project**
   inside a Cordis scope minted for it (`createScope(hostCtx, projectKey)`), the
   same pattern the in-box `browser-use-runtime` uses for MCP servers. Every
   session of that project gets its own scope, parented to the project's
   (`bindScopeParent(agent, projectKey)`): the tools registry resolves a
   session's catalog through that chain, so one instance serves every session
   working in the project — subagents and Agent-Teams members included — and a
   session of another project never resolves it.

   `dsh-scope` binds a key's parent **once**, and a session composed from an
   agent preset — every session of the Web GUI — has its key parented to that
   preset's standing scope by the harness before the session is published. Such
   a session cannot join the project's layer at all, so the plugin mounts the
   same declarations **under the session's own scope** instead: an exact-key
   layer always resolves for its own key, with no parent link to lose. That is
   one instance per session rather than one per project, and the `info` line
   says which of the two shapes a session got.

   Reading the project's servers only after that link, or reporting a mount the
   session cannot resolve as connected, is what the 60-second `no tool appeared`
   row used to be: a healthy child process paired with an empty catalogue.
3. **Lifecycle** — `agent/created` mounts, `agent/disposed` (and the agent's own
   effect) tears down, a debounced `fs.watch` plus a rescan timer pick up config
   edits, and a config change disposes and re-mounts only the affected server.
   The shared instance follows the project's **last holder**: a session that goes
   idle, releases, is disposed, or moves to another project gives its hold back,
   and the servers stop exactly when the last of them lets go.

Because `@deepseek-ai/dsh-mcp-client` reserves a `serverName` per *registration
scope*, two different projects may declare the same name (`rider`, `gitea`, …)
without colliding with each other or with the profile.

```
profile scope : gitea, context7, ...          → every session
agent scope A : .dsh/mcp.json of project A    → only sessions in A
agent scope B : .dsh/mcp.json of project B    → only sessions in B
```

## Bundle format (do not "fix" this)

DSH does not `import` a plugin bundle. The web client concatenates several
plugins' `client.js` into **one classic script** and materializes each through a
Lazy-CJS module table:

```js
// lib/client.js — generated by scripts/wrap-client.mjs
window.__ModuleLoader__.load({
  id: 'dsh-project-mcp',
  factory: (require) => { /* CJS body; require('react') resolves against the platform table */ },
})
```

Three consequences, each guarded by a check:

- the client target builds as **CJS** (`tsdown format: ['cjs']`) and is wrapped
  by `scripts/wrap-client.mjs`, which runs as part of `pnpm build`;
- the bundle must contain no statement-level `import`/`export` — it would be a
  syntax error that aborts the whole batch, taking unrelated plugins down;
- every `require(...)` must be a baseline module (`react`, `react/jsx-runtime`,
  …). Anything else throws at materialization, because the `require` handed to a
  factory is synchronous and cannot await a fetch.

`tests/bundle.spec.ts` replays that exact load path against the built bundle and
`pnpm audit` re-checks the shell, the ESM-free body and the module requests.

## Layout

```
src/index.ts       plugin entry: Config schema, apply, projectMcp service
src/runtime.ts     per-agent scope minting, mounting, diffing, watchers
src/discovery.ts   project root + document paths + credentials + project .env files
src/parse.ts       mcpServers -> mcp-client config, ${VAR}/${input:...}, dotenv/credentials, merge
src/write.ts       editor write path: revision, declaration, atomic replace
src/ui.ts          host HTTP routes: snapshot, events (SSE), sync, retry, release, save, pin, policy
src/usage.ts       durable per-project tool-call counters
src/policy.ts      durable per-project tool policy: mode (disclosure/direct/off), pins
src/guidance.ts    project-MCP guidance section: deterministic text + wiring
src/types.ts       snapshot/row vocabulary
src/client/        browser half: sidebar tab, side card settings, native
                   Settings page (`settings.section`), shared view helpers
tests/             unit tests (parse, discovery, runtime, guidance, both views),
                   plus a load-path guard for the wrapped client bundle
scripts/           MCP fixture server, live smoke test, resource audit,
                   project-config checker, bundle wrapper, panel screenshot and
                   the surface-parity check
```
