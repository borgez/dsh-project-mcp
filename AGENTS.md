# Project Instructions

## Tooling — the mounted `tglider` MCP server

This checkout declares one MCP server for the session, in `.dsh/mcp.json`: **`tglider`** (stdio,
`npx -y tglider --workspace . --default-timeout 30m`). It is the project's type-aware view of the
TypeScript sources — symbol search and declarations, references, callers and callees, diagnostics,
project and dependency graph, rename previews. Here the name is the real mount, not the generic
example name of the commits rule below.

Use it before the shell on code questions — `mcp_search_tools` when the session defers the
server's tools, then `find_code` / `query_symbols` for a declaration. Three traps, each of which
costs a round trip when it is not known in advance:

- **Symbol tools take an opaque key**, the `canonicalSymbolKey` that `find_code` / `query_symbols`
  return — never `path:Name`, never a bare name. A bad key fails loudly in `find_callers`
  (`Symbol not found.`) but *silently* in `find_references`, which answers `count: 0,
  partial: true`: read `partial` before concluding that a symbol is unreferenced. The same key
  drives `compute_rename_edits` (preview) and `rename_symbol` (which applies).
- **`find_callers` can report zero callers** while noting call sites it could not group (they sit
  outside an indexed callable body) — cross-check with `find_references`, which counted 9 for the
  same symbol.
- **`get_diagnostics` is not a gate.** Checked 2026-09-27 against tglider 1.8.0: it reported 96
  errors on a tree that `pnpm typecheck` compiles clean — one family, JSDoc `{@link Type.member}`
  links (and the declaration owning such a block) read as TS2693/2702/2713 "type used as a
  value/namespace". Confirm a diagnostic with `pnpm typecheck` before acting on it.

Shell `grep`/`find` stay fine for prose, docs and non-TS files, and the gate keeps the last word:
`pnpm check` and `pnpm e2e` decide — the server reads the working tree, it does not replace them.

## Commits — never publish local identifiers

Commits are permanent and easy to push by accident, so local machine facts must never reach a tracked file: absolute home paths (`/Users/<name>/…`, `/home/<name>/…`, `C:\Users\<name>\…`), host names, names of private projects, and anything credential-shaped.

Write placeholders instead — `<workspace>` for this repo, `$DSH_HOME` for the harness home, `~` for a home directory, and neutral example names (`project1`, `project2`, `example-service`) in docs, mockups and test fixtures. That includes fixtures whose whole point is `~` collapsing: use a placeholder account (`/home/dev/…`), never a real one. MCP examples use generic server names (`tglider`, `memory`).

Sanitize before committing rather than after: scan the staged diff for these shapes, and treat docs, handoffs and mockups as the usual offenders. If an identifier already reached history, say so plainly and fix it before doing anything else — for local, unpushed history a rewrite is the only real remedy.

## Development loop — e2e first, build and pack second

**Always test end-to-end before building, packing or installing. A green `pnpm check` is not evidence that the plugin boots.**

The failure this rule exists for: a client entry that throws during activation makes DSH's web shell refuse to start (`web boot: 1 entry did not activate`) and takes the whole GUI down — while `tsc`, `vitest` and `scripts/audit.mjs` stay green, because none of them run a browser. That is exactly how 0.1.9 shipped: it read `ctx.locale` / `ctx.betterSidebar` as properties, and Cordis's context proxy throws `cannot get property "…" without inject` for a service the fiber did not declare (`<harness>/vendor/cordis/src/reflect.ts`). Optional services are read with `ctx.get(name)`; a surface that must exist (the sidebar tab) is parked behind `ctx.inject([name], …)` so a composition without it stays bootable instead of leaving the entry pending.

The loop:

```bash
# 1. once: link the checkout into the test profile, so the next boot reads this
#    working tree. No pack, no reinstall, no version bump between runs.
dsh plugin --profile test add link:<workspace>

# 2. every browser-half change: boot the real thing and read the boot page
pnpm e2e                      # = node scripts/e2e-boot.mjs, profile `test`
pnpm e2e --profile test-web   # the same plus the third-party sidebar plugin (coexistence)
pnpm e2e --url 'http://127.0.0.1:<port>/?token=<token>'   # attach to a server already running
pnpm e2e --dump-console       # print every console message the page produced

# 3. only after a green e2e: build and pack the artifact
pnpm check && pnpm pack
```

`scripts/e2e-boot.mjs` starts the profile's web process on a free port, drives headless chromium over CDP, and fails on the boot page, on a console error, or on a page that never mounts. It refuses to run against a profile that pins a packed snapshot instead of `link:<workspace>`, because a tarball cannot see the edit under test.

