# F-19: the forwarding bridge — one process per project in a preset composition

- **Status:** implemented (Phase 3, C1).
- **Basis:** `docs/history/phase3-contract.md` §C1,
  `docs/roadmap.md` §"Phase 3".
- **Code:** `src/bridge.ts` (the bridge), `src/runtime.ts` (ownership and calls),
  `tests/bridge.spec.ts` (the spike proof).

## 1. The problem

A project declares MCP servers; the plugin must run **one** process per project and show its
tools to every session of that project. The ordinary path does exactly this: the session's scope
key is bound to the project's key (`bindScopeParent`), and the tool registry, walking
`scopeChainOf(agent)`, picks up the project's layer.

In a preset composition (the whole Web GUI) this path is unavailable. The preset roster binds
every composed agent's key to the preset's **standing** key *before* the agent is published
(`packages/preset/agent-presets/src/mount.ts`, `mountPreset`), and `dsh-scope` binds a key exactly
once (`packages/core/scope/src/index.ts`, `bindScopeParent`):

```
scopeParents: presetKey ← agentKey     (already bound, cannot be bound again)
```

The project's layer cannot enter this chain. While the plugin knew nothing else, it mounted the
same declarations **in the session's own layer** — working tools, but a second child process per
session. That was the very symptom F-19 exists for: "one process per project" stopped being true
in exactly the composition the owner uses.

## 2. The solution

The project holds **one** instance, as before, in its own layer. A session whose key could not be
attached to the project's layer receives, instead of a second instance, **thin forwarding
definitions** in its own layer: they mirror the model-visible surface of the project's tool and on
every call execute the project's definition.

```
project layer                             session layer (one per session)
┌──────────────────────────────┐         ┌───────────────────────────────────────┐
│ mcp-client: one instance     │         │ register("mcp__alpha__run") ─────┐    │
│  register("mcp__alpha__run") │◄────────┼── get("mcp__alpha__run", project)│    │
│  execute(args, exec)         │         │   → execute(args, exec)          │    │
└──────────────────────────────┘         └───────────────────────────────────────┘
         ▲                                                      ▲
         │  projectToolNames(project, schemas, servers)          │
         └── which names the project publishes ─────────────────┘
```

- **The owner** is the project. `holdProject` (`src/runtime.ts`) on a failed key binding does not
  start its own home, but leaves the session holding the project's one
  (`state.project = project`) and installs the bridge (`installBridge`/`dropBridge`). `homeOf` now
  returns only the project: exactly one home per project.
