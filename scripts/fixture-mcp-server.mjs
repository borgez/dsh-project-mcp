#!/usr/bin/env node
/**
 * Dependency-free MCP server over stdio for `scripts/live-smoke.mjs`.
 *
 * Implements just enough of the protocol for the real
 * `@deepseek-ai/dsh-mcp-client` to connect and discover one tool:
 * `initialize`, `ping`, `tools/list` and `tools/call`. Frames are
 * newline-delimited JSON-RPC 2.0, per the MCP stdio transport.
 */

import { rmSync, writeFileSync } from 'node:fs'

// Optional PID handshake for `scripts/audit.mjs`: the parent proves the child
// exited when the plugin disposes its mount.
const pidFile = process.env.AUDIT_PID_FILE
if (pidFile !== undefined && pidFile !== '') {
  writeFileSync(pidFile, String(process.pid))
  const cleanup = () => {
    try {
      rmSync(pidFile, { force: true })
    } catch {
      // best effort
    }
  }
  process.on('exit', cleanup)
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })
}

let buffer = ''

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function handle(request) {
  const { id, method, params } = request
  if (method === 'initialize') {
    result(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'project-mcp-smoke', version: '1.0.0' },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') {
    result(id, {})
    return
  }
  if (method === 'tools/list') {
    result(id, {
      tools: [
        {
          name: 'echo',
          description: 'Echo the given value back.',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      ],
    })
    return
  }
  if (method === 'tools/call') {
    const value = params?.arguments?.value
    result(id, { content: [{ type: 'text', text: `echo:${String(value)}` }] })
    return
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${String(method)}` } })
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line !== '') {
      try {
        handle(JSON.parse(line))
      } catch {
        // Ignore a malformed frame; the client reports the failure itself.
      }
    }
    index = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
