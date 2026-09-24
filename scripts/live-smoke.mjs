#!/usr/bin/env node
/**
 * End-to-end smoke test for the built plugin.
 *
 * Boots a real Cordis host with a stubbed `tools`/`agents` service, points a
 * temporary project at `scripts/fixture-mcp-server.mjs`, loads `lib/index.js`,
 * and waits for the real `@deepseek-ai/dsh-mcp-client` to publish
 * `mcp__smoke__echo` through the project-scoped mount.
 *
 * A smoke host has no agent loop to start a turn, so the mount is requested the
 * way the panel's Sync button does it — `projectMcp.syncNow()`. The lazy default
 * stays on and is asserted first: nothing may run before that request, and a
 * release must stop the server again without losing the row.
 *
 * Run: pnpm build && node scripts/live-smoke.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const here = dirname(fileURLToPath(import.meta.url))
const project = mkdtempSync(join(tmpdir(), 'project-mcp-smoke-'))
mkdirSync(join(project, '.dsh'), { recursive: true })
mkdirSync(join(project, 'src'), { recursive: true })
writeFileSync(
  join(project, '.dsh', 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      smoke: { command: process.execPath, args: [join(here, 'fixture-mcp-server.mjs')] },
    },
  }),
)

/** Tools registered by the mounted mcp-client instance. */
const registered = new Map()
const ctx = new Context()
ctx.provide('tools', {
  register: (definition) => {
    registered.set(definition.name, definition)
    return () => registered.delete(definition.name)
  },
  schemas: () => [...registered.keys()].map((name) => ({ name })),
  get: (name) => registered.get(name),
})

const agent = { id: 'smoke-session', session: { header: { cwd: join(project, 'src') } }, ctx }
ctx.provide('agents', { list: () => [agent] })

const failures = []

/**
 * Print one smoke assertion and remember a failure.
 * @param label - what was asserted.
 * @param ok - whether it held.
 * @param detail - optional observed value.
 */
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** @param ms - milliseconds to wait. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const plugin = await import('../lib/index.js')
const fiber = await ctx.plugin(plugin, {
  watch: false,
  rescanIntervalMs: 60_000,
  debounceMs: 0,
  credentialsFile: join(project, 'missing-credentials.yaml'),
})

const service = ctx.get('projectMcp')
if (service === undefined) {
  await fiber.dispose()
  rmSync(project, { recursive: true, force: true })
  console.error('SMOKE FAILED: the host half published no projectMcp service')
  process.exit(1)
}

const rows = () => service.snapshot().projects[0]?.rows ?? []

try {
  // The whole point of lazy: a session that has not started a turn runs nothing
  // and still sees what its project declared.
  await sleep(500)
  check(
    'lazy default runs no server before a turn',
    registered.size === 0,
    [...registered.keys()].join(', '),
  )
  check(
    'the declaration is already visible as idle',
    rows().length === 1 && rows()[0]?.status === 'idle',
    rows()
      .map((row) => `${row.name}:${row.status}`)
      .join(', '),
  )

  // The panel's Sync button path: an operator call mounts regardless of lazy.
  await service.syncNow()

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !registered.has('mcp__smoke__echo')) await sleep(200)

  const names = [...registered.keys()]
  console.log('registered tools:', names)
  check('the mounted server publishes its tool', names.includes('mcp__smoke__echo'), names.join(', '))
  check('the project row turns active', rows()[0]?.status === 'active', rows()[0]?.status ?? 'no row')

  const projectSnapshot = service.snapshot().projects[0]
  check(
    'the snapshot breaks the project down per session',
    projectSnapshot?.sessions.length === 1 && projectSnapshot.sessions[0]?.id === 'smoke-session',
    JSON.stringify(projectSnapshot?.sessions.map((session) => session.id) ?? []),
  )
  check(
    'that session reports its own active row',
    projectSnapshot?.sessions[0]?.rows[0]?.status === 'active',
    projectSnapshot?.sessions[0]?.rows[0]?.status ?? 'no row',
  )

  await service.release('smoke-session')
  await sleep(300)
  check('release stops the server', registered.size === 0, [...registered.keys()].join(', '))
  check('the released row stays visible as idle', rows()[0]?.status === 'idle', rows()[0]?.status ?? 'no row')
} finally {
  await fiber.dispose()
  rmSync(project, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`SMOKE FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('SMOKE OK')