Two profiles are worth keeping: `test` (in-box bundles plus this plugin) is a stock `dsh web` composition, which is where the tab and its settings popup are the plugin's own — the browser half speaks to DSH's right sidebar directly and depends on nothing outside the harness. `test-web` adds a third-party sidebar plugin, which is the coexistence case worth proving: it bridges its own tab types into the same native registry, so the two must not fight over a kind or an id. Neither is the `web` profile: install there only after both are green, and never as the first place a change is tried.

Both profiles read the **same** `$DSH_HOME`, so their sessions are the sessions a person's own `dsh web` opens — a `dsh` left running by a captured or interrupted gate holds those sessions and the client answers `session/writer-held` ("This session is already in use…"). All four boot scripts (`e2e-boot.mjs`, `design-parity.mjs`, `design-shot.mjs`, `design-shot-settings.mjs`) therefore arm `scripts/dsh-reaper.mjs`: it kills the server group on `exit`, on `SIGINT`/`SIGTERM`/`SIGHUP` and on an uncaught exception, and sweeps servers left by earlier interrupted runs — same profile flags, `ppid === 1` — before and after every run. A live server of this profile that is *not* an orphan is never touched. If a `dsh --profile … --no-open --port 0` is still alive after a run, that is a bug in the reaper, not a reason to kill it by hand.

## Registry and board — one number per unit of work

`docs/features.md` is the registry and the source of truth for what is planned, in progress and
done; `docs/roadmap.md` is the phased backlog it draws from. Both follow one convention:

- Every unit gets a stable `F-NN`. **Numbers are never reused or renumbered** — a cancelled one
  stays as `cancelled` — and a commit names its unit: `feat(runtime): F-08 start mounts without
  holding the pass` (the number first in the summary, like the sibling TR project).
- Statuses run `idea → backlog → in progress → done / cancelled`. `idea` rows carry no number
  until they are taken; taking one means it becomes `F-NN` with a cross-reference back to the
  roadmap.
- **Noticed a problem outside the current task? Write an `idea` row and go back to your task.**
  A finding that only lives in a chat message is lost by the next session.
- Documentation is part of the work, in the same pass: new unit → a row in `docs/features.md`;
  a changed convention → this file; a changed surface → the matching `docs/design/*` doc.

The DSH task board (plugin `dsh-taskboard`) is the live view of the same registry, not a second
backlog: one card per `F-NN`, title starting with the number, description holding what the row
cannot (files, entry points, decisions), `todo` meaning *approved and ready*, `backlog` meaning
*not authorized yet*. The card and the row move together — hand off with
`taskboard_execution_report` plus a comment, and leave `done` to the owner.

Definition of Done before a unit moves to `done`: `pnpm check` green (its coverage thresholds
included), `pnpm e2e` **and** `pnpm e2e --profile test-web` green for anything touching the
browser half, the tarball installed into the `web` profile, the `F-NN` row updated, and the
`feat:`/`fix:` commit pushed to `main` — the `release:` commit that follows it is written by
`release.yml`, never by hand.

## Releases — a push to `main` is the release

The version is not typed by hand and the `release:` commit is not written by hand.
`.github/workflows/release.yml` runs on every push to `main` (and on `workflow_dispatch`), and
when the commits since the last tag ask for a version it writes one:

| commits since the last `v*` tag | level |
| --- | --- |
| `feat` | minor |
| `fix`, `perf`, `revert` | patch |
| `!` in the header, or a `BREAKING CHANGE:` paragraph | major |
| `docs`, `chore`, `ci`, `test`, `refactor` alone | nothing — the push releases nothing |

The job runs the full `pnpm check` gate first, then decides with `scripts/next-version.mjs`, which
bumps the newest of `package.json` and the highest `v*` tag — both are read because they can
drift, and a tag over a manifest that disagrees with it publishes the wrong number under the right
name. Before tagging, the job refuses to reuse an existing tag or an already-published npm
version. It then writes the version into `package.json` (that one line, nothing else), commits it
as `release: dsh-project-mcp <version>`, tags `v<version>`, creates the GitHub Release, and calls
`.github/workflows/npm-publish.yml` to publish that tag. The call is explicit because a Release
created with the workflow's own `GITHUB_TOKEN` starts no other run — the `release:` trigger would
never fire for it.

Four consequences worth knowing:

- **A green `feat`/`fix` on `main` publishes within the minute.** A change that must not ship
  yet does not belong on `main`.
