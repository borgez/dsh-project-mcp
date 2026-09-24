# The tool policy: the rules

The continuation of `docs/design/contracts/surfaces.md` §8: the **pins** and the **project
mode** — two surfaces A and B that have a real model. The shared contract of the host and the
client.

## Where it lives

`$DSH_HOME/dsh-project-mcp-policy.json`, next to the counters, in the same style (atomic write,
debounce, a broken file does not bring the plugin down):

```json
{ "version": 1, "projects": { "<root>": { "mode": "disclosure", "pins": ["mcp__tglider__workspace"],
  "aliases": { "grafana-local": "local" } } } }
```

A missing file, a missing project, a missing field — that is the default value
(`DEFAULT_TOOL_POLICY`: the `disclosure` mode, an empty pin list, an empty choice map). The
`aliases` field (**F-39**) is additive and does not move `version`: a document without it reads
exactly as before, and writing the `profile` choice **deletes** it — absence is the answer "I show
the profile one", and the document does not grow with every click. Neither the profile nor the
plugin's config is written: the policy is plugin state, like the counters.

## The mode

| Mode | What the host does |
|---|---|
| `disclosure` (default) | As now: the budget, the baseline from the counters, activations, the context tier, `mcp_search_tools` |
| `direct` | Defers nothing: the request carries the whole mounted catalog, `deferring` = `false`, the search tool is not advertised |
| `off` | The project's tools are not offered: the listener adds nothing. The `mcp_search_tools` registration in scope-local cannot be cancelled (a DSH limitation, not ours), so it stays in the registry but is not advertised |

The mode is read on **every** request assembly, so a change applies from the next step, with no
scope re-mint.

## Pins

- A pinned name is offered from the first step of every request, regardless of the budget and
  the counters.
- A pin survives idle pruning and `compaction/end`: it is not session-scoped but project-scoped.
- A pin enters `SessionTools.baseline` — that is, into "offered", and therefore does **not** land
  in `deferred`. The panel does not recompute this itself.
- The pin list is served separately in `ProjectSnapshot.policy.pins`: this is what the user
  pinned by hand, unlike the rest of the baseline's names, which earned their counter.
- A name the project no longer mounts is **not** removed from the list: the declaration may
  return, and a silently vanished pin is a surprise.
- The `off` mode does not cancel pins: they are not offered together with everything else.

## Pinning a whole server — expansion into names (F-44)

There is **no** server pin in the policy and none is introduced: `policy.pins` is still a list of
public names, and the server action is the same name written N times. So the owner decided, and
the decision has a price the interface must state, not hide:

- **A tool that appears on the server later is not covered by the server press.** The press
  expands the server into the names the host published **at press time**; the rule "everything
  this server will ever mount" is stored nowhere. A user who pinned a server and does not see the
  new tool in the request reads this as a promise the policy never made.
- **One press — N `POST pin` calls**: the route (`PinRequest { projectRoot, tool, pinned }`)
  writes exactly one name and has no batch. The panel sends them as one package and sets the state
  once (`useSnapshot().runAll`), Settings — one call per name through `requestPin`, the way the
  single toggle sends.
- **A package is not a transaction.** If one of the N calls refuses, the rest are already written
  by the host: the policy changes per name, and all-or-nothing is not promised here. The panel
  prints the host's refusal as its own line, and the state arrives with the next snapshot anyway —
  for the tab and for the Settings page alike.
- **The direction comes from the reading, not from a flag.** A fully pinned set of the server's
  names is released; any other is topped up (`serverPinPress`). A half-pinned server therefore
  **takes on** the missing names and never resets a hand-written pin.
- **The caption repeats the direction instead of guessing it.** Both surfaces read
  `serverPinState` and say `Pin all` or `Unpin all` (`toolsPinAll` / `toolsUnpinAll`), and write
  exactly what they named. This is not pedantry: a name can be pinned and still sit in `deferred`
  — a pin written between two assemblies, or a name the host defers by itself — and a button
  labelled `Pin all` that removed such a pin would be the only lie in this list (the `off` mode
  does not show it: it replaces the block wholesale, and there is no tier in it).
- **Removal lives where the pinned things are read.** The tab's `pinned` tier is grouped by
  server (`pinnedByServer` — the same grouping as the `hidden` tier), and its server row carries
  `Unpin all`: one press removes all that server's names from the pin list. The Settings page
  server row's toggle does the same when it is on. Neither tells a hand-written pin from a name
  that arrived by a server press — in the store they are the same names.
- **Each surface pins the set it shows** (that is its own reading anchor): a server row of the
  tab's `hidden` tier — the names of the "hidden on this server" group; a server row of the
  Settings → Tools page — **all** the names the host published for that server, hidden included
  (pinning them is what pulls them into the request), exactly the number its own caption
  `{offered} of {total} tools offered directly` prints.
- **Removing a server pin releases all the names of the set** — including one the user would have
  pinned separately: pins "on the server" and "on the name" are indistinguishable in the store.
  That is why the page toggle reads as "the whole server is pinned", not as "some of it".

## The choice on a `serverName` conflict (F-39)

`mcp-client` reserves `serverName` in a scope, so the profile instance and a project document with
the same name cannot be mounted at the same time. `aliases[<name>] = "local"` is the user's answer
"show the project entry alongside":

- `profile` (default, absence) — the name stays with the profile instance, the project entry is
  not mounted, the row carries `status: "conflict"`;
