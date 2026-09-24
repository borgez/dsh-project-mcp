# dsh-project-mcp roadmap

> The phased backlog — the source of ideas for new F-NN rows in `docs/features.md`.
> Volatile numbers are not kept in this file: the «Current metrics» section below names
> the commands that produce them instead of values that rot.

---

## Phase 1 — Observability and UI honesty

**Goal:** the panel does not lie and explains what is happening to the servers.

- [x] A multiline mount detail with facts instead of one glued line (0.1.16, §19)
- [x] Lifecycle log: `mounting` / `is up` / `unmounting` with a reason (0.1.19, §22)
- [x] A block of declared servers in "Tools" mode (0.1.17)
- [x] The detail compressed to three facts — no hints, no mention of retry (0.1.20)
- [x] **F-10** "Logs" tab in the sidebar: the plugin's event ring buffer, a `Logs N` segment,
      filters, "show more" — the mockup approved (`docs/history/logs-parity.md` §6.1)
- [x] **F-11** Disclosure budget in real units: `slotBudget()` deleted, the line prints
      `surfaceChars`/`budgetChars` and `≈ tokens`
- [x] **F-12** A settings page with no invented fields: `policy`, `prefix`, `slots` and
      `settingsPlans` removed, the prefix shown as a fact
- [x] **F-18** Toasts as servers start: the `shell.overlay` frame slot,
      the source is the plugin's same status channel

- [x] **F-29** The promised pin: rows suggested by the counters carry a `Pin` action — the very
      one promised by the caption `and {count} more offered by the counters alone — pin one to keep it
      in every request`, which was drawn without an action. Along the way the counters stop calling
      the whole `baseline` tier pinned: `pinned` is `policy.pins`, and the counter-suggested part is
      its own share (`by the counters`), so the line no longer says "2 pinned" over a list of one name
- [x] **F-30** A pin picker on the Tools page: the list of tools visible to the session with a `pin`
      toggle sets and unsets the pin in the same place the pins are listed — through the same
      `POST <prefix>/pin` the tab's buttons use, so both entries write one list

- [x] **F-31** The entry editor: the JSON moved **under the form** and became editable. The panel
      body is the declaration in the shape the document holds it (`documentBody`: `env`/`headers`
      as flat objects of strings), and every input is parsed back into the same draft
      (`draftFromJson`). Unparseable text leaves the draft untouched and blocks `Save…` with a line
      saying what exactly failed to parse; keys whose value the panel cannot see (a masked secret,
      a key from `.env` or a credentials file) are preserved as they are — their absence from the
      text means "do not change". On a narrow window the list, the form and the body fold into one
      column

## Phase 2 — Parity with the mock

**Goal:** the UI matches the surfaces contract where a divergence is visible (`docs/design/contracts/surfaces.md`; before F-28 the check was against the mock — now the mock is a project).

- [x] The 0/12/24/36 nested-row ladder and the Surface A checklist (0.1.21, §26)
- [x] **F-13** A step tag on the disclosed tool: the step is computed on `agent/pre-step`,
      `OfferedTool.step` is published; no step — no tag
- [x] **F-14** A second owner of presentation (`ProjectSnapshot.presentation`, the known
      speculative names) and a real `serverName` conflict report
- [x] **F-15** A request preview from the actual visible list and a real estimate
      (`visibleChars`/`deferredChars`)
- [x] **F-16** Per-server tool counters (by the `mcp__<server>__` prefix) — the
      "server is offered directly" line stopped being a stub
- [x] **F-17** Remaining parity: the segment track's background, the `tag` chip, `muted` versus
      `.dim`, the collapse marker only on the collapsed session
- [x] The phase's closing criterion: `src/client/demo.ts` deleted, `demoBadge()` not called,
      the `demoTools()` fixture lives in `tests/helpers/tools.ts`, the word "stub" is absent from
      `docs/design/contracts/surfaces.md` §8

## Phase 3 — Architecture and quality

**Goal:** bring back what had to be simplified, and hold the bar.

- [x] **F-19** Forwarding bridge: one project `mcp-client` + thin definitions in each session's
      layer — one process per project in the preset composition (`docs/design/contracts/bridge.md`)
