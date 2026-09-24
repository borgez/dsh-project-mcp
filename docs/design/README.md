# dsh-project-mcp design — the single entry into this folder

There are three genres here: **contracts** (what is decided and how it works), the **mock** (the
picture of all surfaces — now a single one, and a **project** rather than a snapshot of the
product) and **history** (closed plans and frozen contracts under `../history/`, kept as a
decision record). There is no separate "verification report" genre: the live findings of past
verifications moved into the contracts and into `docs/features.md`, and the wave history lives in
`../history/` and in the registry. What deliberately stays is §6 — the closed questions, kept as a
record of the decisions themselves, not as reports. Files are laid out by genre, not by date, so a
link always names its genre.

## 1. What is here and in what order to read it

| Path | Genre | When to read |
|---|---|---|
| `README.md` | entry | always: this is the map of the folder |
| `contracts/surfaces.md` | contract | **the main file**: what the user sees today — the composition, order and vocabulary of every surface, the sources of the values and the list of what the checks hold |
| `contracts/single-surface.md` | contract | before editing the sidebar tab: one surface (F-26), the block order, the gate anchors |
| `contracts/write-path.md` | contract | before editing the write path into `mcp.json`: where and how we write |
| `contracts/policy.md` | contract | the project mode and the pins; the state is `$DSH_HOME/dsh-project-mcp-policy.json` |
| `contracts/bridge.md` | contract | F-19: one project `mcp-client` and thin definitions in the session layer |
| `mockups/harness.html` | mock | to see the interface: all surfaces inside the shell's chrome, real tokens, theme and state switchers |
| `mockups/README.md` | mock | how to read the mock, its class vocabulary and where it diverges from the product |
| `../history/README.md` | history | the archive index: closed plans and frozen contracts, a decision record |
| `../history/phase3-contract.md` | history | the wave-3 contract (the bridge): what was promised and what counts as done |
| `../history/phase12-contract.md` | history | the wave 1–2 contract (logs, async start): the decision and its limits |
| `../history/logs-parity.md` | history | the wave plan: logs, async start, parity; §0–§7 and the decision log |
| `../history/wave4-demo.md` | history | §8 as a separate file: closing the demo stubs (F-11…F-16) |
| `parity/` | gallery | the "expected / actual" pairs: crops of the mock and shots of the live profile |

The order for a newcomer: this file → `mockups/harness.html` (see it) → `contracts/surfaces.md`
(understand what of it is already the product and what is still a proposal) → `../history/README.md`
(the archive of closed plans).

## 2. The state of the design today