- `local` — the project entry mounts under the **local name** `localPrefix` (the plugin's config,
  ≤5 characters in the `serverName` alphabet; empty — the prefix is derived from the project
  folder), that is, `mcp__<prefix>-<name>__*` next to the profile's `mcp__<name>__*`. The profile
  entry loses nothing in this: the change is a change of the role "who sits under the disputed
  name", not a server shutdown.

The name rule is a pure function (`src/naming.ts`, `resolveConflictNames`): aliases are issued in
name order, a candidate already taken by another entry or by the profile itself gets a numeric
tail (`p-grafana-dev-2`), and a project without a derivable prefix is left without a choice. The
name is computed in the same pass as the rows, and the same name goes into the mount — so the
panel, the mount and the tools' prefix cannot diverge. Changing the choice remounts the entry (the
registration lives under one name), and this state enters the pass's `digest`, otherwise the next
pass would not notice the click.

## Routes

- `POST <prefix>/pin` — `PinRequest` `{projectRoot, tool, pinned}`.
- `POST <prefix>/policy` — `PolicyRequest` `{projectRoot, mode}`.
- `POST <prefix>/conflict` — `ConflictRequest` `{projectRoot, server, choice}`, where `server` is
  the **declared** name (the `mcpServers` key), not the alias: the host computes the alias.

They answer with the same envelope: `{ok:true, value:<fresh snapshot>}`, `400` — an unknown
project, an unknown mode or an unknown choice. `pin` and `policy` need no rescan (the policy is
not in the document) and rebuild the snapshot in place. `conflict`, on the contrary, starts a
project pass: the choice is a change of the mount's name, and the row it prints must be the one
that ends up in the registry; the pass is not awaited (`void`), the operator's click must not
stand behind a server's start.

## What the user sees

- The `Pin` / `Unpin` buttons in "Tools" mode become real; the pinned list comes from
  `policy.pins`.
- The mode is a switch on the "Tools" page; it is written immediately, with no `Save`.
- The panel counters do not change: "pinned" is the size of `baseline` (pins + warmed-up names),
  "hidden" is `deferred.length`.

## What was removed from the interface

The slots and the "until the session ends" policy (the host counts characters, not slots), the
budget-below-server-count warning and the `off|collision|always` prefix setting (the
`mcp__<server>__` prefix is made by `mcp-client`, not us) — these fields are gone from the page.
The disclosure feed and the request inspector were removed together with the bar by the composer:
the host keeps no disclosure history and does not serve the assembled request. The rest got real
sources — the second presentation owner (`ProjectSnapshot.presentation`), the `serverName`
conflicts (`ProjectSnapshot.conflicts`), the request preview (`visibleChars`/`deferredChars`,
`≈ tokens` = `chars / 4`) and the per-server counters by the `mcp__<server>__` prefix. The
`src/client/demo.ts` module, where the invented values lived, was deleted in wave 4; the source
map is `docs/design/contracts/surfaces.md` §8.

## `SessionTools` by mode — the decision (joining both halves)

`SessionTools` describes this plugin's contribution to the request. **With F-38 this contribution
is authoritative over removal as well.** The `system-prompt/assemble` listener is installed with
`prepend:true`, so the source assembly arrives as `result`, and the returned object is the last
word for the request's tool list (`vendor/cordis/src/events.ts:132,255`); a foreign presentation
filter (`dsh-progressive-tools`) registers without `prepend` and therefore applies earlier — it
can hide even more, but cannot return what this plugin removed. Before F-38 the listener only
added names, and everything the plugin "deferred" stayed in the request: the `hidden` tier was a
report, not an effect.

| Mode | `baseline` | `deferred` | `deferring` | stays in the assembly |
|---|---|---|---|---|
| `disclosure` | pins ∪ warmed-up | the visible surface minus the offered | the surface beyond the budget | pins ∪ the offered (all planes) |
| `direct` | pins ∪ warmed-up | empty | `false` | everything visible — the plugin does not filter |
| `off` | **empty** | **everything project** | `false` | the visible minus the project plane (the profile one is untouched) |

The `disclosure` budget is counted over the **session's whole visible MCP surface** — the
`visible` option (`ctx.tools.schemas(state.agent)`), not only over the plugin's own project mounts
`available()`. `available()` remains the source of the baseline, the counters, `guidanceText` and
the per-server rows: it must not be extended, otherwise the usage counters and the guidance line
would drift.

**Containment (F-42) stands above the modes.** Before deciding anything about the budget, the
listener strips from the assembly the names belonging to **another project** of this process: the
runtime serves them via the `foreign()` option — the union of foreign project mounts' names minus
its own and minus the profile ones. This is isolation, not presentation, so it applies in all
three modes and **after** `withActiveTools` — neither a pin nor an activation can return a foreign
name to the request; the search catalog is built over the same surface without foreign names,
otherwise the leak would return as text. When there is nothing to strip, the **same** object is
returned, so the common case keeps prefix stability. The budget meanwhile still counts the whole
visible surface, foreign names included: they occupy the request just like its own. The panel
rows (`toolsFor`/`sessionTools`) do not subtract foreign names yet — that is owner diagnostics,
not the model's request.

`deferring` is about the budget, not the mode: in `direct` the plugin filters nothing, in `off`
it offers nothing.

The panel reads `policy.mode` before the numbers: in `off` — "the project's tools are switched
off", in `direct` — "nothing is deferred", and only in `disclosure` does it show the counters and
the budget. The system-prompt section (`src/guidance.ts`) follows the same: in `direct` it does
not promise tools on request, in `off` it does not claim the project's servers are available.
After F-38, in `off` the project names genuinely leave the assembly, so the panel's phrase
describes the request, not only the plugin's intention.
