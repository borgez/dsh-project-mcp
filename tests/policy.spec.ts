/**
 * Durable per-project tool policy: the pure mode/pin model and the debounced
 * atomic document under `$DSH_HOME`.
 *
 * The contract under test is a default, not a config file the user edits: an
 * absent document, an absent project and an absent field all mean `disclosure`
 * with no pins, a hand-edited document is sanitized field by field, and a pin
 * list keeps names the project no longer mounts. Every filesystem failure stays
 * off the panel-click path, exactly like the counters.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  POLICY_FILE_NAME,
  POLICY_VERSION,
  PolicyStore,
  TOOL_MODES,
  choiceFor,
  isConflictChoice,
  isToolMode,
  parsePolicyDocument,
  policyFor,
  withConflictChoice,
  withMode,
  withPin,
} from '../src/policy.ts'
import type { PolicyState } from '../src/policy.ts'
import { DEFAULT_TOOL_POLICY } from '../src/types.ts'

const created: string[] = []

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-mcp-policy-'))
  created.push(dir)
  return dir
}

function silentLogger(): { warn: (message: string) => void; warned: string[] } {
  const warned: string[] = []
  return { warned, warn: (message: string) => warned.push(message) }
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('policy model', () => {
  it('falls back to the shipped policy for a project with none', () => {
    expect(policyFor({}, '/repo')).toEqual(DEFAULT_TOOL_POLICY)
    expect(DEFAULT_TOOL_POLICY).toEqual({ mode: 'disclosure', pins: [], aliases: {} })
  })

  it('appends a pin, keeps the pin order, and removes exactly one name', () => {
    let state: PolicyState = {}
    state = withPin(state, '/repo', 'mcp__tglider__workspace', true)
    state = withPin(state, '/repo', 'mcp__memory__recall', true)
    expect(state['/repo']?.pins).toEqual(['mcp__tglider__workspace', 'mcp__memory__recall'])

    // Pinning again is not a second entry and does not move the name.
    expect(withPin(state, '/repo', 'mcp__tglider__workspace', true)).toBe(state)

    state = withPin(state, '/repo', 'mcp__tglider__workspace', false)
    expect(state['/repo']?.pins).toEqual(['mcp__memory__recall'])

    // A re-pin lands after the names still pinned, never at the original spot.
    state = withPin(state, '/repo', 'mcp__tglider__workspace', true)
    expect(state['/repo']?.pins).toEqual(['mcp__memory__recall', 'mcp__tglider__workspace'])

    // Unpinning what is not pinned leaves the state object untouched.
    expect(withPin(state, '/repo', 'mcp__other__gone', false)).toBe(state)
    // Another project keeps its own list.
    expect(withPin(state, '/elsewhere', 'mcp__x__y', true)['/repo']).toEqual(state['/repo'])
  })

  it('keeps a pin of a name the project does not mount', () => {
    let state: PolicyState = {}
    state = withPin(state, '/repo', 'mcp__gone__tool', true)
    expect(policyFor(state, '/repo').pins).toEqual(['mcp__gone__tool'])

    // The list is passed through on every read, so a declaration that comes back
    // later finds its pin still there.
    expect(policyFor(state, '/repo').pins).toEqual(['mcp__gone__tool'])
  })

  it('keeps the pins when the mode changes, and ignores a repeat mode', () => {
    const pinned = withPin({}, '/repo', 'mcp__tglider__workspace', true)
    const off = withMode(pinned, '/repo', 'off')
    // No choice was stored, so the entry carries none: an absent map is the
    // same answer as an empty one, and the document does not grow for it.
    expect(off['/repo']).toEqual({ mode: 'off', pins: ['mcp__tglider__workspace'] })

    // A switch that resubmits the mode in force must not schedule a write.
    expect(withMode(off, '/repo', 'off')).toBe(off)
    expect(withMode(off, '/repo', 'direct')['/repo']?.pins).toEqual(['mcp__tglider__workspace'])
  })

  it('knows exactly the three modes, and refuses anything else', () => {
    expect(TOOL_MODES).toEqual(['disclosure', 'direct', 'off'])
    for (const mode of TOOL_MODES) expect(isToolMode(mode)).toBe(true)
    for (const value of ['sometimes', '', 'DISCLOSURE', 7, undefined, null, {}]) {
      expect(isToolMode(value)).toBe(false)
    }
  })
})

describe('policy document', () => {
  it('stays in memory until flushed, then survives a round-trip atomically', () => {
    const dir = tmp()
    const file = join(dir, 'nested', 'policy.json')
    const store = new PolicyStore({ file, flushMs: 60_000 })
    store.setPin('/repo', 'mcp__tglider__workspace', true)
    store.setMode('/repo', 'direct')
    expect(existsSync(file)).toBe(false)

    store.flush()
    expect(existsSync(file)).toBe(true)
    // The write goes through a same-directory temporary file, so a reader never
    // sees a half-written document and no temporary is left behind.
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false)
    const document: unknown = JSON.parse(readFileSync(file, 'utf8'))
    expect(document).toEqual({
      version: POLICY_VERSION,
      projects: {
        '/repo': { mode: 'direct', pins: ['mcp__tglider__workspace'] },
      },
    })
    store.dispose()

    const reloaded = new PolicyStore({ file, flushMs: 60_000 })
    expect(reloaded.forProject('/repo')).toEqual({
      mode: 'direct',
      pins: ['mcp__tglider__workspace'],
    })
    expect(reloaded.forProject('/missing')).toEqual(DEFAULT_TOOL_POLICY)
    reloaded.dispose()
  })

  it('writes the shipped document name under the harness home by default', () => {
    expect(POLICY_FILE_NAME).toBe('dsh-project-mcp-policy.json')
  })

  it('starts from the default on a missing, unreadable or older-version document', () => {
    const missing = silentLogger()
    const absent = new PolicyStore({
      file: join(tmp(), 'absent.json'),
      logger: missing,
      flushMs: 60_000,
    })
    expect(absent.forProject('/repo')).toEqual(DEFAULT_TOOL_POLICY)
    expect(missing.warned).toEqual([])

    const corrupt = silentLogger()
    const corruptFile = join(tmp(), 'policy.json')
    writeFileSync(corruptFile, '{not json')
    const broken = new PolicyStore({ file: corruptFile, logger: corrupt, flushMs: 60_000 })
    expect(broken.forProject('/repo')).toEqual(DEFAULT_TOOL_POLICY)
    expect(corrupt.warned.some((message) => message.includes('starting from the default'))).toBe(true)

    const older = silentLogger()
    const olderFile = join(tmp(), 'policy.json')
    writeFileSync(
      olderFile,
      JSON.stringify({ version: 0, projects: { '/repo': { mode: 'off', pins: [] } } }),
    )
    const stale = new PolicyStore({ file: olderFile, logger: older, flushMs: 60_000 })
    expect(stale.forProject('/repo')).toEqual(DEFAULT_TOOL_POLICY)
    expect(older.warned).toHaveLength(1)
  })

  it('sanitizes a hand-edited document instead of rejecting it', () => {
    const file = join(tmp(), 'policy.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: POLICY_VERSION,
        projects: {
          // An unknown mode and a mixed pin list: both are repaired in place.
          '/repo': { mode: 'sometimes', pins: ['mcp__tglider__workspace', '', 7, 'mcp__memory__recall', 'mcp__tglider__workspace'] },
          // A project that says nothing the default would not say.
          '/empty': {},
          // A project entry that is not even a record.
          '/broken': 'off',
        },
      }),
    )
    const logger = silentLogger()
    const store = new PolicyStore({ file, logger, flushMs: 60_000 })

    expect(store.forProject('/repo')).toEqual({
      mode: 'disclosure',
      pins: ['mcp__tglider__workspace', 'mcp__memory__recall'],
    })
    expect(store.forProject('/empty')).toEqual(DEFAULT_TOOL_POLICY)
    expect(store.forProject('/broken')).toEqual(DEFAULT_TOOL_POLICY)
    expect(logger.warned).toEqual([])
  })

  it('drops a project entry that carries nothing, without touching the others', () => {
    const parsed = parsePolicyDocument(
      JSON.stringify({
        version: POLICY_VERSION,
        projects: { '/kept': { pins: ['mcp__a__b'] }, '/dropped': { mode: 'disclosure', pins: [] } },
      }),
    )
    expect(parsed).toEqual({ '/kept': { mode: 'disclosure', pins: ['mcp__a__b'] } })
    expect(parsePolicyDocument('{')).toBeUndefined()
    expect(parsePolicyDocument('[]')).toBeUndefined()
    expect(parsePolicyDocument(JSON.stringify({ version: 99 }))).toBeUndefined()
  })

  it('never throws when the document cannot be written', () => {
    const dir = tmp()
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const logger = silentLogger()
    const store = new PolicyStore({ file: join(blocker, 'policy.json'), logger, flushMs: 60_000 })

    store.setMode('/repo', 'off')
    expect(() => store.flush()).not.toThrow()
    expect(logger.warned.some((message) => message.includes('writing the tool policy'))).toBe(true)
    // A failed write is not fatal for later writes or for disposal either.
    expect(() => store.dispose()).not.toThrow()
  })

  it('stops storing and writing once disposed', () => {
    const file = join(tmp(), 'policy.json')
    const store = new PolicyStore({ file, flushMs: 60_000 })
    store.dispose()
    expect(store.setPin('/repo', 'mcp__a__b', true)).toEqual(DEFAULT_TOOL_POLICY)
    expect(() => store.dispose()).not.toThrow()
    expect(existsSync(file)).toBe(false)
  })
})

describe('conflict choice', () => {
  it('accepts the three answers this build knows, and no other', () => {
    expect(isConflictChoice('profile')).toBe(true)
    expect(isConflictChoice('local')).toBe(true)
    expect(isConflictChoice('native')).toBe(true)
    expect(isConflictChoice('both')).toBe(false)
    expect(isConflictChoice('')).toBe(false)
    expect(isConflictChoice(undefined)).toBe(false)
    expect(isConflictChoice(2)).toBe(false)
  })

  it('falls back to the profile for a name nobody chose about', () => {
    expect(choiceFor({}, '/repo', 'grafana-dev')).toBe('profile')
    expect(choiceFor({ '/repo': { mode: 'direct', pins: [], aliases: {} } }, '/repo', 'a')).toBe(
      'profile',
    )
  })

  it('stores one name without touching the mode, the pins or its neighbours', () => {
    const before: PolicyState = {
      '/repo': { mode: 'off', pins: ['mcp__a__b'], aliases: { gitea: 'local' } },
    }
    const after = withConflictChoice(before, '/repo', 'grafana-dev', 'local')
    expect(after['/repo']).toEqual({
      mode: 'off',
      pins: ['mcp__a__b'],
      aliases: { gitea: 'local', 'grafana-dev': 'local' },
    })
    // Idempotent: the same answer does not schedule a write.
    expect(withConflictChoice(after, '/repo', 'grafana-dev', 'local')).toBe(after)
    expect(before['/repo']?.aliases).toEqual({ gitea: 'local' })
  })

  it('drops the answer when the profile is chosen again, so the default shows through', () => {
    const before: PolicyState = {
      '/repo': { mode: 'disclosure', pins: [], aliases: { 'grafana-dev': 'local' } },
    }
    const after = withConflictChoice(before, '/repo', 'grafana-dev', 'profile')
    // The last choice goes with it: an entry that kept an empty map would claim
    // a decision the user took back.
    expect(after['/repo']).toEqual({ mode: 'disclosure', pins: [] })
  })

  it('keeps the third answer apart from the local one, on disk and back', () => {
    const file = join(tmp(), 'policy.json')
    const store = new PolicyStore({ file, flushMs: 60_000 })
    expect(store.setConflictChoice('/repo', 'grafana-dev', 'native')).toEqual({
      mode: 'disclosure',
      pins: [],
      aliases: { 'grafana-dev': 'native' },
    })
    // The two answers about this project's own copy are each other's successor,
    // not each other's addition: one name, one answer.
    expect(store.setConflictChoice('/repo', 'grafana-dev', 'local')).toMatchObject({
      aliases: { 'grafana-dev': 'local' },
    })
    expect(store.setConflictChoice('/repo', 'grafana-dev', 'native')).toMatchObject({
      aliases: { 'grafana-dev': 'native' },
    })
    store.dispose()

    const reloaded = new PolicyStore({ file, flushMs: 60_000 })
    // Read back as itself: not narrowed to the profile, not confused with the
    // local name it replaced.
    expect(choiceFor({ '/repo': reloaded.forProject('/repo') }, '/repo', 'grafana-dev')).toBe('native')
    reloaded.dispose()
  })

  it('sanitizes a hand-edited document field by field', () => {
    const parsed = parsePolicyDocument(
      JSON.stringify({
        version: POLICY_VERSION,
        projects: {
          '/repo': {
            aliases: {
              good: 'local',
              bad: 'sometimes',
              alsoGood: 'profile',
              alsoNative: 'native',
              7: 'local',
            },
          },
        },
      }),
    )
    // The profile is still what an absent entry means, so storing it stays
    // dropped; the third answer is kept like the local one.
    expect(parsed).toEqual({
      '/repo': {
        mode: 'disclosure',
        pins: [],
        aliases: { good: 'local', alsoNative: 'native' },
      },
    })
  })

  it('writes the choice durably and reads it back', () => {
    const file = join(tmp(), 'policy.json')
    const store = new PolicyStore({ file, flushMs: 60_000 })
    expect(store.setConflictChoice('/repo', 'grafana-dev', 'local')).toEqual({
      mode: 'disclosure',
      pins: [],
      aliases: { 'grafana-dev': 'local' },
    })
    store.dispose()

    const reloaded = new PolicyStore({ file, flushMs: 60_000 })
    expect(choiceFor({ '/repo': reloaded.forProject('/repo') }, '/repo', 'grafana-dev')).toBe('local')
    reloaded.dispose()
  })

  it('publishes an empty answer rather than dropping what the user chose when a write fails', () => {
    const dir = tmp()
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const store = new PolicyStore({ file: join(blocker, 'policy.json'), flushMs: 60_000 })
    expect(() => store.setConflictChoice('/repo', 'grafana-dev', 'local')).not.toThrow()
    expect(store.dispose()).toBeUndefined()
  })
})