- **What to forward** — `projectToolNames(projectKey, ctx.tools.schemas, servers)` in
  `src/bridge.ts`: names are read **from the project scope's view**, not from the session's view
  (otherwise the bridge would see the session's own registrations and forward them into itself),
  and are filtered by the names of the servers the project actually mounted. The probe goes
  through `mountedSchemas(state)`, that is, through the home's key, so the session's catalog does
  not depend on whether the bridge has synced yet.
- **What must not be forwarded** — a name the session already resolves itself.
  `forwardProjectTools` skips such a name: the session's own registration wins, and no duplicate
  is created in one layer.
- **How to execute** — the call is delegated to the project's **live** definition, resolved by
  name at call time (`registry.get(name, project)`), not to a captured object. `mcp-client`
  replaces the whole generation of definitions on every `tools/list`; a captured reference would
  execute a dead generation.
- **How not to double the policy** — the bridge calls `definition.execute(args, exec)` directly,
  not `ctx.tools.execute(...)`: the outer call already passed pre-execute, guards, approval and
  post-execute under this session's identity, and re-dispatching would apply them twice.
- **What the panel sees** — unchanged: the project's row, the status, `is up`, unmounting and the
  logs remain project events. There is one home, so project events still carry no `sessionId`.
- **What the forwarder carries** — the project's whole definition except `execute`: the
  `forwarder` (`src/bridge.ts`) takes it **wholesale** (`...project`) rather than enumerating the
  known fields. Enumeration is what silently lost `finalizeContent`: the registry takes the
  finalizer off the definition the **session** resolves, that is, off the forwarder
  (`packages/core/tools/src/index.ts:1415`), and `@deepseek-ai/dsh-mcp-client` declares it
  (`packages/mcp/mcp-client/src/tools.ts:237`). Without it a bridged session gets flat text
  instead of saved MCP pictures. `presentCall`/`presentResult`, `timeoutMs`, `isConcurrencySafe`
  and `output` are carried the same way. `execute` is the only field that is replaced: the call
  resolves the project's live definition by name.

## 3. The synchronization triggers

The bridge must be "even" — the set of names in the session's layer must **match in composition
and order** the project's live tool set. There are three synchronizations, and they are cheap: an
identical name set exits immediately (`sameNames`).

1. **`installBridge`** — the session took the project: the first sync and a subscription to
   `tools/change` **in the session's scope**. The subscription is the real harness's path: the
   registry announces a change to all listeners, so a server that published its tools after the
   mount reaches the session's layer by itself.
2. **`settleActivation`** — the mount's activation finished. The instance is registered before
   its fiber published anything, so "the server is up" is the first moment there is something to
   forward.
3. **`mountedSchemas`** — reading the home's catalog. This is the same sync on the read path, so
   the session's layer cannot fall behind the catalog this probe returns.

### 3.1 Owning the batch: `ForwardBatch` (`src/bridge.ts`)

The sync must survive a **re-entry on its own event**. The registry emits `tools/change`
synchronously **from inside** a registration (`packages/core/scope/src/store.ts`,
`ScopedLayers.effect`: `if (notify) this.onChange()` after a successful insert), and the session's
subscription hangs on that same event — so every forwarder registration calls `sync` again. The
two batch rules are the fix:

- **Releasing the old batch — before registering the new one.** In one layer one name lives once,
  so registering over a live batch is rejected as a duplicate; on a duplicate the bridge yields
  (which is right for the session's own tool), and the names the old batch already held are
  silently lost. Without the release, a project `[a,b,c]` left the session `[a]` (or a tail
  `[a,c,b]`), while `namesIn` recorded the full set — and `sameNames` froze the loss forever.
- **A re-entry does not demolish the batch being built.** The nested call only marks the batch
  "dirty", and the owning frame runs once more on completion — which also picks up a set that
  changed during registration. `drop` holds the same barrier for the whole release (otherwise the
  release's own `tools/change` events resurrect the falling batch) and discards the scheduled
  pass.

A set change is always the whole batch: a server that added or removed tools leaves behind
neither a partial set nor a dead forwarder.

## 4. The spike proof

`tests/bridge.spec.ts` proves the mechanism **before** integration and on the real harness
primitives:

- `Context`, `ctx.plugin`, `ctx.effect`, `createScope`, `bindScopeParent` — the real
  `@deepseek-ai/cordis` and `@deepseek-ai/dsh-scope`;
- scope resolution — the real `ScopedLayers`/`NamedEntries`, the very engine on which
  `ToolRuntime` builds its layers (`packages/core/tools/src/index.ts`, `new ScopedLayers(...)`);
  registrations are made from real scope contexts;
- one thing is not from the harness — the **registry shell**: `@deepseek-ai/dsh-tools` is a peer
  the plugin does not import (`src/bridge.ts` and `src/activation.ts` describe its surfaces
  structurally), so the facade in the spec repeats the documented
  `register`/`get(name, scope)`/`schemas(scope)`/`execute` over the real store. The shell must
  also repeat **two behaviours** the syncs depend on: throwing on a duplicate name in its own
  layer (`NamedEntries.insert`) and emitting `tools/change` **after** the insert — then the
  `ForwardBatch` barrier is checked by the same event it lives on in prod. `namesIn(scope)` gives
  the test the layer's names as a separate projection. The session-registry double in
  `tests/runtime.spec.ts` follows the same two rules: with it, a bridge failure reproduces on the
  runtime stand, not only in the spike.

What is proven: a key already bound by a preset cannot be bound again (`bindScopeParent` throws);
each of two sessions sees the name from **its own** layer; a foreign scope and the global view do
not see the name; a call from both sessions executes **one** project instance (instance counter =
1); a session with its own registration keeps it; a call after the project's release fails with a
clear error instead of going to a dead generation.

What the fix's tests prove (§3.1): a re-sync with a live batch leaves the session with **exactly**
the project's set and in the project's order (`[a,b,c]`, not `[a]` and not `[a,c,b]`); a re-entry
through `tools/change` leaves no dead forwarders (a failed tool leaves together with its
forwarder, and `drop` does not resurrect the batch); the forwarder carries **all** the project
definition's fields, including `finalizeContent` — verified on a structural double of the
`dsh-mcp-client` definition and on its behaviour (a saved MCP picture reaches the result through
the forwarder).

## 5. Limits, and what to do on a harness refusal

- The bridge is a **thin layer per session**, not a second registry: it does not cache
  definitions, does not own the policy and does not rewrite model-visible fields. Its only state
  is the live batch (`ForwardBatch`): the name set, its releaser and the re-entry barrier.
- **Yielding to a duplicate does not distinguish the cause.** `forwardProjectTools` skips a name
  on which `register` threw, because "the session's own tool" is the expected case; any other
  registration failure (for example, an invalid schema) will be swallowed the same way, and that
  is a conscious price: one name's failure must not demolish the batch. After the order fix
  (§3.1) a duplicate means exactly one thing — the session itself resolves the name.
- **A failed sync leaves the session without forwarders until the next pass.** The batch is
  released before registration, so a failed registration leaves neither the old nor a partial
  generation: `namesIn` is not exposed, the next trigger repeats the pass. Keeping the session
  and its project is untouched by this (`syncBridge` only writes a `warn`).
- Only what the project published in **its own** layer is forwarded. A tool registered globally
  or in another scope is not seen by the bridge and must not be.
- `ctx.get('tools')` instead of `ctx.tools`: a scope context is an extended context
  (`createScope`), and a dotted read in it throws `cannot get property "tools" without inject`;
  `get` is the very injection-free path `src/activation.ts` already uses.
- **If the harness ever stops giving even this** — that is, if `ctx.tools.get(name, scope)`
  stops serving the project layer's definition, or executing a definition from a foreign scope is
  forbidden — the refusal must be explicit: the spike turns red first, no integration follows,
  the tree stays green, and the report records the exact `file:line` in the harness checkout and
  the remaining options (an own registry-facade with `bindScopeParent` through
  `ScopeParentBinding.rebind` where the plugin itself binds the key; moving the preset
  composition to the host level). There must be no half-implementation — no bridge without a
  spike, and no second instance disguised as a forward.

## 6. F-42: the session's own layer carries the runtime's private key, not the agent key

The spike above proved that a foreign scope does not see the names — but on scopes whose keys are
not bound to each other. The live Web GUI composition binds them differently: the preset roster
makes the **first agent key of the preset the standing key**
(`packages/preset/agent-presets/src/mount.ts`), and every next agent binds to it. The session's
own layer is minted as `mintScope(agent)` (`src/runtime.ts:2683`), that is, the own layer's key is
the **agent key**; as soon as two agents of one preset end up in one chain, one's resolution
passes through the other's own layer, and everything the runtime registered "in its session" (the
bridge's forwarders, the `tools/change` subscription) is visible to the neighbour — and through
the project layer raised in the chain, the other project's tools are visible too.

Observation 2026-09-22 (6 live sessions, 4 projects, the 21:47–22:43Z window): sessions of this
project carried `glider`×55, `grafana-dev`×81, `grafana-prod`×81 from a neighbouring project,
sessions of two neighbours — `tglider`×52 and `dsh-p-grafana-local`×81, and a foreign session was
**without its own** servers. The repro on real primitives — `tests/isolation.spec.ts` (sessions
arrive already bound, the way the roster binds them; real `ScopedLayers`/`NamedEntries`,
`createScope`, `bindScopeParent` and the real runtime pass): session B sees `['alpha','beta']`.

The contract:

- **The preset roster does not make an agent's layer the standing key.** The standing key is the
  roster's own object, not the first agent's `scopeOf(agentCtx)`
  (`packages/preset/agent-presets/src/mount.ts`); otherwise the first agent's own layer enters
  every next one's chain, and a foreign scope no longer saves it from the names.
- **The plugin cannot give a session a private layer.** The agent key is bound by the roster, and
  there is nothing to bind a private key into the session's chain with: the experiment with
  `state.sessionKey` was made and rolled back — the session goes blind to its own tools. While
  the host defect stands, what remains for the plugin is containment — keep foreign namespaces
  out of the request assembly.
- **A foreign binding is not silently re-bound.** `linkScopeParent` reports whether it created
  the binding or reused an existing one; on a reuse the bridge is chosen, not a key transplant.
- **Both lawful paths are preserved:** a session whose private key is bound to the project sees
  the project's layer through the chain; a session whose key is taken by a foreign composition
  gets forwarders in its own layer. Neither path gives a neighbour another project's tool.
- The `mountedSchemas` probe still reads the home by its key (`ProjectState.key`); `bridge.ts`
  and its spike do not change.

Verification: `tests/isolation.spec.ts` (two projects, two preset sessions, the invariant "the
`mcp__*` namespaces do not intersect and each session carries its own") plus a live measurement —
the `contextHeaders` of sessions of two different projects in one process must not contain each
other's namespaces.
