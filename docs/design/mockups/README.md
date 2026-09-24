# The mock: the approved picture

This folder holds the product's approved form and **one** mock — `harness.html`:
a self-contained HTML document with the DSH tokens copied verbatim and every surface inside the
shell's chrome. Edits go into it.

| Mock | What it shows |
|---|---|
| `docs/design/mockups/harness.html` | All surfaces inside the shell's chrome: §1 the sidebar tab (the single surface, servers, the `sessions` / `Problems` / `Logs` disclosures, the tool row), §2 the tab's settings drawer, §3 the page in the native settings (`Servers` / `Tools` / by files / the entry editor), §4 the differences and the boundaries |

The hash addresses a theme, a section and a state: `harness.html#dark,tab,logs`,
`#light,settings,tools`, `#dark,tab,problems`. The gallery (`scripts/design-sections.json`) uses
this so a crop shows a disclosure or a page view the file keeps closed by default.

The three former mocks, the assembled `preview.html` and `scripts/build-design-preview.mjs` were
deleted with F-28: they were three copies of one token shim, and two of them still drew the segment
bar F-26 removed.

## How the gallery is updated

The "expected / actual" gallery is `docs/design/parity/`; its table lives in
`scripts/design-sections.json`, and updating it is one command:

```bash
node scripts/design-gallery.mjs                 # both halves
node scripts/design-gallery.mjs --only expected # the mock crops, no live profile
node scripts/design-gallery.mjs --only actual   # the product shots, needs a profile with link:<workspace>
```

`expected/*.png` — crops of the mock's sections, 2x, dark theme (the mock opens dark);
`actual/*.png` — shots of the live profile (`scripts/design-shot.mjs`,
`scripts/design-shot-settings.mjs`). The gallery's index and its files are checked by the same
`tests/design-artifacts.spec.ts`: it also demands that every `hash` in the table is answered by
the page's own script.

## The mock is a project, not a snapshot

`harness.html` is a **proposal**, not a reference: it is allowed to run ahead of the product in
copy and in the block scheme, and its divergences are listed in its own §4. That is why
`pnpm design:parity` (`scripts/design-parity.mjs`) does not compare the product against the mock:
it reads the live panel's `getComputedStyle` and holds it against expected values frozen as
literals inside the script — `docs/design/contracts/surfaces.md` §9 holds the rationale for each
rule: the doc explains, the script decides, and a surface change updates both in the same pass.
The source of truth for the product is that pair, not the picture.
