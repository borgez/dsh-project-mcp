#!/usr/bin/env node
/**
 * Mount one project's real MCP documents through the plugin and report the tools
 * that the servers actually publish. Verifies a project's own document end to
 * end (real mcp-client, real server processes): `.dsh/mcp.json` by default.
 *
 * Run: pnpm build && node scripts/check-config.mjs [projectDir] [timeoutSeconds]
 */

import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

const [target = '.', timeoutSeconds = '120'] = process.argv.slice(2)
const projectRoot = resolve(target)
const timeoutMs = Number(timeoutSeconds) * 1000

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
const agent = { id: 'check-config', session: { header: { cwd: projectRoot } }, ctx }
ctx.provide('agents', { list: () => [agent] })

const plugin = await import('../lib/index.js')
const fiber = await ctx.plugin(plugin, {
  watch: false,
  rescanIntervalMs: 60_000,
  debounceMs: 0,
  toolCallTimeoutMs: timeoutMs,
})

const deadline = Date.now() + timeoutMs
let names = []
while (Date.now() < deadline) {
  names = [...registered.keys()]
  if (names.some((name) => name.startsWith('mcp__'))) break
  await new Promise((r) => setTimeout(r, 250))
}

// Give every declared server a chance to finish publishing before reporting.
await new Promise((r) => setTimeout(r, 1_500))
const snapshot = ctx.get('projectMcp')?.snapshot()
// Optional probe: call one mounted tool through the real mcp-client bridge,
// e.g. CHECK_CONFIG_TOOL=server_status to confirm the server's workspace root.
const probeName = process.env.CHECK_CONFIG_TOOL
let probe
if (probeName !== undefined && probeName !== '') {
  const definition = registered.get(`mcp__${probeName}`) ?? registered.get(probeName)
  if (definition === undefined) {
    probe = { error: `tool ${probeName} is not registered` }
  } else {
    try {
      probe = { tool: probeName, result: await definition.execute({}, { signal: AbortSignal.timeout(60_000) }) }
    } catch (error) {
      probe = { tool: probeName, error: String(error?.message ?? error) }
    }
  }
}

console.log(JSON.stringify({ projectRoot, tools: [...registered.keys()], probe, snapshot }, null, 2))

await fiber.dispose()
const failed = names.length === 0 || snapshot?.projects?.[0]?.rows?.some((row) => row.status === 'error')
process.exit(failed ? 1 : 0)
