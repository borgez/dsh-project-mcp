/**
 * Filesystem discovery for `dsh-project-mcp`: project root, config documents,
 * and the two credential sources behind `${...}` references — the global
 * credentials file and the project's own dotenv documents.
 *
 * Which MCP documents are read is a setting, not a constant: the deployment
 * lists its **local** documents (relative to a project root) and its **global**
 * ones (relative to `$HOME`, or absolute) in `localFiles` / `globalFiles`, and
 * one spec resolves through {@link expandConfigPath} to an absolute path.
 *
 * @module dsh-project-mcp/discovery
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseCredentials, parseEnvFile } from './parse.ts'

/** Directory/marker names that terminate the upward project-root walk. */
export const DEFAULT_PROJECT_MARKERS = ['.git', '.dsh', '.kimi-code', 'package.json']

/** File-suffix markers that terminate the upward project-root walk. */
export const DEFAULT_FILE_MARKERS = ['.sln', '.slnx', '.csproj']

/**
 * Project-relative documents read out of the box, in increasing priority: the
 * native DSH file only. A deployment that also wants another agent's document
 * names it in `localFiles`.
 */
export const DEFAULT_LOCAL_FILES: readonly string[] = ['.dsh/mcp.json']

/**
 * Global documents read out of the box, in increasing priority: none. A global
 * document is read only when a deployment lists it in `globalFiles`, so a
 * project never inherits a server it did not ask for.
 */
export const DEFAULT_GLOBAL_FILES: readonly string[] = []

/** `$DSH_HOME`, falling back to `~/.dsh`. */
export function dshHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env.DSH_HOME
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/** Environment-variable references a path spec may carry. */
const HOME_REFERENCE = '~'
const DSH_HOME_REFERENCE = '$DSH_HOME'
const DSH_HOME_BRACED_REFERENCE = '${DSH_HOME}'

/**
 * Resolve one configured document spec to an absolute path.
 *
 * A spec is read the way a shell reads it, in this order:
 *
 * - `~/x` (and a bare `~`) → `$HOME/x`;
 * - `$DSH_HOME/x` or `${DSH_HOME}/x` → the deployment's own home;
 * - an absolute path → itself;
 * - anything else → `base/x`, so a local document stays inside the project and
 *   a global one stays inside `$HOME`.
 *
 * @param spec - one entry of `localFiles` or `globalFiles`.
 * @param base - directory a relative spec is read from.
 * @param env - environment used to resolve `$DSH_HOME`.
 * @returns the absolute document path.
 */
export function expandConfigPath(
  spec: string,
  base: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (spec === HOME_REFERENCE) return homedir()
  if (spec.startsWith(`${HOME_REFERENCE}/`)) return resolve(homedir(), spec.slice(2))
  if (spec === DSH_HOME_REFERENCE || spec === DSH_HOME_BRACED_REFERENCE) return dshHome(env)
  if (spec.startsWith(`${DSH_HOME_REFERENCE}/`)) {
    return resolve(dshHome(env), spec.slice(DSH_HOME_REFERENCE.length + 1))
  }
  if (spec.startsWith(`${DSH_HOME_BRACED_REFERENCE}/`)) {
    return resolve(dshHome(env), spec.slice(DSH_HOME_BRACED_REFERENCE.length + 1))
  }
  if (isAbsolute(spec)) return resolve(spec)
  return resolve(base, spec)
}

/**
 * Project documents to read for one project root, in increasing priority — a
 * later document overrides an earlier entry of the same `serverName`.
 * @param projectRoot - absolute project root.
 * @param files - configured project-relative specs, lowest priority first.
 * @param env - environment used to resolve `$DSH_HOME`.
 * @returns absolute paths, lowest priority first.
 */
export function localConfigPaths(
  projectRoot: string,
  files: readonly string[] = DEFAULT_LOCAL_FILES,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return files.map((spec) => expandConfigPath(spec, projectRoot, env))
}

/**
 * Global documents of one deployment, in increasing priority. They are read
 * before a project's own documents, so a project declaration always wins.
 * @param files - configured specs, lowest priority first.
 * @param env - environment used to resolve `$DSH_HOME`.
 * @returns absolute paths, lowest priority first.
 */
export function globalConfigPaths(
  files: readonly string[] = DEFAULT_GLOBAL_FILES,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const home = homedir()
  return files.map((spec) => expandConfigPath(spec, home, env))
}

/** Default credentials document consulted for `${input:NAME}` values. */
export function defaultCredentialsPath(env: Record<string, string | undefined> = process.env): string {
  return join(dshHome(env), '.credentials.yaml')
}

/** Project-relative dotenv documents read for `${...}` values, lowest priority first. */
export const PROJECT_ENV_RELATIVE = ['.env', '.dsh/.env'] as const

/**
 * Dotenv documents of one project, lowest priority first: the plain `.env` at
 * the project root, then the one in `.dsh` next to `mcp.json`. A value declared
 * in both is taken from the `.dsh` file — the project-local declaration wins.
 * @param projectRoot - absolute project root.
 * @returns absolute paths, lowest priority first.
 */
export function projectEnvPaths(projectRoot: string): string[] {
  return PROJECT_ENV_RELATIVE.map((relative) => join(projectRoot, relative))
}

/**
 * Walk upward from `cwd` to the first directory carrying a project marker.
 * @param cwd - absolute session working directory.
 * @param markers - directory/file marker names.
 * @param fileMarkers - file suffixes that also mark a project root.
 * @returns the absolute project root, or `undefined` when no marker is found.
 */
export function findProjectRoot(
  cwd: string,
  markers: readonly string[] = DEFAULT_PROJECT_MARKERS,
  fileMarkers: readonly string[] = DEFAULT_FILE_MARKERS,
): string | undefined {
  let current = resolve(cwd)
  for (;;) {
    if (isProjectRoot(current, markers, fileMarkers)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function isProjectRoot(
  dir: string,
  markers: readonly string[],
  fileMarkers: readonly string[],
): boolean {
  for (const marker of markers) {
    if (existsSync(join(dir, marker))) return true
  }
  if (fileMarkers.length === 0) return false
  try {
    for (const entry of readdirSync(dir)) {
      if (fileMarkers.some((suffix) => entry.endsWith(suffix))) return true
    }
  } catch {
    return false
  }
  return false
}

/** Read the credentials document into a flat string map; missing file yields `{}`. */
export function readSecrets(path: string): Record<string, string> {
  try {
    return parseCredentials(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/** Read one dotenv document into a flat string map; missing file yields `{}`. */
export function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Directories that hold this project's MCP documents. Used by the flat-watch
 * fallback when the runtime cannot watch a tree recursively.
 * @param projectRoot - absolute project root.
 * @param files - configured project-relative specs, lowest priority first.
 * @param env - environment used to resolve `$DSH_HOME`.
 * @returns existing directories, project root first, deduplicated.
 */
export function configDirectories(
  projectRoot: string,
  files: readonly string[] = DEFAULT_LOCAL_FILES,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const directories = [projectRoot]
  for (const path of localConfigPaths(projectRoot, files, env)) {
    const directory = dirname(path)
    if (!directories.includes(directory)) directories.push(directory)
  }
  return directories.filter((directory) => existsSync(directory))
}
