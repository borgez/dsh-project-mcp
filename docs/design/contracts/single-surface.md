# One surface: the tab without the segment bar (F-26)

The owner's decision: in the sidebar tab remove the `Servers` and `Problems` segments (their
content is already visible in `Tools`), hide the error under a disclosure, move the logs under a
disclosure too, and give a tool a disclosure with the full `mcp__` name. This file is the
interface contract: `src/client/view.ts`, the mock `docs/design/mockups/harness.html` and the gate
`scripts/design-parity.mjs` are written by it.

## What disappears

- `PanelMode`, `PANEL_MODES`, `DEFAULT_PANEL_MODE`, `ModeSwitch`, `readStoredMode` and the mode
  storage key (`dsh-project-mcp:servers:mode`). The tab no longer remembers a mode, because there
  is one mode.
- The `tabBody` branching by `props.mode`; `IssueView` and `LogsView` stay, but stop being
  standalone screens and become disclosure bodies.
- No mode switcher remains: `[aria-pressed]` in the panel sits only on filter chips — in the logs
  disclosure's body (F-10) and on the tier chips of the tools filter panel (F-43, `surfaces.md`
  §1.5) — and the gate's anchor rests on none of them (the old anchor
  `panel.querySelector('[aria-pressed]')` after the bar's removal would have found exactly a
  filter).

## The order in the tab's body (top to bottom)

1. **The session's servers** — `ServersBlock`: the status dot, the name, the status word, the
   transport chip. This is the answer to "what is declared and what is happening to it now". A
   refusal detail is **not** printed in the block: the row holds it in `title`, and the text is
   read in the "errors" disclosure — exactly what the owner asked for ("hide the error under a
   disclosure when there is an error"). There must be no `broken` banners in the block, otherwise
   the same text stands on the screen twice.
2. **Sessions** — the same disclosure F-24 gave, and only when there is a divergence: a
   `▸ sessions` header with the number of diverging ones (`1 differs` / `{count} differ`), inside —
   the diverging sessions with their rows and `Release`. A fully agreeing project does not draw
   it. Kept for F-24's sake: an individual session's `Release` lives only here.
3. **Tools** — the counter chips (`counterParts`, one chip per non-empty tier; with F-43 also a
   tier filter: a pressed chip leaves one tier), the budget line (when it has something to say),
   the filter panel (the query field + `Clear` + the "how many remain" caption — F-43), the
   `toolsGroupPinned`, `toolsGroupCounters`, `toolsGroupDisclosed`, `toolsGroupHidden` groups —
   each only with its own rows; every tool row is a disclosure (see below).
4. **Errors** — the `errors` disclosure, **only when there are problems**
   (`props.groups.length > 0`). Collapsed by default. The header: a label word + a badge with the
   number of groups. The body: the `IssueView` content together with `Retry`.
5. **Logs** — the `logs` disclosure, always. Collapsed by default. The header: a label word + the
   number of this session's events in the ring. The body: the `LogsView` content (the "this
   session / all sessions", "all levels / errors" filters, the list, `Clear`, "show more").

The top bar (`bar`) does not change: the project name, the `this session` chip, `Sync` and the
right-edge phrase (`panelSummary`). The right-edge phrase remains the only summary reading in the
header.

## The disclosure of one tool

The tool row today is a `div`. It becomes a `button` with `aria-expanded`:

- **the header** (always visible): the tier dot, the tool name, the time and the step if the host
  gave them, the pin action — as now;
- **the body** (at `aria-expanded="true"`):
  - the full public name in mono: `mcp__<server>__<tool>` (this is `OfferedTool.name`);
  - the server the tool came from (by the `mcp__<server>__` prefix);
  - the tier by which the tool entered the request: pinning / activation by the session
    (`via: 'session'`) / context ranking (`via: 'context'`);
  - the step (`OfferedTool.step`) and the time (`OfferedTool.at`) — only when the host published
    them; no number — no line, invented "step 4"s do not exist.

**About the estimate.** The host does not publish a "size of exactly this tool" field:
`SessionTools` carries `surfaceChars` / `visibleChars` / `deferredChars` for the whole set, and
`OfferedTool` — only the name, the tier, the step and the time. So a tool's disclosure prints what
is its own (name, server, tier, step, time), and the estimate stays where it is real — in the
group's budget line. Inventing a per-tool number is not allowed: those are exactly the fields
F-11/F-12 removed from the panel. If a real per-tool estimate is ever needed, that is a host
change and a separate unit of work, not client arithmetic.

## Anchors for the parity gate

The segment bar was the anchor of the whole Surface A probe (`[aria-pressed]` → the track → the
header and the body). After F-26 the anchor is the scrolling container itself:

- `panel` — the same `findPanel()`;
- `body` — the panel's first descendant with `overflow-y: auto` (this is `STYLE.body`);
- `header` — `body`'s sibling in `panel.children` before it (`STYLE.bar`);
- a disclosure — a `div` with a child `button[aria-expanded]`; a tool row — the
  `button[aria-expanded]` itself.

The mock selectors the gate references after F-26: `.panel-bar` (the bar), `.disclosure` (the
disclosure), `.disclosure-head` (the button), `.disclosure-body` (the body), `.tool-line` (the
tool row's header), `.tool-detail` (the tool's disclosure).

## What the checks must hold

- there are no modes: outside the disclosure bodies and outside the tools filter panel there are
  zero `[aria-pressed]` in the panel (inside — the log filter chips, in the tools — the tier chips
  of the `{count} {label}` kind), and there is no `Servers`/`Problems`/`Logs` text acting as a
  switcher;
- the block order is exactly as above, and blocks are recognized by their label, not by position;
- the servers block does not print a refusal detail: its banner is absent under any status, the
  text is available from the row's `title` and from the `errors` disclosure's body;
- errors are not visible while the disclosure is closed, and there is no disclosure at all when
  there are no problems;
- logs are not visible while the disclosure is closed, and the event count in its header is this
  session's, not the project's: the fixture must separate these two numbers, otherwise the row
  cannot fail;
- a tool's disclosure prints the full `mcp__<server>__<tool>` — the disclosure's **body** must be
  checked, not the header row: the name in the header would satisfy the assertion even with a
  short name in the body;
- a second click closes the disclosure;
- servers and tools stay in place: the F-24 disclosure still appears only on divergence, and the
  fixture must contain an agreeing session next to a diverging one — otherwise the `deviates`
  filter is not observed.
