/**
 * The release decision (`scripts/next-version.mjs`) driven through its command
 * line, in throwaway git repositories.
 *
 * The decision is about a *range*, not about a function: which commits sit
 * after the last tag, which of the two numbers claiming to be current is newer,
 * and what that makes the next version. A unit test over the classifier would
 * miss exactly the failure this script exists for — the `v0.2.1` tag over a
 * `package.json` that still said `0.2.0` — so every case below builds a real
 * repository, commits real messages, tags it, and reads the JSON the workflow
 * reads.
 *
 * No network and no npm: only git, the script, and the temp directory each case
 * owns.
 *
 * @module tests/next-version
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(here, '..', 'scripts', 'next-version.mjs')

/** The decision's own shape, as the workflow reads it. */
interface Decision {
  current: string
  tag: string | null
  base: string
  baseSource: string
  kind: string
  classified: string
  version: string | null
  released: boolean
  commits: number
}

const roots: string[] = []

/**
 * A throwaway repository with a `package.json` and one scaffolding commit.
 *
 * @param packageVersion - the version the manifest declares.
 * @param tagVersion - a `v*` tag to place on the scaffolding commit, or null.
 * @returns the repository root.
 */
function repo(packageVersion: string, tagVersion: string | null = null): string {
  const root = mkdtempSync(join(tmpdir(), 'project-mcp-release-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'fixture', version: packageVersion }, null, 2)}\n`)
  writeFileSync(join(root, 'file.txt'), 'scaffold\n')
  git(root, 'add', '-A')
  commit(root, 'chore: scaffold the fixture')
  if (tagVersion !== null) git(root, 'tag', `v${tagVersion}`)
  return root
}

/**
 * Run one git command in a repository, with its identity and signing pinned so
 * a developer's global config cannot change the outcome.
 *
 * @param root - the repository.
 * @param args - the git arguments.
 * @returns the command's stdout.
 */
function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=release@example.test', '-c', 'user.name=Release Test', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
}

/**
 * Append a commit carrying one message.
 *
 * @param root - the repository.
 * @param subject - the commit's first line.
 * @param body - an optional body, the second paragraph.
 */
function commit(root: string, subject: string, body?: string): void {
  writeFileSync(join(root, 'file.txt'), `${subject}\n`, { flag: 'a' })
  git(root, 'add', '-A')
  git(root, 'commit', '-m', subject, ...(body === undefined ? [] : ['-m', body]))
}

/**
 * Run the script the way CI runs it.
 *
 * @param root - the repository to decide in.
 * @param args - the script's arguments.
 * @returns the exit status and both streams.
 */
function run(root: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Run the script and parse the decision it printed.
 *
 * @param root - the repository to decide in.
 * @param args - the script's arguments.
 * @returns the parsed decision.
 */
function decide(root: string, ...args: string[]): Decision {
  return JSON.parse(run(root, ...args).stdout) as Decision
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('next-version: the range decides', () => {
  it('releases a minor for a feat after the last tag', () => {
    const root = repo('0.2.1', '0.2.1')
    commit(root, 'feat(client): a failed server carries the Retry')
    const json = decide(root)
    expect(json.kind).toBe('minor')
    expect(json.classified).toBe('minor')
    expect(json.base).toBe('0.2.1')
    expect(json.baseSource).toBe('both')
    expect(json.version).toBe('0.3.0')
    expect(json.released).toBe(true)
  })

  it('releases a patch for a fix and for a performance change', () => {
    const root = repo('0.2.1', '0.2.1')
    commit(root, 'fix(ci): use supported Node runtimes')
    expect(decide(root).version).toBe('0.2.2')
    commit(root, 'perf(runtime): cache the resolved project root')
    expect(decide(root).version).toBe('0.2.2')
  })

  it('releases nothing when only docs, chore, ci and refactor commits landed', () => {
    const root = repo('0.2.1', '0.2.1')
    commit(root, 'docs(agents): note the mounted tglider server')
    commit(root, 'chore(deps): track the harness packages')
    commit(root, 'ci: switch CI and publish to pnpm')
    commit(root, 'refactor(runtime): split the mount pass')
    const json = decide(root)
    expect(json.released).toBe(false)
    expect(json.version).toBeNull()
    expect(json.kind).toBe('none')
    expect(json.commits).toBe(4)
  })

  it('takes a major from the breaking marker in the header', () => {
    const root = repo('0.2.1', '0.2.1')
    commit(root, 'feat(policy)!: drop the legacy pin list')
    expect(decide(root).version).toBe('1.0.0')
  })

  it('takes a major from a BREAKING CHANGE paragraph', () => {
    const root = repo('0.2.1', '0.2.1')
    commit(root, 'fix(bridge): resolve the scope by key', 'BREAKING CHANGE: the key names the project, not the session')
    expect(decide(root).version).toBe('1.0.0')
  })

  it('releases nothing for a release commit — the release is not its own reason', () => {
    const root = repo('0.2.1', '0.2.1')
    commit(root, 'release: dsh-project-mcp 0.2.2')
    const json = decide(root)
    expect(json.released).toBe(false)
    expect(json.version).toBeNull()
  })
})

describe('next-version: the base', () => {
  it('trusts the tag over a lagging package.json — the v0.2.1 / 0.2.0 drift', () => {
    const root = repo('0.2.0', '0.2.1')
    commit(root, 'fix(ci): use supported Node runtimes')
    const json = decide(root)
    expect(json.base).toBe('0.2.1')
    expect(json.baseSource).toBe('tag')
    expect(json.version).toBe('0.2.2')
  })

  it('trusts package.json over a lagging tag', () => {
    const root = repo('0.2.2', '0.2.1')
    commit(root, 'fix(ci): use supported Node runtimes')
    const json = decide(root)
    expect(json.base).toBe('0.2.2')
    expect(json.baseSource).toBe('package.json')
    expect(json.version).toBe('0.2.3')
  })

  it('reads the whole history when there is no tag yet', () => {
    const root = repo('0.1.0')
    commit(root, 'feat(entry): the first surface')
    const json = decide(root)
    expect(json.tag).toBeNull()
    expect(json.base).toBe('0.1.0')
    expect(json.version).toBe('0.2.0')
  })

  it('clears a prerelease suffix rather than republishing the same number', () => {
    const root = repo('0.2.0-rc.1', '0.2.0-rc.1')
    commit(root, 'fix(bridge): keep the child scope parented')
    const json = decide(root)
    expect(json.base).toBe('0.2.0-rc.1')
    expect(json.version).toBe('0.2.1')
  })

  it('forces a level with --bump even when the range carries none', () => {
    const root = repo('0.2.1', '0.2.1')
    commit(root, 'docs(readme): describe the release flow')
    expect(decide(root).released).toBe(false)
    const forced = decide(root, '--bump', 'minor')
    expect(forced.version).toBe('0.3.0')
    expect(forced.classified).toBe('none')
    expect(forced.kind).toBe('minor')
  })
})

describe('next-version: what the workflow reads', () => {
  it('writes version, released and kind to the GitHub outputs file', () => {
    const root = repo('0.2.1', '0.2.1')
    commit(root, 'fix(ci): use supported Node runtimes')
    const outputs = join(root, 'github-output.txt')
    writeFileSync(outputs, '')
    const json = decide(root, '--github-output', outputs)
    expect(json.version).toBe('0.2.2')
    expect(readFileSync(outputs, 'utf8')).toBe('version=0.2.2\nreleased=true\nkind=patch\n')
  })

  it('writes an empty version and released=false when nothing is releasable', () => {
    const root = repo('0.2.1', '0.2.1')
    commit(root, 'docs(readme): describe the release flow')
    const outputs = join(root, 'github-output.txt')
    writeFileSync(outputs, '')
    decide(root, '--github-output', outputs)
    expect(readFileSync(outputs, 'utf8')).toBe('version=\nreleased=false\nkind=none\n')
  })
})

describe('next-version: --apply', () => {
  it('rewrites the version line and leaves every other byte alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-mcp-release-'))
    roots.push(root)
    const manifest = `{\n  "name": "fixture",\n  "version": "0.2.1",\n  "description": "a version: inside a string stays put",\n  "type": "module"\n}\n`
    writeFileSync(join(root, 'package.json'), manifest)
    const { status, stdout } = run(root, '--apply', '0.3.0')
    expect(status).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ applied: '0.3.0' })
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(
      `{\n  "name": "fixture",\n  "version": "0.3.0",\n  "description": "a version: inside a string stays put",\n  "type": "module"\n}\n`,
    )
  })

  it('refuses a version that is not x.y.z', () => {
    const root = repo('0.2.1', '0.2.1')
    const { status, stderr } = run(root, '--apply', 'next')
    expect(status).toBe(2)
    expect(stderr).toContain('not a version')
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('"version": "0.2.1"')
  })
})

describe('next-version: refusing to guess', () => {
  it('exits non-zero on an unknown argument', () => {
    const root = repo('0.2.1', '0.2.1')
    const { status, stderr } = run(root, '--bump')
    expect(status).toBe(2)
    expect(stderr).toContain('usage: node scripts/next-version.mjs')
  })

  it('exits non-zero without a package.json rather than reporting "nothing to release"', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-mcp-release-'))
    roots.push(root)
    const { status, stderr } = run(root)
    expect(status).toBe(2)
    expect(stderr).toContain('next-version:')
  })
})
