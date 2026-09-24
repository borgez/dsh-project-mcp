import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configDirectories,
  expandConfigPath,
  findProjectRoot,
  globalConfigPaths,
  localConfigPaths,
  projectEnvPaths,
  readEnvFile,
  readSecrets,
} from '../src/discovery.ts'
import { DEFAULT_GLOBAL_FILES, DEFAULT_LOCAL_FILES } from '../src/discovery.ts'

const created: string[] = []

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-mcp-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('findProjectRoot', () => {
  it('walks up to the nearest marker directory', () => {
    const root = tmp()
    mkdirSync(join(root, '.dsh'))
    mkdirSync(join(root, 'src', 'deep', 'nested'), { recursive: true })
    expect(findProjectRoot(join(root, 'src', 'deep', 'nested'))).toBe(root)
  })

  it('treats a solution file as a project marker', () => {
    const root = tmp()
    writeFileSync(join(root, 'App.sln'), '')
    mkdirSync(join(root, 'src'), { recursive: true })
    expect(findProjectRoot(join(root, 'src'))).toBe(root)
  })

  it('returns undefined when nothing marks the path as a project', () => {
    const root = tmp()
    const orphan = join(root, 'just', 'a', 'folder')
    mkdirSync(orphan, { recursive: true })
    expect(findProjectRoot(orphan, ['.definitely-missing-marker'], ['.never'])).toBeUndefined()
  })
})

describe('config paths', () => {
  it('reads the DSH document out of the box and no global one', () => {
    expect(DEFAULT_LOCAL_FILES).toEqual(['.dsh/mcp.json'])
    expect(DEFAULT_GLOBAL_FILES).toEqual([])
    expect(localConfigPaths('/proj')).toEqual(['/proj/.dsh/mcp.json'])
    expect(globalConfigPaths()).toEqual([])
  })

  it('lists the configured project documents in increasing priority', () => {
    expect(localConfigPaths('/proj', ['.dsh/mcp.json', '.kimi-code/mcp.json'])).toEqual([
      '/proj/.dsh/mcp.json',
      '/proj/.kimi-code/mcp.json',
    ])
    expect(localConfigPaths('/proj', [])).toEqual([])
  })

  it('reads a relative global spec from the home directory', () => {
    expect(globalConfigPaths(['.dsh/mcp.json'])[0]).toBe(join(homedir(), '.dsh/mcp.json'))
  })
})

describe('expandConfigPath', () => {
  it('reads `~`, `$DSH_HOME` and an absolute spec as written', () => {
    expect(expandConfigPath('~', '/base')).toBe(homedir())
    expect(expandConfigPath('~/.config/mcp.json', '/base')).toBe(join(homedir(), '.config/mcp.json'))
    expect(expandConfigPath('$DSH_HOME/mcp.json', '/base', { DSH_HOME: '/custom/dsh' })).toBe(
      '/custom/dsh/mcp.json',
    )
    expect(expandConfigPath('${DSH_HOME}/mcp.json', '/base', { DSH_HOME: '/custom/dsh' })).toBe(
      '/custom/dsh/mcp.json',
    )
    expect(expandConfigPath('/etc/mcp.json', '/base')).toBe('/etc/mcp.json')
  })

  it('reads anything else from the base it was given', () => {
    expect(expandConfigPath('.dsh/mcp.json', '/proj')).toBe('/proj/.dsh/mcp.json')
    expect(expandConfigPath('nested/servers.json', '/proj')).toBe('/proj/nested/servers.json')
  })
})

describe('readSecrets', () => {
  it('returns an empty map for a missing file and values for an existing one', () => {
    expect(readSecrets('/definitely/missing/.credentials.yaml')).toEqual({})
    const root = tmp()
    const file = join(root, 'creds.yaml')
    writeFileSync(file, 'ALPHA: one\nBETA: two\n')
    expect(readSecrets(file)).toEqual({ ALPHA: 'one', BETA: 'two' })
  })
})

describe('projectEnvPaths', () => {
  it('lists the project .env and the .dsh one, lowest priority first', () => {
    expect(projectEnvPaths('/proj')).toEqual(['/proj/.env', '/proj/.dsh/.env'])
  })

  it('finds no document in a project that declares none', () => {
    const root = tmp()
    expect(projectEnvPaths(root).filter((path) => existsSync(path))).toEqual([])
  })
})

describe('readEnvFile', () => {
  it('returns an empty map for a missing file and values for an existing one', () => {
    expect(readEnvFile('/definitely/missing/.env')).toEqual({})
    const root = tmp()
    const file = join(root, '.env')
    writeFileSync(file, 'GITEA_TOKEN=abc123\n# comment\nQUOTED="two words"\n')
    expect(readEnvFile(file)).toEqual({ GITEA_TOKEN: 'abc123', QUOTED: 'two words' })
  })

  it('reads a project whose .dsh file overrides the root one', () => {
    const root = tmp()
    mkdirSync(join(root, '.dsh'))
    writeFileSync(join(root, '.env'), 'SHARED=root\nONLY_ROOT=root\n')
    writeFileSync(join(root, '.dsh', '.env'), 'SHARED=dsh\n')
    const merged: Record<string, string> = {}
    for (const path of projectEnvPaths(root)) Object.assign(merged, readEnvFile(path))
    expect(merged).toEqual({ SHARED: 'dsh', ONLY_ROOT: 'root' })
  })
})

describe('configDirectories', () => {
  it('lists the existing document directories of a project', () => {
    const root = tmp()
    mkdirSync(join(root, '.dsh'))
    mkdirSync(join(root, '.config', 'mcp'), { recursive: true })
    expect(configDirectories(root, ['.dsh/mcp.json'])).toEqual([root, join(root, '.dsh')])
    expect(configDirectories(root, ['.dsh/mcp.json', '.config/mcp/servers.json'])).toEqual([
      root,
      join(root, '.dsh'),
      join(root, '.config', 'mcp'),
    ])
    // A spec whose directory does not exist is not watched.
    expect(configDirectories(root, ['.missing/mcp.json'])).toEqual([root])
  })
})
