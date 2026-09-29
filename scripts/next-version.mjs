#!/usr/bin/env node
/**
 * The release decision for `dsh-project-mcp`, in one place.
 *
 * Every push to `main` is classified from its Conventional Commits
 * (`feat` → minor, `fix`/`perf`/`revert` → patch, `!` or `BREAKING CHANGE` →
 * major; everything else — `docs`, `chore`, `ci`, `test`, `refactor` — releases
 * nothing on its own), and the next version is bumped from the newest of the two
 * numbers that claim to be current: `package.json`'s `version` and the highest
 * `v*` tag. Both are read because they can drift — the `v0.2.1` tag once stood
 * over a `package.json` still saying `0.2.0`, and a release built from that
 * mismatch publishes the wrong version under the right tag.
 *
 * Two modes:
 *
 * ```
 * node scripts/next-version.mjs [--bump auto|patch|minor|major]   # decide
 *   [--github-output "$GITHUB_OUTPUT"]
 * node scripts/next-version.mjs --apply <version>                 # write it
 * ```
 *
 * Deciding prints a JSON result and writes `version` / `released` / `kind` to a
 * GitHub outputs file when one is given. Applying rewrites the single `version`
 * line of `package.json` and leaves every other byte alone, so the release commit
 * is exactly that: a version, nothing else.
 *
 * A prerelease base (`0.1.7-rc.2`) is bumped on its numeric triple, which clears
 * the suffix: `0.2.0-rc.1` + patch is `0.2.1`, never a second `0.2.0` that npm
 * would refuse.
 *
 * Run from the repository root. Exit code 0 always means the decision is
 * trustworthy: a missing repository or an unreadable `package.json` exits
 * non-zero rather than reporting "nothing to release".
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Conventional-commit types that release on their own, and the level each carries. */
const LEVELS = { feat: 'minor', fix: 'patch', perf: 'patch', revert: 'patch' }

/** Levels from the smallest to the largest, so a range takes its maximum. */
const ORDER = ['none', 'patch', 'minor', 'major']

