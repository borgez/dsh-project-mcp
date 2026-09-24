# The parity gallery: "expected" and "actual"

The point of this folder is to keep the **approved mock** and the **actual rendering** of one
surface side by side, so changes are discussed against a concrete pair rather than from memory.
This is not a test (the machine comparison of declared properties lives in
`scripts/design-parity*.mjs`) — these are pictures for the eyes.

## How to update

```bash
node scripts/design-gallery.mjs                 # both halves
node scripts/design-gallery.mjs --only expected # the mock crops only (no live profile)
node scripts/design-gallery.mjs --only actual   # the product only (needs a profile with link:<workspace>)
```

- `expected/*.png` — a crop of a section of the single mock `docs/design/mockups/harness.html`, 2x,
  dark theme (the mock opens dark).
- `actual/*.png` — shots from a live profile (`test-web`): the tab — `scripts/design-shot.mjs`,
  settings — `scripts/design-shot-settings.mjs`, light and dark theme.
  Next to the settings shots sit `*.txt` files — an aria dump of the same page (text without
  pixels).

The `actual/` half is **not committed** (`docs/design/parity/actual/` is in `.gitignore`): it is a
snapshot of a specific machine at the moment of shooting, and it is generated locally. Only the
approved `expected/` half lives in the repository — so a missing `actual/` in a fresh clone is not
an index divergence, it is "the gallery has not been shot here yet".

## Pairs

| Surface | Expected | Source | Actual |
|---|---|---|---|
| A · the sidebar tab, the single surface (F-26) | `expected/tab-servers.png` | `docs/design/mockups/harness.html` §1 "The sidebar tab — one surface", `#tab .h-app` | `actual/tab-light.png` |
| A · the logs disclosure's body | `expected/tab-logs.png` | same file, `#tab .h-app`; the crop opens the `Logs` disclosure (`#dark,tab,logs`) — it is collapsed by default | inside the same single surface — `actual/tab-light.png`; the parity gate measures the filters and the event row |
| B · settings, "Servers" | `expected/settings-servers.png` | `docs/design/mockups/harness.html` §3 "The page in the native settings", `#settings .h-panel` (the `Servers` view is open by default, `#dark,settings`) | `actual/settings-servers-{light,dark}.png` |
| B · settings, "Tools" | `expected/settings-tools.png` | same file, `#settings .h-panel`; the crop opens the `Tools` view (`#dark,settings,tools`) | `actual/settings-tools-{light,dark}.png` |
| B · settings, "By files" | — | — | `actual/settings-files-{light,dark}.png` |

The tab's snapshot has **one name — `actual/tab-light.png`**, the file `scripts/design-gallery.mjs`
writes. What is inside depends on who shot it: the gallery's own run shoots the self-booted shell,
which has no live agent and draws the tab's empty state; a shot with the fixture data (servers, a
session divergence, tools, the error and log disclosures) is taken by the gate —
`node scripts/design-parity.mjs --shot docs/design/parity/actual/tab-light.png` — which raises the
profile and injects the fixture. Both overwrite the same file, so read the row's date before
arguing from it.

## What to read here with a caveat

1. **The crop's state is set by the hash from `scripts/design-sections.json`.** There is one mock
   (`harness.html`), and it keeps its disclosures and the second settings page closed; the crop
   opens what it needs with a deep link (`#dark,tab,logs`, `#dark,settings,tools`). A hash the page
   does not answer is caught by `tests/design-artifacts.spec.ts` — that is not something to hunt
   with the eyes.
2. **Theme.** The mock opens dark (`data-ds-dark-theme`); the live shell is shot in light as well.
   Part of any divergence is the theme palette, not the layout.
3. **Width.** The mock draws a 451 px sidebar — the same width at which the parity gate measures
   the live panel; the settings crop takes the dialog panel (`.h-panel`, 800 px), not the mask
   around it.
4. **States.** The mock shows states with fixtures (a server in `error`, a `conflict`, an empty
   project) and by default — "all states at once". A live shot records whatever the profile held at
   shooting time, so compare the same row/state, not "the number of rows".
