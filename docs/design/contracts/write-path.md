# The write mode: the rules

The continuation of the mock (`docs/design/mockups/harness.html`, the decisions table in
`README.md`, the "Write mode" row). Editing existing entries and nothing else: creating and
deleting servers is a separate step, not present here.

This document is the shared contract of the host and the client. The host writes by it, the
client draws by it.

## What may be written

| Tier | Document | `writeScope` | Condition |
|---|---|---|---|
| project | the documents `localFiles` allows (by default `<project>/.dsh/mcp.json`) | `project` | a confirmation in the form is enough |
| global | the documents `globalFiles` allows (by default — none) | `global` | `consent: true` in the request **and** `allowGlobalWrite: true` in the config |
| profile, `<DSH_HOME>`, built-ins | — | `readonly` | never; `writeBlockedReason` explains why |

The write goes **to the document the entry came from** (`ServerRow.source`). If the entry is
overridden by a higher-priority document, the declaring document is edited anyway, and the form
shows a warning: the edit will not change what is actually mounted.

## How the write happens

1. **Format.** The document is parsed, `mcpServers[server]` is replaced wholesale, the document's
   other keys are preserved. Serialization — 2 spaces, a trailing newline. Other formatting
   (indentation, key order outside the entry) is normalized: this is stated in the confirmation
   the user sees.
2. **Atomicity.** First a `<document>.bak` copy, then a write to a temporary file in the same
   directory and a `rename` over it. A failure at any step leaves the document as it was.
3. **Validation.** The write goes through the same parsing as mounting (`parse.ts` + the
   mcp-client schema). What the host would not mount is not written: the answer is `invalid`.
4. **Revision.** `ServerRow.documentRevision` — the document's revision at snapshot time. The
   request must carry the same revision; a mismatch is a `conflict`, the document is untouched,
   the form offers to re-read.
5. **After the write** — a rescan, the answer carries a fresh snapshot.

## Secrets

An `env`/`headers` value may be a secret: the host marks it `masked: true` and does **not** serve
the value. The write rule:

- a key arrives with `masked: true` and without `value` — whatever is declared stays in the
  document;
- a key arrives with `value` — that value is written into the document;
- a key absent from the entry — the key is deleted.

This way a form that cannot see the secret cannot erase or replace it; an empty value is
`value: ''`, not a missing `value`. A key whose value was answered by an external source — the
project's `.env` or a credentials file (`fromCredentials`, the field name is historical) — is not
written into the document at all: the declared reference text (`${VAR}` / `${input:VAR}`) stays
there.

## What the user sees

- The form's fields are editable while `writeScope !== 'readonly'`; otherwise — the previous
  blocked rendering with `writeBlockedReason`.
- The JSON pane (under the form, F-31) shows the **entry's body** the way the document holds it,
  and is editable: input is parsed back into the same draft, and unparseable text blocks "Save"
  and says what exactly failed to parse. Keys whose value the panes do not show (masked ones and
  ones answered outside the document) stay in the entry as they are.
- Saving — only with a confirmation: the document's path, the `.bak` fact, the format
  normalization. For the global tier the confirmation carries consent (`consent`).
- Errors are told apart by code (`invalid` / `blocked` / `conflict` / `not-found` / `failed`) and
  say whether the document was written. `conflict` offers a "re-read" action.
