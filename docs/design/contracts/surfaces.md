# Surfaces: what the interface looks like today

This is the only description of what the user **sees right now**. It freezes the composition,
order and vocabulary of every surface; the decisions this look grew from live in
`single-surface.md` (F-26), `../history/` (the wave history) and §8–§9 of this file (the value
sources and what the checks hold).

The picture of all surfaces inside the harness shell is `mockups/harness.html` (a self-contained
file: the tokens copied from the DSH design system, the markup from the client's components). It
is a **project** of the interface: it runs ahead of the product in copy and in the block scheme,
so it cannot be the expected side of a machine comparison. The machine acceptance is
`pnpm design:parity` (`scripts/design-parity.mjs`): it checks the **live** panel against the
contract written below, reading the `getComputedStyle` of drawn elements in the live shell's
theme. Sections 8 and 9 are the map of value sources and the list of what exactly the checks hold.

## 0. The five surfaces and their code

| Surface | Where it lives | Code | Host seat |
|---|---|---|---|
| A. The sidebar tab | DSH's own right sidebar, one page per pane | `src/client/view.ts` (`ProjectMcpPanel`, `view.ts:1093`) | the `sidebarRightTabs` registry plus the keyed `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` seats (`src/client/sidebar-tab.ts`), type id `dsh-project-mcp:servers` (`src/shared.ts:17`), kind `project-mcp`, guide entry order 55 |
| A′. The tab's settings popup | opened from one row of the tab chip's actions menu, drawn in the frame's floating layer | `src/client/view.ts` (`ProjectMcpSettings`, `view.ts:2441`) | the `sidebar.right.tab.menu.item` slot, id `dsh-project-mcp:settings`, order 60, plus the `shell.overlay` entry id `dsh-project-mcp:settings-dialog`, order 61 (`src/client/sidebar-tab.ts`) |
| B. The page in the native settings | a separate settings navigation item | `src/client/settings.ts` (`SettingsPage`, `settings.ts:1996`), `src/client/settings-tools.ts` (`ToolsPage`) | the `settings.section` slot, id `project-mcp`, order 900 (`settings.ts:289-299, 380-395`) |
| T. Toasts | the frame layer | `src/client/toasts.ts` (`ToastStack`) | the `shell.overlay` slot, id `dsh-project-mcp:toasts`, order 60 (`toasts.ts:41-47`) |
| C. The Plugins-page config card | the Plugins manager page, the bundle's detail | `src/client/plugin-config.ts` (`PluginConfigCard`, `plugin-config.ts:374`) | the `plugins.bundle.config` slot, key = package name (`registerPluginConfigCard`, `plugin-config.ts:697`), registered only while `configForms.whileServed` serves a namespace (`src/client/index.ts:178-185`) |

Surface C is **host-embedded**: the Plugins page is the harness's own and draws the section
chrome (the card's title, the plugin icon, the save semantics), so the card draws only its rows
— the same inline-`style`/token approach as every other surface, no chrome of its own. The
stand and the gate are deliberately untouched: `mockups/harness.html` has no canvas for a page
the harness owns, and `pnpm design:parity` checks only this plugin's own surfaces in the live
shell, so neither file gained a rule for C.

The client has no style classes: **the whole look is inline `style` objects** (`STYLE` in every
module), zero `ds-*`-style classes. So "comparing the look" for the mocks rests not on CSS classes
but on the **DOM shape**: a disclosure is a `div` with a child `button[aria-expanded]`; the tab's
body is the panel's first descendant with `overflow-y: auto`. Any edit to the shape (rather than
to a class name) breaks the gate — and must break it.

The shared names both the code and the gate rest on:

| Name | Value | Source |
|---|---|---|
| `INDENT` | 12 px; the tiers `project 0 → sessions 12 → session 24 → its servers 36` | `view.ts:259, 377` |
| `STATUS_COLOR` | `active` → `--dsw-alias-state-success-primary`; `connecting`/`conflict` → `-state-warn-primary`; `error` → `-state-error-primary`; `idle`/`disabled` → `-label-tertiary` | `view.ts:209-216` |
| `STATUS_HINT` | a one-line explanation of each status (goes into the row's `title`) | `view.ts:219-226` |
| `MCP_TOOL_PREFIX` | `mcp__`; the server is the second `__` segment of the name | `view.ts:1519-1526` |
| `LAYER_3` | `--dsw-alias-bg-layer-3` — the `tag` chip's background | `view.ts:246` |
| `TONE.secondary` / `TONE.tertiary` | `--dsw-alias-label-secondary` / `-label-tertiary` | `view.ts:238-243` |

## 1. Surface A — the sidebar tab

One surface: there is no `Servers | Tools | Problems | Logs` segment bar, the mode is not
remembered. The body order is the `single-surface.md` contract.

### 1.1 The bar (`STYLE.bar`, `view.ts:269-277`)

`display:flex; align-items:center; gap:6; padding:7px 9px; border-bottom:1px solid var(--dsw-alias-border-l1); flex-wrap:wrap`

| Place | Element | Condition | Text |
|---|---|---|---|
| 1 | `span`, `STYLE.name` (mono), `title` = `projectRoot` | there is a project | `basename(projectRoot)` |
| 1 | `span`, `STYLE.muted` | there is no project | `no project` (`en.noProjectLabel`) |
| 2 | `span`, `STYLE.tag` | there is a project | `this session` (`en.thisSession`) |
| 3 | `span`, `flex:1` | always | — |
| 4 | `button`, `STYLE.button`, `disabled` while polling | always | `Sync` (`en.sync`) |
| 5 | `span`, `STYLE.dim` | always | `1 session` / `{count} sessions` (`en.sessionsOne/Many`) |

### 1.2 The body (`STYLE.body`, `view.ts:279-287`)

`flex:1; min-height:0; overflow:auto; padding:9px 10px`. Inside — blocks strictly in this order:

1. **The session's servers** (`ServersBlock`, `view.ts:1844`) — always, except the "nothing is
   declared" case.
2. **The `sessions` section** (`SessionList`, `view.ts:2739`) — only when at least one session
   diverges from the project (F-24); otherwise not drawn at all.
3. **The tools block** (`ToolsSection` → `ToolsView`, `view.ts:1378, 1909`) — always.
4. **The `Problems` disclosure** (`Disclosure` + `IssueView`) — only when there are problem
   groups (`groups.length > 0`); collapsed by default.
5. **The `Logs` disclosure** (`Disclosure` + `LogsView`) — always; collapsed by default.

If there is no session, the body is replaced by the empty state
`No session is attached to this tab.`; if there is no project —
`This session’s folder is not inside a project yet.` The bar stays in both cases.

### 1.3 The session servers block (`STYLE.serversBlock`, `view.ts:366`)

Shows **this session's own rows** (`sessionRowsOf`), not the project's merged view.

* the header row: `span.groupInline` (`SERVERS`, uppercase via `text-transform`), a spacer, a
  `{up}/{total} up` chip — `STYLE.tag`, and at `failed > 0` — `tagWarn` (red text); the chip's
  `title` — `name: status`, one line per server;
* one row per server (`STYLE.row`): an 8 px dot (`STYLE.dot`) in `STATUS_COLOR[status]`, the name
  (`STYLE.name`, mono), the status word (`STYLE.muted` + the status colour), the transport chip
  (`STYLE.tag`, `http`/`stdio`);
* the row's `title` = `detail`, else `STATUS_HINT[status]`;
* **F-55 — the failure's own `Retry`.** A row in `error` carries the project's retry at its right
  edge (`STYLE.button`, `title: retryHint`, `disabled` while a host action is in flight), so the
  broken server is pressed where it shows rather than behind the errors disclosure (`Retry`, §1.4)
  or on the Servers page's table. It is the same action those surfaces send — one built button
  (`retryButton`), not three copies of the markup. No other status carries it, and a surface that
  hands no `onRetry` down draws none: a read-only panel offers no dead press;
* **F-32 — idleness.** On quiet rows (`idle`/`disabled`), when the host published
  `usage[server].lastUsedAt`, a quiet `idle {n}d` / `{n}h` / `{n}m` follows the status word
  (`STYLE.dim`): whole days, hours, otherwise minutes. `active`, `error` and `conflict` do not
  have it — idleness is printed where it exists, not on a working server. No `usage` record — no
  text: a zero the host never counted is not drawn by the contract;
* **all** rows with a `detail` are repeated at the block's bottom as banners (`STYLE.banner`): a
  2 px coloured left bar + the detail text as is (`white-space: pre-wrap`).

### 1.4 The `sessions` section (F-24)

Appears only if there are diverging sessions; those are what it lists. The header counter counts
the diverging ones, not the existing ones.

* the header (`sessionsHeader`, `view.ts:2695`), tier 1: a `▾`/`▸ sessions` button
  (`STYLE.sessionToggle` + `STYLE.dim`, `aria-expanded`), a `1 differs` / `{count} differ` chip,
  the status summary (`summarize` → `1 active, 1 connecting, 2 idle, 1 error, 1 conflict`), a
  spacer, and `merged across sessions` — only when the rows above carry more than one session
  (`merged`);
* per diverging session (`sessionEntry`, `view.ts:2790`), tier 2: a `▸ <short id>` button (an
  open row has no marker at all, `view.ts:2821`), a `this session` chip, the summary, a spacer, a
  `Release` button;
* an open session (`sessionRows`), tier 3: its rows in the `serverRow` form — dot, name,
  transport chip, and on `idle`/`disabled` also a status-word chip (`tagQuiet`) with the whole row
  dimmed (`rowQuiet`, `opacity:.6`); on `error` — a `Retry` button; the detail is drawn as a
  banner on a refusal (`STYLE.banner`) and as a warning banner on a `conflict`
  (`STYLE.bannerWarn`); on quiet rows the detail lives only in `title`.

**F-24's accepted limitation.** `Release` is available only from here, so a project where all
sessions agree has the button nowhere.

### 1.5 The tools block (`STYLE.project`, `view.ts:289`)

The summary row: `what the model sees` (`STYLE.muted`) … chips (`STYLE.chips` + `STYLE.tag`,
`counterParts`), one per tier: `1 pinned`, `1 by the counters`, `2 disclosed`, `2 hidden`.
**A chip with a zero is not drawn** (F-37): zeroes are enumerated not by the row but by the
absence of a chip, and when all four are zero the row keeps only the `what the model sees`
caption. There are four parts, and the first two are tiers of **one** list:
`pinned` = `policy.pins.length` (what the user wrote by hand), `by the counters` = the rest of
`baseline` (what the access counters proved), `disclosed` = `activated + context`,
`hidden` = `deferred.length`. The budget still counts "in every request" as `baseline + disclosed`
(`toolCounts().offering`, `budgetSplit()`) — that unit has not changed. Before F-29 the first part
equalled `baseline.length`, so the row could say "2 pinned" over a pin list of one name.

**With F-43 the chips are also a tier switch** of the filter panel: a pressed chip
(`aria-pressed`, `STYLE.filterChip` + `STYLE.filterChipOn`) leaves one tier, pressing again
returns all, and an empty pressed-tier list **is** "all tiers" — there is no fifth `all` chip, and
the state "no tier selected" does not exist. The chip text is unchanged, `{count} {label}`, and it
stays a leaf with a text child: the tier's number is said once (F-37), so the filter panel has no
second row with the same four words.

The budget (`budgetLine`, `view.ts:1727`) — three branches by the host's fields:

| Condition | What is drawn |
|---|---|
| `deferring: true` | a 4 px bar (`STYLE.budget`) filled to `percent = round(offering / mounted * 100)` (`budgetSplit`) with the caption `{surfaceChars} chars of {budgetChars} · ≈ {chars/4} tokens`; the bar's `title` — `{used} of {total} ({percent}%)` |
| `deferring: false`, `budgetChars === 0` | `the disclosure gate is off: every mounted tool goes into the request` |
| `deferring: false`, `budgetChars > 0` | nothing: the surface fits, and there is no row at all — `budgetLine` returns `null` (F-37). "Nothing is hidden" is already said by the absence of the `hidden` chip, and a sentence repeating it in words was the very empty row the block stopped drawing |

At `budgetSplit().exhausted` (= `deferring`) a `STYLE.warnNote` goes above the groups:
`the budget is spent: further disclosures are rejected with a reason — free room in the budget or pin the tool in the project settings`.

Three groups (`STYLE.group`, uppercase, `opacity:.6`) and one list tier — `hidden` (F-40).
**A tier is drawn only when it has rows** (F-37): an empty tier is not a header over an apology
but nothing, and its zero lives in the summary row's chips, where it is said once:

| Group | Text | Rows |
|---|---|---|
| pinned | `pinned · always in the request` | the `policy.pins` list, **grouped by server since F-44**: a `{server} · {count}` row (`STYLE.group` inside `STYLE.row`) with an `Unpin all` action (`STYLE.button`, the `toolsUnpinServerHint` tooltip) — removing the whole server where what is pinned is visible — and under it rows of names with their own `Unpin`, in the order the user pinned them; empty — no group |
| counters | `offered by the counters` | the rest of `baseline`, with a `Pin` action (F-29): exactly the action the former line `and {count} more offered by the counters alone — pin one to keep it in every request` promised while being drawn without it. No group when there is no remainder |
| disclosed | `disclosed by the model · until the session ends` | `activated[]` (the `HH:MM` time and `step {n}`, a `Hide` action) and `context[]` (only `step`, if the host gave it); empty — no group |
| hidden | a `▸ hidden` disclosure header + a `{count}` chip | a list by server: a `{server} · {count}` row, on which F-44 puts one action for the whole group (`STYLE.button`) — `Pin all` (the `toolsPinAllHint` tooltip) or, if the group is already fully pinned, `Unpin all` (`toolsUnpinAll`/`toolsUnpinAllHint`): the words repeat the `serverPinState` reading, and the write direction is `serverPinPress`, so the caption does not argue with what the press does; a name that is pinned and still lands in `deferred` (a pin between two assemblies) is exactly that case — and a row per name — the same `toolRow` as the other tiers, but with no second level (the list is read in order to choose) and with a single `Pin` action (F-40). The server action is an expansion into names: `policy.pins` stays a list of names, not a rule about a server, and a tool that appears later is not covered by it; both surfaces say the same two words (`Pin all` / `Unpin all`) and write in the direction they named (`docs/design/contracts/policy.md`, "Pinning a whole server"). The tier is deliberately not "chips per server": the counters say how many names are hidden, but a name can only be pulled out of a list, so the tier opens. Closed by default; empty — no tier at all |

`Pin` and `Unpin` are one and the same project-policy write in two directions: both go to
`POST <prefix>/pin` with `{projectRoot, tool, pinned}` (`runtime.ts:998` → `policy.setPin`), so a
pinned name moves from the counters group into the pins group, and back.

There is no `available to the model through mcp_search_tools only` line in the block: it lives as
the `title` of the `hidden` tier's header (F-40), because as a line under the groups it would
repeat the tier itself, and no hidden names — no tier and no caption. If the host reported a
second presentation owner — a `STYLE.warnNote` `Another plugin is shaping the request: {name}. {note}`.

**Identifiers wrap.** `STYLE.name` is mono with `overflow-wrap: anywhere`: a name like
`mcp__tglider__workspace` is one unbreakable token, and the panel in the narrow 330 px stand would
have it stick out of its own row instead of wrapping inside it (`anywhere`, not `break-word`,
because only `anywhere` shrinks the min-content width the flex row measures).

**The tool row is a disclosure** (`toolRow`, `view.ts:1784`): `div` > `button[aria-expanded]`
(`STYLE.toolLine`: the tier dot, the name, the time, `step {n}`) + a sibling action
(`Pin`/`Unpin`/`Hide` — there is no button inside a button) + on disclosure a `div`
(`STYLE.toolDetail`, `flex-basis:100%`, `padding-left:12px`) with the full name (mono) and a fact
line: `server {server} · pinned` / `via: session` / `via: context` + `step {n}` + the time —
**only what the host published**. Since F-56 the body then carries the counter readings apart
(`{n} in the project` · `{n} in this session`, muted — only when the host recorded any) and the
host's own answer about the definition, read once per opened row over
`GET <prefix>/tool?projectRoot=&sessionId=&name=` (`runtime.ts`, `toolFactsOf`): the
model-facing `description` verbatim, the accepted fields (top-level
`parameters.properties`: name, type, `*` when the schema's own `required` names it, the property's
own description; a nested object or array is drawn as its type, and a `default` is never
published), and — for a name the session's request does **not** offer — the reason it is not,
carrying only figures the host measured (`chars` of the definition, `budget`, `used`). The read
draws one muted line while it is in flight (`toolLoading`) and one when the host did not answer
(`toolFailed`); a **deferred** name answers exactly like an offered one, because the definition is
read from the scope bridge that registered it. A row composed without a route (a unit test's own
row) draws that one line and nothing else — no name and no fact line for a host nobody asked. The
contract does not promise a single tool's size, so the disclosure does not have it.

**The filter panel (F-43)** stands between the budget line (and the spent-budget `warnNote`) and
the groups: the query field (`input[type=search]`, `STYLE.filterInput`, `aria-label` —
`toolsFilterLabel`, placeholder — `toolsFilterPlaceholder`; the block's only `input`), a `Clear`
button (`STYLE.button`, only while the filter means anything) and a caption (`STYLE.dim`) —
`showing {shown} of {total}`, and when not a single name passed,
`No tool of this session matches the filter.` The query is a case-insensitive substring over the
registry name (`matchesToolQuery`, edge whitespace trimmed), so `grafana` finds
`mcp__grafana-local__query_prometheus`: the name carries its server as a prefix, and one field
answers both questions. `total` is all the block's rows before filtering (rows, not names: a name
that is both pinned and disclosed is two rows), `shown` is what is drawn given both the query and
the pressed tiers. A tier the filter does not pass is not drawn at all; the `hidden` tier under an
active filter opens **by itself** if nobody pressed its head — the query is about names, and an
answer beyond the fold cannot be read — and its chip counts what is under it (`hidden 1`), while
the chip on top keeps the tier's full number (`3 hidden`): two different questions, and neither
answer is invented. `openHidden` therefore has **three states, not two**: `undefined` — the head
was never pressed, and that is the only state in which the filter is free to open the tier;
`true` / `false` — the user's choice, and it outranks the filter, so pressing the head with a live
filter closes the list (rather than "doing nothing"), and `Clear` does not reopen a manually
closed tier.

One exception to "a chip with a zero is not drawn" (F-37): a **pressed** tier keeps its chip even
after the host zeroed its number in a new snapshot — the chip prints `0 {label}` and stays
pressed. The reason is that the chip became a control: a filter whose switch vanished leaves an
empty list that nothing can explain (`Clear` is available, the cause is not). Released — the zero
is not drawn again.

The tier chip's plate is the reading chip's plate, and the gate reads this as a separate row:
`font: inherit`, which the button needs, is a shorthand, and written **after** the plate it resets
both the mono stack and the size, handing the chip to the shell's sans font; so in
`STYLE.filterChip` the reset stands before `LAYER_3_CHIP`, and the gate's row compares the chip's
size with the panel body's size.

The panel is the block's own state, and only that (F-43): the query is stored nowhere and does
not survive a reload (unlike the log ring's filters, which are worth a host query), `Clear` exists
only while the filter means anything, and a `ToolsView` without writers (a pure test; the
`design.ts` design mode composes the same `tabBody`, so its panel works) draws exactly the tree
that existed before F-43, except the caption: a filter set without a writer still hides rows, and
staying silent about that is the one thing the panel must not do.

**F-32/F-34 — frequency.** From the host's counters a row carries a quiet `{n} calls` right after
the name — the very number with which the host proved `baseline` and for which the group is called
`offered by the counters`. The server's record exists but this name has no counter —
`never called`; no server record — nothing is printed. The counter is independent of the header's
counters (those count names, this one counts calls) and is not a repetition of them.

The tool is mounted on the project, but the calls are made by the session, so the record has two
halves (`usage[server].tools` and `usage[server].sessions[sessionId].tools`), and the row is
**led** by the half that answers the reader's question in this session. They agree — one number is
printed. They diverge — the project total joins the leading one: `3 calls · 182 in the project`,
and for a name only another session called, `never called · 182 in the project`. The split exists
but the name is absent from it — that is `never called`; there is no split at all (a host older
than F-34) — the project total is printed, and the second number does not appear.

Separately: `tools === undefined` (the host has not published an offer yet) — the empty state
`Nothing to hide yet` + a hint and the line `tools[] = built-ins only · mcp__* not registered yet`
(`STYLE.codeLine`); `policy.mode === 'off'` — `{mounted} mounted · none offered`, the
`STYLE.warnNote` `this project’s MCP tools are switched off` and a hint;
`policy.mode === 'direct'` — the line `nothing is deferred: every mounted tool goes into the request`
instead of the budget.

### 1.6 The `Problems` disclosure

A `div` (`STYLE.disclosure`) > `button[aria-expanded]` (`STYLE.disclosureHead`, tertiary tone,
`▸/▾ Problems` + a chip with the number of groups) + a body (`STYLE.disclosureBody`,
`padding-left:12`) only at `aria-expanded="true"`. The body: `IssueView` — the groups
`error` → `conflict` → `connecting` (`statusGroups`), each with a `{status} · {rows}` header and
`serverRow` rows with `Retry`, and a `Retry failed` button under the tree.

### 1.7 The `Logs` disclosure

The same shape; the header carries the number of **this session's** events (`sessionLogCount`).
The body — `LogsView`: a filter bar (two pairs `this session | all sessions` and
`all levels | errors`, the applied chip of a pair — `aria-pressed="true"` and
`STYLE.logFilterOn`, plus `Clear`), then the groups: a `{count} in this project` header and rows
`div.v-logRow` = the time (mono, tertiary) · the level chip (`info` uncoloured, `up` green, `warn`
amber, `error` red) · the server name (mono) · the message full-width (`flex:1 1 100%`); refusal
facts — `STYLE.logDetail` (a ruler on the left). The empty state: `No events yet` + where to look;
under the `errors` filter, when the ring holds other events — `No errors` + how to switch the
level. At the bottom `Show older` + `showing {shown} of {total}`, or the line
`loading older events…`, or `older events could not be read`.

### 1.8 The parity gate's anchors

The gate (`scripts/design-parity.mjs`) finds the surface **by shape**: the panel is the smallest
block 280–700 px wide and ≥200 px tall with a `Sync` button whose own child scrolls; the body is
the panel's first descendant with `overflow-y:auto`; the bar is the body's sibling before it; a
disclosure is a `div` with a single direct `button[aria-expanded]`; a tool row is the first
`button[aria-expanded]` in the block with the `N pinned` phrase. The "must not be there" checks:
no `[aria-pressed]` outside the disclosure bodies and outside the tools filter panel's tier chips
(in the disclosures those are the log filter chips, in the tools block — `{count} {label}`; there
is no segment switcher among them), the block order top to bottom, the error and log bodies not
visible while the disclosure is closed.

## 2. Surface A′ — the tab's settings drawer

`ProjectMcpSettings` (`view.ts:2441`): the same shape, but the bar is `spn.name`
`Mounted per project`, `spn.muted` `{count} project(s)`, a spacer, `Sync` and `Close`. The body —
one block per project with a live session (`ProjectBlock`, `view.ts:2492`): a header (`basename`,
a `this session` chip on its own session, a spacer, the merged rows' status summary), the merged
rows in the `serverRow` form with details and the same `sessions` section with `Release`. Empty —
`Nothing is mounted yet.`

## 3. Surface B — the page in the native settings

The root `STYLE.root` → the bar `STYLE.bar` (`6px 8px`, `gap:6`, `flex-wrap:wrap`) → the body
`STYLE.body` (`overflow:auto`, `padding:2px 2px 18px`).

### 3.1 The bar

| Place | Element | Condition |
|---|---|---|
| 1 | `Project:` + a `select` (`STYLE.select`) over the projects with a live session | there are projects |
| 2 | `{n} project live session` / `{count} projects live sessions` | there are projects |
| 3 | a spacer | always |
| 4 | the `Servers \| Tools` segment (`STYLE.segment`/`segmentItem`/`segmentItemActive`) | always |
| 5 | the `Table \| By files` segment | only on the `Servers` page |
| 6 | `Show JSON` / `Hide JSON` (`aria-pressed`) | only `Servers` + the `Table` view |
| 7 | `Sync` (`title` = `Re-read host snapshot now`) | always |

### 3.2 `Servers`

* **The table** (`ServerTable`): the uppercase headers `SERVER · TRANSPORT · STATUS · SOURCE · ON`
  + an empty actions column; in a row — the status dot, the name button (`STYLE.serverButton`, the
  selected one — `serverButtonActive` in teal), the transport (`—` if none), the status word in
  colour, the source document (mono, `title` = the full path), the `On` toggle (on — `switchOn`
  with the business colour, off — `switchOff`; a click opens the editor), the row action: `Retry`
  on a refusal, otherwise `…`. Under the table — a warning `STYLE.note` per refusal:
  `<strong>{name}</strong> — {detail}`.
  **F-32.** On a quiet row (`idle`/`disabled`) the same quiet `idle {n}d` / `{n}h` / `{n}m` from
  `usage[server].lastUsedAt` follows the status word as on the tab (`STYLE.hint` — this page's own
  quiet tier): the table and "by files" draw the row with one `serverRow`, so the rule is one; no
  `usage` record — no text.
* **By files** (`FileCards`): one card per document (`STYLE.card`) with a path header (mono),
  `global` and `priority {tier}/{total}` chips, the server count; rows of the same shape without
  columns; under the card — an `overrideNote` on an override (`↳ overrides {name} from {from}` or
  `↳ overrides {name} declared in lower-priority document`).
* **The JSON preview** (`JsonPreview`) — on the `Show JSON` button: `JSON preview`,
  `The snapshot exactly as the host published it.` and the snapshot itself in `STYLE.json`.

### 3.3 The entry editor (`EditorSplit`, `settings.ts`)

The bar: `‹ Back` (`title` = `Return to the overview without changing anything`) and the caption
`Editing {document}: Save asks for confirmation, keeps a {backup} copy and rewrites the entry wholesale.`
(or `Read-only: {reason}`). **Two zones** (F-31): on the left the server list (`Servers`), on the
right a column — the entry form (`Entry`), and **under it** the document's body
(`.dsh/mcp.json · JSON diff` or `· no change`), editable. The form: read-only `Name`, editable
`Command`/`Args`/`Env` (`Add key`, `✕` per row), `Transport`, `Enabled`, read-only
`Status`/`Source`/`Detail` (Detail is a `fieldText`, because the detail is multiline).

**One entry, two editors.** The form and the JSON edit one and the same draft: the pane's body is
`documentBody(draft)`, the declaration in the shape the document holds it (`env`/`headers` — flat
objects of strings, `connectTimeoutMs` — a number), and every input is parsed back into the draft
via `draftFromJson`. A failed parse does **not** touch the draft and prints the line
`The JSON does not parse into an entry: {reason}` (`reason` — the field's path: `transport`,
`args[1]`, `env`, `enabled`, `connectTimeoutMs`, or the `JSON.parse` error text); while it stands,
`Save…` is off with `Fix the JSON pane first: it does not parse into an entry.` — the document is
not written from text nobody parsed. Keys absent from the body because the pane cannot see their
values (a masked secret, a key from `.env`/a credentials file) are preserved as they are during
the parse: their absence from the text means "do not change", not "delete" — only the form's row
can delete them. Unknown keys leave into `extra` and are written verbatim. The pane's text is
rebuilt only when the draft changes **not** through it (the form, another server); its own echo
draft it is already showing. On the `readonly` tier the field is off, and its `title` is the
host's reason; it is marked `data-write`, like the form's controls. The footer: `Save…` (inactive
with no edits), a chip with the number of edits and `→ {document} · .bak copy · confirmation` (or
`→ {document} · read-only`). On `Save…` — the confirmation block: `Write {document}?`, two hints,
for a global document a consent checkbox, the `Write document` and `Cancel` buttons. The result —
`noteOk` (`Saved: {document} written and re-read.`) or `noteError` with the code and the line
`The host said: {message}` and a `Re-read` button. Below an 850 px window the panes fold
(`NARROW_SETTINGS_QUERY`).

### 3.4 `Tools`

* the projects table: `PROJECT · SERVERS · TOOLS · PINNED · MODE`, the last column holding a
  three-mode segment (`disclosure` / `all direct` / `off`);
* vertical rows (`STYLE.settingRow`): `Mode` (the description
  `The disclosure mode this project follows, and the tools it pins.`, the control — the same
  segment), one row per server (`{offered} of {total} tools offered directly` /
  `all {count} tools offered directly`; right of the name — a `STYLE.switchOn` toggle with
  `STYLE.settingRowControl` and the `aria-label` `{server} — pin this server’s tools` /
  `unpin …`, the `serverPinHint` / `serverUnpinHint` tooltips: one press pins **all** the names
  the host published for this server, hidden included — pinning them is what pulls them into the
  request — and the toggle is lit only when all are pinned, because a half-pinned server reads as
  off and a press tops it up (`serverPinPress`); F-44), the
  `pinned · written by hand, offered in every request` group with name chips (empty —
  `no pins yet — pin a tool on the Tools tab`), the `Check conflicts` row with a button and a
  report (`no conflicts reported…` or a `noteError` on a conflict with its sources). **F-39.** A
  conflict of `kind: 'profile'` gives the card a choice: a `STYLE.choiceRow` line (flex, gap 6,
  wrap, `marginTop` 6) with the caption `show` and the buttons — `profile name`
  (`STYLE.choiceOn` on the one standing in `choice`, otherwise `STYLE.choiceOff`),
  `this project’s copy as {alias}` (only when the host computed an `alias`) and
  `this project’s declaration under its own name`; the click goes to `POST <prefix>/conflict`
  with the **declared** name (`conflictBody`), in flight the buttons are off, a refusal is printed
  as `The host refused the choice: …`. The three answers: `profile` — the session sees the
  profile instance's tools, the project's entry is not mounted; `local` — the project's entry
  mounts alongside under the local name `mcp__{alias}__*`; `native` — the project's entry mounts
  under the declared name, where it is closer in the session scope chain of this project and
  therefore shadows the profile instance's tools **here**, while the instance itself keeps running
  and stays visible to all other projects. `native` needs no prefix, so a card without an `alias`
  (a project without a derivable prefix) shows two answers — `profile name` and `native`, but not
  `local`. A `kind: 'duplicate'` gets no choice: both entries live in the project's own documents,
  and renaming the winner does not bring the loser back;
* the `Tools · {count}` card — the **pin picker** (F-30): one row per name the session offers
  (`offeredNames`: `baseline` + `activated` + `context`, each once), and a toggle that sets and
  unsets the pin through `POST <prefix>/pin`; the toggle's state is `policy.pins`, a row with a
  request in flight is off, the host's refusal is printed as a line under the list (`The host
  refused the pin: …`), not silently rolled back. Hidden names (`deferred`) get no rows — their
  number stays as the `… {count} more` line; the footer
  `mcp__<server>__<tool>; the registry applies the prefix, not this page` stays a fact under the
  names; **F-32/F-34.** the rows go by frequency — by the row's leading number, that is, by this
  session's counter when the host publishes the split, and by the project one otherwise — and
  print the quiet `{n} calls`, `never called` and the project total beside it when it diverges
  from the leading number. A name only another session called leads with `never called` and so
  sinks to the bottom, even if the project total beside it is bigger: the sort follows the number
  the reader sees first. On equal counters and on names without a number the host's order is
  preserved, so a list the host already ordered is not reshuffled;
* the `request preview` card with the `tools[] = {count}` and `≈ {tokens} tokens` chips, the
  body — the visible tools' names (the pinned ones marked) — and `hidden {count} · ≈ {tokens} tokens saved`;
  when there is no offer — `no offer published by session yet`.

## 4. Surface T — toasts

The stack in the frame layer: `position:absolute; top:12px; left:50%; transform:translateX(-50%)`,
`gap:8`, at most 3 banners. A banner (`toasts.ts:378`): the tone dot (8 px,
`border-radius:999px`), the event text and one detail line (`opacity:.75`, 12 px). The tones:
`up` → success, `error` → error, `released` → tertiary. The texts: `{server} up` /
`{server} failed` / `{server} released`; the detail — the project and the reason
(`{project} · {STATUS_HINT.error|idle}`). Held for 3 s, fades for 1 s.

## 5. Texts and tokens

* The source of texts is the client dictionary module `src/client/locales/ui.ts` (F-46): three
  complete tables (`zh`, `en`, `ru`) typed `Record<UiKey, string>`, so a key missing in one
  language is a compile error, not a raw key on screen; the tab reaches the same tables through
  `src/client/tab-locale.ts` for a composition without the locale service. The mock's copy runs
  ahead of the product as a design; it is not carried into the product verbatim.
* Tokens — only `--dsw-alias-*` (and `--dsw-font-mono` with a fallback, see below) with a
  fallback for running outside DSH's web client. There are no invented values in the client: the
  `src/client/demo.ts` module is deleted, every drawn element has a host field (the map is §8 of
  this file).
* **Finding.** `--dsw-font-mono` is **not declared** in the DSH design system (there are
  `--dsw-font-family` and `--ds-font-family-code`), so `var(--dsw-font-mono, ui-monospace, monospace)`
  in the client always resolves into the fallback. Both sides (the client and the mock) agree on
  it; if the variable ever appears, the mono stack will change silently — that must be remembered
  when comparing.

## 6. What is not carried into the mock

* the mock's service captions (`mock-label`, `mock`, `rule`) and its documentation frame;
* the mock's absolute font sizes: the live panel lives inside someone else's font scale and sets
  sizes in `em` — the ratio is compared (`.dim` smaller than `.muted`), not pixels;
* `.seg` (the segment switcher) — the settings page only; the tab does not have it and will not.

## 7. Boundaries the user can see

* **F-24.** An individual session's `Release` lives only in the `sessions` section, that is, it
  is available only on divergence; a project where all agree does not release a session from
  here.
* **There is no errors disclosure when there are no problems.** That is not an "empty
  disclosure" but the absence of the block.
* **A single tool's estimate is not printed.** The sizes
  (`surfaceChars`/`visibleChars`/`deferredChars`) are given by the host for the whole set; in a
  row's disclosure there is nowhere for an estimate to come from.
* **There is no bar above the composer** — the `conversation.composer.dock` slot was removed in
  0.1.18 together with the module: the counters duplicated the tab, and the disclosure feed and
  the request inspector had no source the host could fill them with.

## 8. Value sources: element → host field

There is one rule: every drawn element has a host field, and an element without a source does not
enter the interface. The invented-values module (`src/client/demo.ts`) was deleted in wave 4; the
synthetic `SessionTools` remains only as a test fixture (`tests/helpers/tools.ts`).

| Element | Host field |
|---|---|
| the `N pinned · N by the counters · N disclosed · N hidden` counters | `policy.pins`, the rest of `baseline`, `activated + context`, `deferred.length` (`McpSnapshot` → session → `tools`) |
| the pinned list, `Pin` and `Unpin` | `policy.pins` + `POST <prefix>/pin` in both directions (`runtime.ts:998`, `policy.setPin`) |
| **F-44:** `Pin all` on a server row of the `hidden` tier and the `Tools` page server row's toggle | the names of its own surface (the `hidden` group — `hiddenByServer(tools.deferred)`; the page — the same session's `offered + deferred`) + `policy.pins` for the reading and the direction; the write — the same `POST <prefix>/pin`, one call per name |
| the disclosed name, the time and `step {n}` | `activated[]`/`context[]` (`via`, `at`, `step`); the step number is computed by `agent/pre-step` — no number, no tag |
| **F-32:** a tool's frequency `{n} calls` / `never called` | `McpSnapshot.usage[serverName].tools[tool]` (`types.ts:335-347`), where `server`/`tool` are parsed out of the public `mcp__<server>__<tool>`; no record — no number |
| **F-34:** the leading number and `{count} in the project` | `usage[serverName].sessions[sessionId].tools[tool]` — this session's share; the session record is made by `agent.id`, which is the `sessionId` everywhere in the plugin (the host sees the agent in `tools/result`, `usage.ts`); no field — the host does not publish the split |
| **F-32:** a server's idleness `idle {n}d`/`{n}h`/`{n}m` | `usage[serverName].lastUsedAt`; printed only on `idle`/`disabled` and only when the date parses and lies in the past |
| **F-32:** the pin picker's row order | `usage[serverName].tools` — descending by counter, by name on equality |
| the budget line and the bar | `surfaceChars` / `budgetChars`, `≈ tokens` = `chars / 4`; the fill — `offering / mounted` |
| the `hidden` header + `{count}`, the `{server} · {count}` headers and the names in the list | `deferred[]`, laid out by the `mcp__<server>__` prefix (`hiddenByServer`), the order — descending by counter, by name on equality |
| the second presentation owner's plate | `ProjectSnapshot.presentation` — drawn only when the field exists |
| the servers block, the rows, the refusal detail | `project.rows` (per-session rows) and the runtime's `detail` |
| the number and tone of events in the logs disclosure | the `LogEvent` ring (200 per project, 50 in the snapshot), `sessionLogCount` |
| the event row, the filters, "show more" | the event's fields; the ring's remainder — the `<prefix>/logs` route (the `before` cursor) |
| the server-start toasts | the `shell.overlay` frame slot (`src/client/toasts.ts`), the source — the `GET <prefix>/events` status channel |
| the projects table: servers / tools / pinned / mode | `project.rows`, `counts`, `policy.pins.length`, `policy.mode` |
| the project mode form | `POST <prefix>/policy` immediately on click |
| the request preview: `tools[] = N`, the pins, "hidden N · ≈ X tokens" | the session's visible list (`baseline` + `activated[]` + `context[]`) and `visibleChars`/`deferredChars`; no estimate when the field did not arrive |
| the conflicts report | `ProjectSnapshot.conflicts ?? []`, the button always enabled, empty — said as such |
| the entry choice in a conflict (`show`) | `conflict.alias` (when it exists — `native` does without a prefix) + `conflict.choice` on a `kind: 'profile'` conflict; the write `POST <prefix>/conflict` (`conflictBody`: the declared name, not the alias) |
| "server is offered directly" (per-server) | the `mcp__<server>__` prefix over `baseline`/`activated`/`context`/`deferred`; `mounted` — the total control |
| a row's source document | `row.source` (the write boundaries — `write-path.md`) |

## 9. What is checked and with what

`pnpm design:parity` raises the `test-web` profile (it must point at the checkout,
`link:<workspace>` — a tarball does not see the edits), opens the tab, feeds the panel a
**host-shaped fixture** (`{ ok, value }` → `McpSnapshot`) and reads `getComputedStyle`. The
fixture is needed because a profile with no runs has no live agent, and the project is published
only for one: without it the panel would draw the empty state and there would be nothing to
check. The panel itself is real — the same bundle, tokens and DOM; only the host is substituted,
and the script says so in its first line.

```bash
dsh plugin --profile test-web add link:<workspace>   # once
pnpm design:parity                                    # PASS / ACCEPTED / SKIP / FAIL
node scripts/design-parity.mjs --dump                 # the live panel's raw snapshot
```

The outcomes: **PASS** — the live value matched the rule; **SKIP** — this run could not observe
the row (for example, a fixture without a refusal — and there is no detail ruler), the row is
printed with a reason and **is not counted as passed**; **FAIL** — everything else, the exit code
equals the number of FAILs. There are no `ACCEPTED` rows left after F-28: every former "mock ≠
implementation" exception became an ordinary rule over the live panel.

**This section and the gate travel as a pair.** `scripts/design-parity.mjs` stores not a single
colour: it names the alias token and takes its value off the live page in the run's theme
(`TOKEN` + `tokenColor`), and the literals (the dot's 8 px, the body's `9px 10px`, the bar's
`7px 9px`, the row density `2px 0` and `gap 6px`, the `0/12/24/36` tiers, the toast banner's
radius and padding) are exactly what is written above. So editing §9 without editing the gate (or
the reverse) leaves a gate checking the old contract: change them in one pass, together with the
surface they talk about.

What the gate holds on the live panel:

| Area | Rules |
|---|---|
| server pinning | on a server row of the `hidden` tier (a snapshot with open bodies, otherwise the button is not in the DOM) there is a `Pin all` button — the gate reads the first one — which is not itself a disclosure and stands on a row with `·`; the `pinned` tier has the same action in the opposite direction: `Unpin all` on the server row, read on the same snapshot |
| the tools filter | the tools block (`{count} pinned` is its anchor) has a query field: the block's only `input`, `type=search`, a non-empty `aria-label`; a tier chip wears the same plate as a reading chip (mono, smaller than the panel body, 4 px radius, no border, `0 5px` padding), and the panel's `[aria-pressed]` stands only on tier chips and on the log filter chips |
| structure | no `[aria-pressed]` outside the disclosure bodies and outside the tools filter's tier chips (F-43), the body is its own scrolling container, the bar is the body's sibling before it, the block order servers → sessions → tools → errors → logs, the `0/12/24/36` ladder, the row density `2px 0` and `gap 6px`, the bar padding `7px 9px` |
| states | the 8 px dot is a circle, four distinguishable state tones, the `idle` tone tertiary, an `idle`/`disabled` row without a banner, `.muted` secondary and `.dim` tertiary (and smaller), the project name mono |
| tools | the row is a disclosure button with no nested buttons, the colour and weight of a server row, the name mono, the disclosure's 12 px indent, the disclosure holds the full `mcp__<server>__<tool>`, "closed → open → closed" |
| errors and logs | the disclosure labels in one tertiary tone, the bodies invisible before disclosure, the logs header holds this session's events, one applied chip in each filter pair, the time mono and tertiary, the message on its own line below the time, the detail with a 2 px ruler |
| chips | the `bg-layer-3` layer plate in mono, no border; the applied filter reads by its fill |
| toasts | the frame-layer banner: 14 px radius, `12px 16px` padding, an opaque contrast background and inverse text |
| width | the panel works at the shell's native width and separately at 330 px with no horizontal overflow |

The panel's text sizes are relative (`em` off the shell's type), so the **ratio** is compared (the
label smaller than the row, `.dim` smaller than `.muted`), not pixels. What exactly holds the
behaviour beyond the gate is named by the tests: `tests/view.spec.ts`, `tests/view-dom.spec.ts`,
`tests/tools-view.spec.ts`, `tests/settings-dom.spec.ts`, `tests/settings-tools.spec.ts`,
`tests/design-artifacts.spec.ts` (the mock's artifacts and the gallery) and `tests/design.spec.ts`
(the design mode).
