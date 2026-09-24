# History: closed plans and frozen contracts

> Archived record — kept for decisions, not a contract. Do not extend; the live docs are `docs/…` (as of F-49).

Everything in this directory is a **record of decisions taken**, not a live document. The content stays in Russian deliberately: translating frozen history has no reader value. The live documents are `docs/features.md` (the F-NN registry), `docs/design/contracts/*` (what was decided), and `docs/design/README.md` (the entry point).

| File | What it is | State |
|---|---|---|
| `phase12-contract.md` | The frozen wave 1–2 interfaces contract | frozen by the coordinator 2026-09-18, before the writing started |
| `phase3-contract.md` | The frozen wave-3 contract (F-19, F-20, F-21) | frozen by the coordinator 2026-09-18; the wave is closed |
| `logs-parity.md` | The wave plan (logs, async start, mock parity): §0 what was closed, §1 waves and dependencies, §2–§4 waves 1A/1B/2, §5 docs, §6 open questions and review decisions, §6.2 wave status, §7 gates and commit order | waves closed; the file remains as the decision log |
| `wave4-demo.md` | §8 of the wave plan ("Wave 4 — close the demo stubs", F-11…F-16) as a separate file, with the revision inventory and the §8.1–§8.3 verdicts | closed: `src/client/demo.ts` is deleted, no stubs remain |
| `preview-proposal/index.html` | **A proposal, never approved:** a delta over the surfaces contract — `connecting` pulse, budget thresholds, skeleton and dashed empty states; log filters (servers, search, follow, copy line); pin search, table sort, draft diff; repeated-toast grouping | draft; the approved mock remains `docs/design/mockups/harness.html` |

**The F-33…F-36 labels inside `preview-proposal/` are informal and were never registered.** Its F-34 collides with the registry's F-34 (session usage counter, `docs/features.md`). F-33, F-35 and F-36 are recorded in the registry as claimed-but-never-registered so nobody reuses them silently; if the proposal is ever approved, the units take fresh numbers.

How much of these plans reached the product is visible in `docs/features.md` (the F-NN registry) and `docs/design/contracts/*` (what exactly was decided); what verified it is named in the registry rows.