/** The one line of `package.json` this script is allowed to touch. */
const VERSION_LINE = /^(\s*"version"\s*:\s*")([^"]*)(")/mu

/**
 * Parse `major.minor.patch` with an optional prerelease suffix.
 *
 * @param {string} text - a semver-shaped version.
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[] }} the parts.
 * @throws {Error} when the text is not `x.y.z[-suffix]`.
 */
export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(text.trim())
  if (!match) throw new Error(`not a version: ${JSON.stringify(text)}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/**
 * Compare two versions the way semver does, including the prerelease rules:
 * a prerelease sorts below the release it leads to (`0.2.0-rc.1 < 0.2.0`), and
 * numeric identifiers sort below alphanumeric ones.
 *
 * @param {string} a - left version.
 * @param {string} b - right version.
 * @returns {number} negative, zero or positive as `a` sorts before, with, or after `b`.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const one = left.prerelease[index]
    const other = right.prerelease[index]
    if (one === undefined) return -1
    if (other === undefined) return 1
    if (one === other) continue
    const oneNumeric = /^\d+$/u.test(one)
    const otherNumeric = /^\d+$/u.test(other)
    if (oneNumeric && otherNumeric) return Number(one) < Number(other) ? -1 : 1
    if (oneNumeric) return -1
    if (otherNumeric) return 1
    return one < other ? -1 : 1
  }
  return 0
}

/**
 * Bump the numeric triple of a version, dropping any prerelease suffix.
 *
 * @param {string} version - the base version.
 * @param {'patch'|'minor'|'major'} kind - which part to raise.
 * @returns {string} the next version.
 */
export function bumpVersion(version, kind) {
  const { major, minor, patch } = parseVersion(version)
  if (kind === 'major') return `${String(major + 1)}.0.0`
  if (kind === 'minor') return `${String(major)}.${String(minor + 1)}.0`
  return `${String(major)}.${String(minor)}.${String(patch + 1)}`
}

/**
 * Classify one commit.
 *
 * @param {string} subject - the commit's first line.
 * @param {string} body - the commit's body, scanned only for `BREAKING CHANGE`.
 * @returns {'none'|'patch'|'minor'|'major'} the level this commit carries.
 */
export function classifyCommit(subject, body = '') {
  const header = subject.trim()
  // A `release:` commit is the release itself and never a reason for another one.
  if (/^release:/u.test(header)) return 'none'
  const parsed = /^([a-z]+)(?:\([^)]*\))?(!)?:/u.exec(header)
  if (!parsed) return 'none'
  if (parsed[2] === '!') return 'major'
  if (/^BREAKING[ -]CHANGE:/mu.test(body)) return 'major'
  return LEVELS[parsed[1]] ?? 'none'
}

/**
 * Take the largest level a range of commits carries.
 *
 * @param {readonly { subject: string, body?: string }[]} commits - the range, newest first.
 * @returns {'none'|'patch'|'minor'|'major'} the range's level.
 */
export function classifyRange(commits) {
  let level = 'none'
  for (const commit of commits) {
    const one = classifyCommit(commit.subject, commit.body ?? '')
    if (ORDER.indexOf(one) > ORDER.indexOf(level)) level = one
  }
  return level
}

/**
 * Rewrite the `version` line of a `package.json` text, leaving the rest byte-identical.
 *
 * @param {string} text - the file's current contents.
 * @param {string} version - the version to write.
 * @returns {string} the new contents.
 * @throws {Error} when the file has no `version` line to rewrite.
 */
export function withVersion(text, version) {
  parseVersion(version)
  if (!VERSION_LINE.test(text)) throw new Error('package.json has no "version" line')
  return text.replace(VERSION_LINE, (_match, head, _old, tail) => `${head}${version}${tail}`)
}

/**
 * The next version for a base, and the reason for it.
 *
 * @param {object} input - the decision's inputs.
 * @param {string} input.packageVersion - the version `package.json` declares.
 * @param {string|null} input.tagVersion - the highest `v*` tag, or null without tags.
 * @param {'none'|'patch'|'minor'|'major'} input.kind - the level the range carries, or an override.
 * @returns {{ base: string, baseSource: 'tag'|'package.json'|'both', version: string|null, released: boolean, kind: string }}
 *   the decision; `version` is null when there is nothing to release.
 */
export function decide({ packageVersion, tagVersion, kind }) {
  const candidates = [packageVersion, ...(tagVersion === null ? [] : [tagVersion])]
  const base = candidates.reduce((one, other) => (compareVersions(other, one) > 0 ? other : one))
  let baseSource = 'package.json'
  if (tagVersion !== null && compareVersions(tagVersion, packageVersion) >= 0) {
    baseSource = tagVersion === packageVersion ? 'both' : 'tag'
  }
  if (kind === 'none') return { base, baseSource, version: null, released: false, kind }
  return { base, baseSource, version: bumpVersion(base, kind), released: true, kind }
}

/**
 * The highest `v<semver>` tag reachable from `HEAD`, or null when there is none.
 *
 * @param {string} cwd - the repository root.
 * @returns {string|null} the tag name handed to git (`v0.2.1`), not the version.
 */
function lastTag(cwd) {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * Every commit of a range, subject and body split on record separators.
 *
 * @param {string} cwd - the repository root.
 * @param {string} range - the git range (`v0.2.1..HEAD`, or `HEAD` without tags).
 * @returns {{ subject: string, body: string }[]} the commits, newest first.
 */
function readCommits(cwd, range) {
  const output = execFileSync('git', ['log', '--no-merges', '--format=%s%x1f%b%x1e', range], {
    cwd,
    encoding: 'utf8',
  })
  return output
    .split('\u001e')
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const [subject = '', body = ''] = record.split('\u001f')
      return { subject: subject.trim(), body: body.trim() }
    })
}

/** The CLI's usage line, printed on a bad invocation. */
const USAGE = 'usage: node scripts/next-version.mjs [--bump auto|patch|minor|major|none] [--github-output <file>] | --apply <version>'

/**
 * Read the flags this script understands.
 *
 * @param {string[]} argv - the arguments after the script name.
 * @returns {{ bump: string, githubOutput: string|null, apply: string|null }} the invocation.
 */
function parseArgs(argv) {
  const options = { bump: 'auto', githubOutput: null, apply: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--bump') {
      options.bump = argv[index + 1] ?? ''
      index += 1
    } else if (argument === '--github-output') {
      options.githubOutput = argv[index + 1] ?? ''
      index += 1
    } else if (argument === '--apply') {
      options.apply = argv[index + 1] ?? ''
      index += 1
    } else {
      throw new Error(`unknown argument ${JSON.stringify(argument)}\n${USAGE}`)
    }
  }
  if (!['auto', 'none', 'patch', 'minor', 'major'].includes(options.bump)) {
    throw new Error(`--bump takes auto, patch, minor or major, not ${JSON.stringify(options.bump)}\n${USAGE}`)
  }
  if (options.apply !== null) parseVersion(options.apply)
  return options
}

/**
 * The CLI: decide, or apply an already decided version.
 *
 * @param {string[]} argv - process arguments.
 * @returns {number} the process exit code.
 */
function main(argv) {
  const options = parseArgs(argv)
  const root = process.cwd()
  const manifestPath = resolve(root, 'package.json')

  if (options.apply !== null) {
    const text = readFileSync(manifestPath, 'utf8')
    writeFileSync(manifestPath, withVersion(text, options.apply))
    process.stdout.write(`${JSON.stringify({ applied: options.apply })}\n`)
    return 0
  }

  const packageVersion = JSON.parse(readFileSync(manifestPath, 'utf8')).version
  parseVersion(packageVersion)
  const tag = lastTag(root)
  const tagVersion = tag === null ? null : tag.replace(/^v/u, '')
  if (tagVersion !== null) parseVersion(tagVersion)
  const commits = readCommits(root, tag === null ? 'HEAD' : `${tag}..HEAD`)
  // An override is a deliberate human instruction, so it also releases a range
  // that classifies as nothing — that is what re-running a failed release needs.
  const classified = classifyRange(commits)
  const kind = options.bump === 'auto' ? classified : options.bump
  const decision = decide({ packageVersion, tagVersion, kind })
  const reasons = commits
    .map((commit) => ({ subject: commit.subject, level: classifyCommit(commit.subject, commit.body) }))
    .filter((commit) => commit.level !== 'none')

  const result = {
    current: packageVersion,
    tag,
    base: decision.base,
    baseSource: decision.baseSource,
    kind: decision.released ? decision.kind : 'none',
    classified,
    version: decision.version,
    released: decision.released,
    commits: commits.length,
    reasons: reasons.slice(0, 20),
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

  const outputs = options.githubOutput ?? process.env.GITHUB_OUTPUT ?? null
  if (outputs !== null) {
    appendFileSync(
      outputs,
      `version=${decision.version ?? ''}\nreleased=${String(decision.released)}\nkind=${result.kind}\n`,
    )
  }
  return 0
}

// Importable for the tests, runnable as a command. `import.meta.main` is Bun's;
// Node compares the resolved entry URL instead, so the suite and CI agree, and
// `pathToFileURL` keeps a workspace path with spaces intact.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`next-version: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