- **The gate runs twice on a releasing push** (in `node.js.yml`, and again in the release job's
  own tree). The duplication is deliberate: a release must not tag a tree whose gate it never
  ran, and it must not depend on another workflow's run id to decide.
- **`pnpm pack` builds by itself** (`prepack`), so a tarball always carries `lib/` and
  `cordis.patch.yml` — the manifest's own promises, checked inside the tarball before every
  publish, and by hand in `pnpm pack`.
- **The publish credential is OIDC, not a secret.** `npm-publish.yml` asks for
  `id-token: write` and exchanges it through npm's trusted publishing (registered for this
  repository and that workflow file on npmjs.com), so nothing has to be rotated and nothing
  expires. No `NODE_AUTH_TOKEN` may be set: it takes precedence over the exchange, which is how
  a dead registry token once surfaced as a masked `404` on the PUT — indistinguishable from a
  permissions problem. That job pins Node 24, because the exchange needs npm ≥ 11.5.1, and
  `release.yml`'s calling job has to grant `id-token: write` too: a reusable workflow never holds
  more than its caller gives.

Publishing by hand stays available as the escape hatch: create a GitHub Release for a tag whose
`package.json` already carries that version, and `npm-publish.yml` publishes it — failing when
the two disagree, which is how the `v0.2.1` release once published `0.2.0`. A release that dies
between its tag and npm is re-driven with `Release` → *Run workflow* (`bump`, `dry_run`), not by
retagging.

## Language — docs in English, UI copy in the dictionaries

- **All documentation is English** (F-49): `README.md`, this file, `docs/features.md`,
  `docs/roadmap.md`, `docs/design/**`. The registry's status vocabulary is English too:
  `idea → backlog → in progress → done / cancelled`. The exception is `docs/history/` — closed
  material kept in Russian deliberately, as a decision record with an English archive header.
- **Client copy lives in `src/client/locales/`** (`ui.ts` for UI text, `host.ts` for host-message
  codes). New UI copy goes into **all three dictionaries** (`zh`, `en`, `ru`) in the same edit:
  the tables are `Record<…Key, string>`, so a forgotten key is a compile error, not a raw key on
  screen.
- **Model-facing strings are English by decision** (F-46..F-48, recorded in `docs/features.md`):
  tool schema and parameter descriptions (`src/activation.ts`) and the injected system-prompt
  section (`src/guidance.ts`) are read by the model, not the user — translating them would make
  the plugin's behaviour depend on a UI preference. They are allowlisted in the audit's literal
  scan.
- **Host messages a human can read travel as codes** (`{ code, params, message }`, namespace
  `projectMcp.host`, F-48): a code once shipped is never renamed, and the English `message` stays
  as the degradation path for a client that does not know the code.

## Design stand — review the interface without a live project

Two ways to see what the surfaces look like, neither of which needs a mounted server:

- `docs/design/mockups/harness.html` — one self-contained page: the DSH token layer copied
  verbatim, every surface built from the client's own components, theme and fixture-state
  switchers, disclosures that open. The hash addresses a theme and a section (`#light,settings`).
- the client's design mode — `localStorage.setItem('dsh-project-mcp:design', 'full')` (variants:
  `quiet`, `empty`, `tools-absent`, `off`, `direct`, `no-project`, `no-session`), then a reload;
  `removeItem` goes back to the product. It replaces the three browser surfaces with the *same*
  components fed from `src/client/design-fixtures.ts`; the host runtime is untouched.

There is exactly **one** mock — `mockups/harness.html`. The three older mockups, the generated
preview and `scripts/build-design-preview.mjs` were retired with F-28: they were three copies of
one token shim and two of them still drew the segment bar F-26 removed.

The mock is a **project**, not a snapshot: it may (and now does) run ahead of the product in copy
and in the block scheme. Its divergence is listed in its own §4, and closing it is a normal unit of
work. Because of that, `pnpm design:parity` does **not** compare the product against the mock: it
checks the live panel's `getComputedStyle` in the live shell's theme, verdicts PASS / SKIP / FAIL.
The rationale for each rule lives in `docs/design/contracts/surfaces.md` §9, but the frozen
expected values themselves are literals inside `scripts/design-parity.mjs` — the doc explains, the
script decides, and a surface change updates both in the same pass. A chat message is not
documentation, and the mock is not the source of truth for what the product must do.

Fixtures for the stand agree with the gate's own (`scripts/design-parity.mjs`), so the picture, the
docs and the gate speak about one project.