| Decision | What is fixed | Contract |
|---|---|---|
| One tab surface (F-26) | There is no `Servers \| Tools \| Problems \| Logs` bar: one mode. The body order: the session's servers, the `sessions` disclosure (only on divergence, F-24), the tools, the errors disclosure (only when there are problems), the logs disclosure; both collapsed by default, a tool row discloses | `contracts/single-surface.md` |
| One block scheme (F-28, **project**) | One number per block — in its header; the sessions summary is not repeated, empty groups are not printed, the tool name is not repeated in the disclosure, the fact goes on a line under its own line. The product still has the old lines — the code edit is the next step | `mockups/harness.html`, the mock's own §4 |
| The tools filter (F-43) | `{count} {label}` counter chips double as a tier switch (a pressed one leaves a single tier, pressing again returns all, an empty list *is* "all"), plus a query field over the registry name, a `showing {shown} of {total}` / `No tool … matches the filter.` caption and `Clear`, while the filter means anything. The state lives in `ToolsSection` and is not persisted; the `hidden` tier opens by itself under an active filter | `contracts/surfaces.md` §1.5/§1.8/§9, `contracts/single-surface.md` |
| Server pinning (F-44) | The server action is an expansion into names: a server row of the `hidden` tier gets one action per group (`Pin all` / `Unpin all` — following the `serverPinState` reading, like the write direction), the `pinned` tier is grouped by server and carries `Unpin all` on each server row, and on the Tools page a toggle closes the server row (all the server's names, hidden included). There is no server rule in the policy, and a server's new tool is not covered by the press — that is stated in the contract, not hidden | `contracts/policy.md` ("Pinning a whole server"), `contracts/surfaces.md` §1.5/§3.4 |
| Indents (F-26 on top of F-09) | The `0 / 12 / 24 / 36` tier ladder: `INDENT = 12`, `STYLE.indent(level)` is the single source of the left indent | `contracts/surfaces.md` §1, `contracts/single-surface.md` |
| The source of values | Every drawn element has a host field; there are no invented numbers (`src/client/demo.ts` was deleted in wave 4) | `contracts/surfaces.md` §8 |
| The product's surfaces | The map of the surfaces and their boundaries: the tab, the drawer, the settings page, the editor, the toasts | `contracts/surfaces.md` |
| Writing and policy | The write boundaries — where and how; the project mode, the pins and the choice on a `serverName` conflict — the state and the rules | `contracts/write-path.md`, `contracts/policy.md` |

## 3. How this is checked

- `pnpm design:parity` (`scripts/design-parity.mjs`) — the machine gate. It raises the `test-web`
  profile with a link to the checkout, feeds the panel a **host-shaped fixture** (a profile with no
  runs has no live agent, and the project is published only for one) and reads the
  `getComputedStyle` of the drawn elements in the live shell's theme. The expected side is the
  **contract**, not a picture: the mock runs ahead of the product, so comparing against it would be
  wrong, and the gate checks the live UI against itself. The frozen expected values are literals inside
  `scripts/design-parity.mjs` — `contracts/surfaces.md` §9 holds the rationale for each rule: the doc
  explains, the script decides, and a surface change updates both in the same pass. The verdict per row: `PASS` — the value
  matched the rule; `SKIP` — this run could not observe the row (printed with a reason and **not
  counted as passed**); `FAIL` — everything else, the exit code equals the number of `FAIL`s. The "expected / actual" gallery is
  `docs/design/parity/`.
- `tests/design-artifacts.spec.ts` keeps the gallery in step with its sources: the index agrees
  with its files, and the "expected" crops are built from `mockups/harness.html` per
  `scripts/design-sections.json`.
- `tests/design.spec.ts` holds the client's design mode (see below).

### The design stand: review the interface without a live project

Two independent ways, both showing the same picture:

- **`mockups/harness.html`** — one self-contained file: the DSH token layer copied into it
  verbatim, all surfaces built from the client's components, typography and the class vocabulary
  shared. The theme switcher is a button, the stand state — buttons above the frame; disclosures
  and tool rows are clickable. The hash addresses a theme and a section:
  `harness.html#light,settings`, `#dark,tab`.
- **The client's design mode** (`src/client/design.ts`, fixtures `src/client/design-fixtures.ts`) —
  the same surfaces inside the **real** shell, without a host. Enabled by a browser setting and
  disabled by removing it:

  ```js
  localStorage.setItem('dsh-project-mcp:design', 'full')   // or quiet | empty | tools-absent | off | direct | no-project | no-session
  location.reload()                                        // back to the product: localStorage.removeItem('dsh-project-mcp:design')
  ```

  The same components are drawn (`PanelHeader`, `tabBody`, `SettingsPage`, `ProjectBlock`,
  `ToastStack`) — only the picture's source is substituted, the host runtime is untouched. Held by
  `tests/design.spec.ts`: the fixtures, the registration of the three surfaces and "no flag — mode
  off".

## 4. Project versus product

`mockups/harness.html` is a **project**: it runs ahead of the product in copy and in the block
scheme. The divergence is listed in the mock's own §4, and it is a work queue, not a mistake:

1. the session-status summary is printed twice (in the section header and in the session row);
2. the tool name is repeated in the disclosure although it already sits in the row;
3. surplus captions (`what the model sees`, the `tools[] = built-ins only …` line) and a refusal
   detail the banner already repeats;
4. toasts are outside this interface project: their form lives in `src/client/toasts.ts` and has
   not changed.

The item "empty tool groups explained with words while the header counters show zeroes" was closed
by F-37: the header counters are chips over non-empty tiers only, and an empty tier is drawn by
neither a header nor a row — in the product and in the project alike.

The `available … through mcp_search_tools only` caption is no longer a line under the groups nor
an item of this list: in the product and in the project it became the `title` of the `hidden`
tier's header (F-40), and the tier itself became an openable list of names with a `Pin` on each,
instead of per-server chips.

Whole-server pinning (F-44) came to the project and the product in one pass: a `Pin all` button on
the `hidden` tier's server rows and a toggle on the Tools page's server rows. There is one
divergence, and it is in the stand's own layout: it draws the page's server rows its own way (name
on the left, transport and toggle on the right), while the product keeps a `Server` caption with a
phrase about the offering on the left and puts the name next to the toggle.

The tools filter panel (F-43) came to the project and the product **in one pass**: the query
field, the tier chips, the caption and `Clear` exist both in `mockups/harness.html` (the `full`
state) and in `src/client/view.ts`, and the rules are written in `contracts/surfaces.md` §1.5. No
work queue appeared from this item.

Until the product catches up with the project, the `design:parity` gate checks the product against
the contract (`contracts/surfaces.md`), not against the picture.

## 5. Reference

### Finding (closed): the panel used nonexistent tokens

`src/client/view.ts` took colours from tokens that do not exist in DSH — verified by searching
deepseek-harness, 0 matches:

| in the plugin | the real DSH token |
|---|---|
| `--dsw-alias-status-success` | `--dsw-alias-state-success-primary` |
| `--dsw-alias-status-warning` | `--dsw-alias-state-warn-primary` |
| `--dsw-alias-status-error` | `--dsw-alias-state-error-primary` |
| `--dsw-alias-text-tertiary` | `--dsw-alias-label-tertiary` |
| `--dsw-alias-border-1` | `--dsw-alias-border-l1` |

**Fixed**: the code uses the real names (`STATUS_COLOR`, `STYLE`), and the hardcoded fallbacks
remain only for running outside DSH's web client, where the alias layer is not loaded. The mock
renders with the real DSH tokens — the alias layer is copied from
`packages/client/ui-theme/src/styles/design-platform.css` (deepseek-harness), including the
`body[data-ds-dark-theme]` block; the theme is switched by the button at the top.

### Second finding: `--dsw-font-mono` does not exist

The DSH design system declares `--dsw-font-family` and `--ds-font-family-code`; there is no
`--dsw-font-mono` variable. So both the client and the mock always resolve
`var(--dsw-font-mono, ui-monospace, monospace)` into the fallback, and the mono-font comparison
passes on it. If the harness ever declares this variable, the mono stack will change silently on
both sides — worth remembering when comparing looks.

### Design-system context

- The theme is the `data-ds-dark-theme` attribute on `<body>`; the alias layer: `--dsw-alias-*`, under it the static palette `--dsw-static-*`.
- Surfaces: `bg-base`, `bg-layer-1..3`, `bg-overlay`, `bg-skeleton`; the light theme does not distinguish layers (all white) — the hierarchy rests on the `border-l1..l4` borders.
- Text: `label-primary` / `-secondary` / `-tertiary` / `-caption` / `-dimmed`; accent: `brand-primary`, `button-primary-fill`.
- States: `state-success-primary`, `state-warn-primary` / `-label` / `-tertiary`, `state-error-primary` / `-secondary`, `state-business-primary`.
- Sidebar background: `--dsw-specific-sidebar-fill`.

## 6. Open questions

All three are closed; kept as a decision record.

1. ~~Should "Problems" open automatically when an `error` appears~~ — **no**: a mode change
   under the user's hands is worse than a missed error; errors are visible anyway via the
   disclosure's counter.
2. ~~Is a step towards full CRUD needed~~ — **not yet**: the mock fixes the editing of existing
   entries; creating and deleting a server is not part of this step. The first CRUD step is
   creating `<project>/.dsh/mcp.json` when there is none.
3. ~~Where to keep the settings page's remembered view~~ — in `localStorage` under
   `dsh-project-mcp:settings-view` (`SETTINGS_VIEW_STORAGE_KEY`): the page has no
   `pluginSettings` of its own, and a view is a browser habit, not project state.

## Status

Product: the sidebar tab is **one surface** (F-26, the four modes removed), a page in the settings
navigation (`settings.section`) with "Table" / "By files" views and server and tool tabs, an entry
editor per `contracts/write-path.md`; the bar by the composer was removed in 0.1.18 together with
the dock, and the mock does not have it either.

Mock: one page `mockups/harness.html` instead of four (the three old ones and the composite
preview deleted), the tab's blocks reduced to one scheme, the class vocabulary and typography
shared across all surfaces. The work queue is §"Project versus product" above.