- [x] **F-20** Per-file 80% coverage for `src/client/settings.ts` and `view.ts`: `view.ts`
      98.4/95.1, `settings.ts` 96.8/89.6 at the time of closing, enforced by the per-file check in
      `scripts/audit.mjs`; there is no `jsdom`/`happy-dom`/`react-dom` in the tree, so both specs
      raise their own React hook dispatcher
- [x] **F-21** Notifications as a service: one "plugin event → consumers" point
      (`src/notifications.ts`); the host log keeps its own texts and levels (§C3.1)
- [x] **F-23** Design parity: `pnpm design:parity` compares the `getComputedStyle` of live panels
      with the mock's declarations through the CSSOM (the number of rows grows with every new gate
      row; the current reading comes from running `pnpm design:parity` itself), the
      `docs/design/parity/` gallery holds the "expected / actual" pairs, and
      `tests/design-artifacts.spec.ts` keeps the artifacts from drifting away from their sources
- [ ] **F-22** `${...}` variables from the project: `<project>/.dsh/.env` → `<project>/.env` →
      `process.env` → `~/.dsh/.credentials.yaml` for both syntaxes (`${VAR}` and
      `${input:VAR}`), with sources re-read on mtime — editing any of the files re-parses the
      documents and remounts the servers without editing `mcp.json`
- [x] **F-24** Project-first server panel: after F-19 there is one holder — the project
      `mcp-client` — so the `sessions` disclosure is no longer a "who holds what" list: it appears
      only if a session diverges from the project on the `name → set of statuses` map, and lists
      only the diverging ones; when all agree there is no section at all. The price of the decision:
      an individual session's `Release` button is available only from this block, that is, only on
      divergence
- [x] **F-25** Gate runs clean up their `dsh` processes: `scripts/dsh-reaper.mjs` hangs the server
      group's kill on `exit`, SIGINT/SIGTERM/SIGHUP and uncaughtException, and before and after a
      run sweeps its profile's orphaned servers (exact launch-flag match and `ppid === 1`). Without
      it, a `dsh` that survived an interrupted run held the sessions shared by all profiles under
      `$DSH_HOME`, and the client answered `session/writer-held` — "This session is already in
      use" — meaning the person's new-session creation broke
- [x] **F-27** Design stand: `docs/design/mockups/harness.html` — the self-contained mock of all
      surfaces inside the shell's chrome (the token layer copied verbatim from the design system,
      theme and stand-state switchers), and the client's design mode (`src/client/design.ts`) —
      the same `PanelHeader` / `tabBody` / `SettingsPage` / `ProjectBlock` / `ToastStack`
      components drawn from fixtures without a host, behind the `dsh-project-mcp:design` flag. The
      surfaces contract is `docs/design/contracts/surfaces.md`, the checks are `tests/design.spec.ts`
- [x] **F-28** The mock as a project, and a documents cleanup: the tab's blocks reduced to one
      scheme (one number per block in its header, empty groups stay silent, the sessions summary and
      the tool name are not repeated, the fact goes on a line under its own line), the "Toasts"
      section removed, typography and the class vocabulary shared across all surfaces. The three old
      mocks, the composite preview and `scripts/build-design-preview.mjs` deleted — there is one
      mock. The `design:parity` gate no longer reads the mock: it checks the **live** interface
      against the contract (`docs/design/contracts/surfaces.md` §9), because the mock now runs ahead
      of the product and cannot be the expected picture. Deleted: `HANDOFF.md`,
      `HANDOFF-TOOL-DISCLOSURE.md`, `contracts/mockup-port.md`, `contracts/visual-parity.md`,
      `docs/design/verification/` (the live findings moved into the contracts and the registry) and
      the `design/` studio draft with an ignore rule on the exact path
- [x] **F-26** One tab surface: the `Servers` and `Problems` segments removed (their content is
      visible in `Tools` anyway), the errors block and the logs block moved under disclosures
      (errors — only when they exist, both collapsed by default), and a tool row discloses into a
      detail with the full `mcp__<server>__<tool>`, the server, the tier and the step. The interface
      contract is `docs/design/contracts/single-surface.md`; the host does not publish per-tool
      estimates, so the disclosure prints only real fields, and the estimate remains the group
      budget line

