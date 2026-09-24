/**
 * The local namespace of a project-declared MCP server.
 *
 * A profile-level `mcp-client` instance and a project document can declare the
 * same `serverName`. `dsh-mcp-client` reserves that name per scope, so only one
 * of them can mount — which is a lost server, not a bad declaration. This module
 * is the pure rule that gives the project's entry a second, local name instead
 * (`grafana-dev` → `p-grafana-dev`), so both toolsets stay in the model's hands
 * under names nobody has to guess at.
 *
 * The rule is a total function of the declared name, the prefix and the names
 * already taken, and it is the *only* place the alias is computed: the pass that
 * mounts the server, the row that reports it and the tool prefix the model sees
 * all read this answer, so they cannot drift apart.
 *
 * @module dsh-project-mcp/naming
 */

/** The five characters a local prefix may carry, config or derived. */
export const MAX_LOCAL_PREFIX_LENGTH = 5

/** The `serverName` cap `@deepseek-ai/dsh-mcp-client` enforces. */
const MAX_SERVER_NAME_LENGTH = 32

/** A local prefix is a valid `serverName` head or it is nothing. */
const PREFIX_SHAPE = /^[A-Za-z0-9_-]+$/

/**
 * Whether a value may serve as a local prefix.
 *
 * The routes and the loader schema both read an untrusted string, so the shape
 * is checked here rather than trusted: a prefix that carries a character
 * `serverName` does not allow would produce a server the registry rejects, and
 * an empty prefix is a request for the derived one, not an error.
 *
 * @param value - candidate prefix.
 * @returns `true` when it is empty or a valid prefix of at most five characters.
 */
export function isValidLocalPrefix(value: string): boolean {
  if (value === '') return true
  return value.length <= MAX_LOCAL_PREFIX_LENGTH && PREFIX_SHAPE.test(value)
}

/**
 * The prefix a project brings by itself: its own folder name.
 *
 * Used when the config names no prefix, so a conflict has an answer without a
 * setting. A folder that yields nothing usable — `/`, dots, digits only — has no
 * answer, and such a project keeps today's behaviour rather than a made-up name.
 *
 * @param projectRoot - absolute project root.
 * @returns up to five characters, or `undefined` when the folder yields none.
 */
export function deriveLocalPrefix(projectRoot: string): string | undefined {
  const folder = projectRoot.split(/[\\/]/).filter((part) => part !== '').pop()
  if (folder === undefined) return undefined
  const cleaned = folder
    .toLowerCase()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    // A `serverName` may not open with a digit, and neither may the prefix: a
    // folder `2fast-service` contributes `fast`, not `2fast`.
    .replace(/^[0-9]+-*/, '')
    .slice(0, MAX_LOCAL_PREFIX_LENGTH)
    // Trimmed after the cap as well, so a cut at a separator (`2fast-service`
    // capped to five) never leaves the trailing dash the cap exposed.
    .replace(/^-+|-+$/g, '')
  return cleaned || undefined
}

/**
 * The local name of one declaration: the prefix, then the declared name,
 * trimmed so the result fits the `serverName` cap.
 *
 * The declared name is what gets trimmed, never the prefix, because a truncated
 * prefix would collide across servers the user meant to tell apart.
 *
 * @param name - declared `serverName`.
 * @param prefix - local prefix, already known to be valid.
 * @returns a `serverName` of at most 32 characters.
 */
export function aliasOf(name: string, prefix: string): string {
  const head = `${prefix}-`
  return `${head}${name.slice(0, Math.max(1, MAX_SERVER_NAME_LENGTH - head.length))}`
}

/** One declaration considered for a local name. */
export interface ConflictNameInput {
  /** Declared `serverName`. */
  readonly name: string
  /** `true` when a live profile-level instance already owns that name. */
  readonly reserved: boolean
}

/** What {@link resolveConflictNames} is asked to name. */
export interface ResolveNamesInput {
  /** Every declaration of the project, in document order. */
  readonly entries: readonly ConflictNameInput[]
  /** Explicit local prefix; empty asks for the one derived from the project. */
  readonly prefix: string
  /** Project root, read only when `prefix` is empty. */
  readonly projectRoot?: string
}

/**
 * The local name of every declaration a profile-level instance shadows.
 *
 * Aliases are handed out in name order so the answer never depends on which
 * document was read first, and a candidate that is already owned — by another
 * declaration of this project, by the profile, or by an alias handed out a
 * moment ago — gets a numeric tail (`p-grafana-dev-2`) rather than stealing the
 * name. Names that conflict with nothing are absent from the map: the absence is
 * the honest answer "this one mounts under the name it declared".
 *
 * @param input - declarations, prefix and project root.
 * @returns declared name → local name, in name order; empty when nothing is shadowed.
 */
export function resolveConflictNames(input: ResolveNamesInput): Map<string, string> {
  const prefix = input.prefix !== '' ? input.prefix : deriveLocalPrefix(input.projectRoot ?? '')
  const aliases = new Map<string, string>()
  if (prefix === undefined || !isValidLocalPrefix(prefix) || prefix === '') return aliases
  const taken = new Set(input.entries.map((entry) => entry.name))
  const shadowed = input.entries.filter((entry) => entry.reserved).map((entry) => entry.name)
  // Sorted, so the numeric tail always lands on the same declaration.
  shadowed.sort()
  for (const name of shadowed) {
    let candidate = aliasOf(name, prefix)
    for (let tail = 2; taken.has(candidate); tail += 1) {
      candidate = aliasOf(`${name}-${tail}`, prefix)
    }
    taken.add(candidate)
    aliases.set(name, candidate)
  }
  return aliases
}
