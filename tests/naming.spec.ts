/**
 * The local namespace that lets a project's own server coexist with a
 * profile-level instance of the same name.
 *
 * Contract under test: the alias is a pure function of the declared name, the
 * prefix and the names already taken, so the panel, the mount and the tool
 * prefix can never disagree about it. A prefix is explicit config first,
 * then the project's own folder; a project whose folder yields nothing usable
 * has no alias at all rather than a magic one.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_LOCAL_PREFIX_LENGTH,
  aliasOf,
  deriveLocalPrefix,
  resolveConflictNames,
} from '../src/naming.ts'

describe('deriveLocalPrefix', () => {
  it('takes the project folder, lowercased', () => {
    expect(deriveLocalPrefix('/Users/dev/e/rd/dsh-project-mcp')).toBe('dsh-p')
  })

  it('strips what a serverName cannot carry', () => {
    expect(deriveLocalPrefix('/Users/dev/work/orbit-service')).toBe('orbit')
  })

  it('never starts a name with a digit and never runs past the cap', () => {
    expect(deriveLocalPrefix('/Users/dev/work/2fast-service')).toBe('fast')
    expect(deriveLocalPrefix('/Users/dev/work/abcdefghijklmno')).toBe('abcde')
  })

  it('has no answer for a folder that yields nothing', () => {
    expect(deriveLocalPrefix('/Users/dev/work/---')).toBeUndefined()
    expect(deriveLocalPrefix('/')).toBeUndefined()
    expect(deriveLocalPrefix('')).toBeUndefined()
    expect(deriveLocalPrefix('/Users/dev/work/42')).toBeUndefined()
  })
})

describe('aliasOf', () => {
  it('prefixes the declared name', () => {
    expect(aliasOf('grafana-dev', 'p')).toBe('p-grafana-dev')
  })

  it('trims the declared name so the alias fits the serverName cap', () => {
    const alias = aliasOf('a'.repeat(32), 'abcde')
    expect(alias).toHaveLength(32)
    expect(alias.startsWith('abcde-')).toBe(true)
    expect(alias).not.toHaveLength(31)
  })
})

describe('resolveConflictNames', () => {
  it('names every reserved declaration the profile does not shadow', () => {
    const alias = resolveConflictNames({
      entries: [
        { name: 'grafana-dev', reserved: true },
        { name: 'gitea', reserved: false },
        { name: 'grafana-prod', reserved: true },
      ],
      prefix: 'p',
    })
    expect(alias.get('grafana-dev')).toBe('p-grafana-dev')
    expect(alias.has('gitea')).toBe(false)
    expect(alias.get('grafana-prod')).toBe('p-grafana-prod')
  })

  it('has no alias when no prefix is configured and none can be derived', () => {
    const alias = resolveConflictNames({
      entries: [{ name: 'grafana-dev', reserved: true }],
      prefix: '',
      projectRoot: '/',
    })
    expect(alias.size).toBe(0)
  })

  it('derives the prefix from the project root when config leaves it open', () => {
    const alias = resolveConflictNames({
      entries: [{ name: 'grafana-dev', reserved: true }],
      prefix: '',
      projectRoot: '/Users/dev/e/rd/dsh-project-mcp',
    })
    expect(alias.get('grafana-dev')).toBe('dsh-p-grafana-dev')
  })

  it('never hands out a name another declaration or the profile already owns', () => {
    const alias = resolveConflictNames({
      entries: [
        { name: 'grafana-dev', reserved: true },
        { name: 'p-grafana-dev', reserved: false },
      ],
      prefix: 'p',
    })
    expect(alias.get('grafana-dev')).toBe('p-grafana-dev-2')
  })

  it('is deterministic: the declaration order never moves an alias', () => {
    const input = {
      entries: [
        { name: 'gamma', reserved: true },
        { name: 'alpha', reserved: true },
      ],
      prefix: 'p',
    }
    const alias = resolveConflictNames(input)
    expect([...alias.keys()]).toEqual(['alpha', 'gamma'])
    expect(resolveConflictNames(input)).toEqual(alias)
  })
})

describe('MAX_LOCAL_PREFIX_LENGTH', () => {
  it('is the five characters the panel promises', () => {
    expect(MAX_LOCAL_PREFIX_LENGTH).toBe(5)
  })
})