- [ ] **F-38** The disclosure budget over the **whole visible MCP surface**: the profile plane
      (`mcp__grafana-local__*` — 23 384 tokens in every request of every `web` profile session)
      is currently outside the plugin's budget, because the budget counts only the plugin's own
      project mounts, and on top of that the plugin today subtracts nothing from the assembly —
      `deferred` is a report, not an effect. One rule for all planes: pins keep the chosen names
      direct, the rest genuinely leaves the request and is reached by search, the profile config is
      not edited

---

## Phase 4 — Internationalization and public documentation

Done as one arc (F-46 … F-49), each with a registry row in `docs/features.md`:

- [x] **F-46** i18n foundation: three complete client dictionaries (`zh`/`en`/`ru`), compile-time
      completeness, `ru` registered as a harness language
- [x] **F-47** all client copy reads from the dictionaries, English values byte-identical
- [x] **F-48** host messages as codes: 73 wire codes across six channels, translated on the
      client, English `message` as the degradation path, two-sided coverage check
- [x] **F-49** this documentation: live docs English, closed material archived under
      `docs/history/`, mock and parity fixtures moved with the docs in one coupled pass,
      the language conventions recorded in `AGENTS.md`, the README restructured with a
      table of contents (user half first)

---

## Ideas (not yet shaped into F-NN)

- **The reaper does not cover the boot scripts' chromium.** `scripts/dsh-reaper.mjs` sweeps only
  `dsh` servers, while five scripts (`design-parity`, `design-gallery`, `design-shot*`, `e2e-boot`)
  spawn headless chromium and kill it only on the normal path (`finally`): an interrupted run leaves
  the client forever. Measured 2026-09-19: two `dsh-parity-chrome-*` processes lived 2 h 45 min,
  their renderers burning 3–4% CPU each and holding a page against a dead server. Fix: sweep by
  `--user-data-dir` (`dsh-parity-chrome-*`, `dsh-gallery-*`) plus a signal handler on every spawn
- Publishing `LogEvent` outward (to the system log) with the same buffer the tab serves —
  so "Logs" and the DSH log do not diverge.
- Checking `retry()` from the panel for a server whose declaration changed while its mount is still
  `connecting`: today the declaration fixes this, not the button.
- A "Show in log" button on a problem row — jump to that server's latest events
  (F-10 is done, the idea waits for its turn)
- Determining the owner of `assembly.tools` by write capabilities instead of a set of speculative
  names: the loader exposes only proxy names, so F-14 A3 learns about a second owner only from a
  known list (`docs/history/phase12-contract.md` §C3).
- Exporting the snapshot as JSON from the panel for bug reports (today only the route serves it).
- The F-19 bridge does not notice that a name is no longer shadowed by the session's own
  registration: the project's catalog then appears only with the next change to the project's set
  (self-healing).
- The bridge's `drop()` called from a `tools/change` listener resets the re-entry barrier: there is
  no real caller (the only listener is `syncBridge`), but a second one will need a depth counter.
- Gate runs in an isolated `$DSH_HOME`: F-25 cleans up after itself, but the test instance still
  reads the same session store as the person — a separate home removes the whole "a run occupied the
  user's session" class. The price: `dsh plugin add link:` for the profile would have to be repeated
  in that home.

## Current metrics

Volatile numbers are not kept here — they rot. The commands that produce the current values:

| Metric | Command |
|---|---|
| Tests and coverage (threshold 80 on four metrics; per-file ≥80 for `src/client/view.ts` and `settings.ts` — a separate check in `scripts/audit.mjs`) | `pnpm check` |
| Repository audit (including "boot script reaps its dsh" for all four boot scripts, F-25) | `node scripts/audit.mjs` |
| Design parity (live UI against the contract, verdicts PASS / SKIP / FAIL) | `pnpm design:parity` |
| Browser boot of both test profiles against the real `$DSH_HOME` | `pnpm e2e` and `pnpm e2e --profile test-web` |
| The packed artifact's version and the profile it is installed into | `pnpm pack`, `package.json` |

Durable context for the design-parity row: the gate no longer reads the mock — it compares the live
UI with the contract, naming the token and taking its value off the live shell. There is one mode
(F-26): the segment bar was the anchor of the whole Surface A probe, so F-26 re-anchored it onto the
tab's own scrolling body and replaced the six segment checks with the disclosures and the tool
detail.
