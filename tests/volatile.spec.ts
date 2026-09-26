/**
 * Volatile config fields (F-54): the schema flags exactly the live-editable
 * keys, `liveValue` unwraps both shapes a host can hand over, and
 * `resolveConfig` resolves volatile refs and plain values alike.
 */
import { describe, expect, it } from 'vitest'
import {
  Config,
  VOLATILE_CONFIG_KEYS,
  liveValue,
  resolveConfig,
} from '../src/index.ts'

interface FieldSchema {
  meta: { volatile?: boolean }
}

const fields = (Config as unknown as { dict: Record<string, FieldSchema> }).dict

describe('volatile schema fields', () => {
  it('flags exactly the keys the runtime may merge live', () => {
    const flagged = Object.entries(fields)
      .filter(([, field]) => field.meta.volatile === true)
      .map(([key]) => key)
    expect(flagged).toHaveLength(18)
    expect([...flagged].sort()).toEqual([...VOLATILE_CONFIG_KEYS].sort())
  })

  it('lists no key the schema does not carry', () => {
    for (const key of VOLATILE_CONFIG_KEYS) expect(fields).toHaveProperty(key)
  })
})

describe('liveValue', () => {
  it('returns a plain value unchanged, including undefined', () => {
    expect(liveValue(true)).toBe(true)
    expect(liveValue(42)).toBe(42)
    expect(liveValue('x')).toBe('x')
    expect(liveValue(undefined)).toBeUndefined()
  })

  it('unwraps a volatile ref at read time, so a re-point is seen', () => {
    let value = 1
    const ref = { get: () => value }
    expect(liveValue(ref)).toBe(1)
    value = 2
    expect(liveValue(ref)).toBe(2)
  })

  it('unwraps a ref that currently yields undefined', () => {
    expect(liveValue({ get: () => undefined })).toBeUndefined()
  })
})

describe('resolveConfig', () => {
  it('resolves getter-shaped volatile fields to their current values', () => {
    const raw = {
      envFiles: { get: () => false },
      idleTimeoutMs: { get: () => 1_234 },
      localPrefix: { get: () => 'mine' },
      activationEnabled: { get: () => false },
      activationToolBudgetChars: { get: () => 0 },
    } as unknown as Config
    const resolved = resolveConfig(raw)
    expect(resolved.envFiles).toBe(false)
    expect(resolved.idleTimeoutMs).toBe(1_234)
    expect(resolved.localPrefix).toBe('mine')
    expect(resolved.activationEnabled).toBe(false)
    expect(resolved.activationToolBudgetChars).toBe(0)
  })

  it('re-reads a ref on every resolution, so a live edit is picked up', () => {
    let enabled = true
    const raw = { activationEnabled: { get: () => enabled } } as unknown as Config
    expect(resolveConfig(raw).activationEnabled).toBe(true)
    enabled = false
    expect(resolveConfig(raw).activationEnabled).toBe(false)
  })

  it('keeps plain fixtures resolving exactly as before', () => {
    const resolved = resolveConfig({ idleTimeoutMs: 0, envFiles: true })
    expect(resolved.idleTimeoutMs).toBe(0)
    expect(resolved.envFiles).toBe(true)
    // An untouched volatile key falls back to its default, ref shape or not.
    expect(resolved.activationEnabled).toBe(true)
  })
})
