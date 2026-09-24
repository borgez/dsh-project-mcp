/**
 * Make the boot scripts leave no `dsh` behind.
 *
 * The failure this exists for: `scripts/e2e-boot.mjs`, `scripts/design-parity.mjs`
 * and the two capture scripts each start a real `dsh` for a profile and stop it
 * in a `finally`. A *normal* exit therefore cleans up, but an interrupted run —
 * Ctrl-C, a killed background job, a harness that drops the parent — never
 * reaches that `finally`, and the child was spawned `detached: true` precisely so
 * it could be killed as a group. It survives as an orphan (reparented to pid 1)
 * and keeps holding the session store **shared by every profile under
 * `$DSH_HOME`**. The next `dsh` to open one of those sessions answers
 * `session/writer-held`, which the client shows as "This session is already in
 * use, possibly by another running DSH instance".
 *
 * Two halves fix it: {@link armChildReaper} kills the server when *this* process
 * is signalled or dies, and {@link reapOrphanedServers} sweeps servers left by
 * earlier interrupted runs before a new one starts.
 *
 * The sweep matches on the launcher flags a boot script uses and on the server
 * having **no parent of its own** (`ppid === 1`), so a concurrently running run —
 * whose server still has a live parent — is never touched, and neither is the
 * `dsh web` a person started.
 */

import { spawnSync } from 'node:child_process'

/**
 * The launcher flags every boot script starts its server with.
 *
 * Kept in one place because the sweep has to recognize exactly these and nothing
 * else: `dsh web` (a person's own instance) carries neither `--profile` nor
 * `--no-open`. The port is deliberately left open — one capture script boots on a
 * fixed `--port`, and an orphan of this profile is a leftover whatever port it
 * took.
 * @param profile - the profile a run boots.
 * @returns the argument prefix shared by all four scripts.
 */
export function serverFlags(profile) {
  return `--profile ${profile} --no-open --port`
}

/**
 * The servers in one `ps` listing that an interrupted run left behind.
 *
 * Pure so the rule can be read and exercised without starting anything: a line
 * qualifies when it names the `dsh` launcher, carries this profile's boot flags,
 * and has `ppid === 1`. An orphan is the only shape that is unambiguously ours —
 * a live sibling run's server still has its parent.
 * @param psOutput - the output of `ps -Ao pid=,ppid=,command=`.
 * @param profile - the profile a run boots.
 * @returns the orphaned servers, in listing order.
 */
export function orphanedServers(psOutput, profile) {
  const flags = `${serverFlags(profile)} `
  const found = []
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    const command = match[3]
    if (ppid !== 1) continue
    if (!/(?:^|\/|\s)dsh(?:\s|$)/u.test(command)) continue
    if (!command.includes(flags)) continue
    found.push({ pid, command })
  }
  return found
}

/**
 * Kill every `dsh` an earlier interrupted run left for this profile.
 *
 * Called at startup, so a stale server cannot hold a session against the run
 * about to begin, and again after the run, so this one cannot leave anything for
 * the next.
 * @param profile - the profile a run boots.
 * @param log - where to report a non-empty sweep; skipped when nothing is found.
 * @returns how many servers were reaped.
 */
export function reapOrphanedServers(profile, log = console.log) {
  const listed = spawnSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' })
  const found = orphanedServers(listed.stdout ?? '', profile)
  for (const server of found) killGroup(server.pid)
  if (found.length > 0) {
    log(`  reaped ${String(found.length)} orphaned dsh server(s) of profile ${profile}`)
  }
  return found.length
}

/**
 * Tie a booted server's life to this process.
 *
 * `exit` covers a throw and a plain `process.exit()`, the three signals cover a
 * person pressing Ctrl-C and a supervisor asking politely, and
 * `uncaughtException` covers a crash that would otherwise skip the script's own
 * `finally`. Every path is synchronous: nothing may be awaited while dying.
 * @param child - the `dsh` process, spawned `detached` so it leads its own group.
 */
export function armChildReaper(child) {
  if (child?.pid === undefined) return
  const reap = () => {
    if (child.exitCode !== null) return
    killGroup(child.pid)
  }
  process.on('exit', reap)
  const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
  for (const [signal, code] of Object.entries(signals)) {
    process.on(signal, () => {
      reap()
      process.exit(code)
    })
  }
  process.on('uncaughtException', (error) => {
    reap()
    console.error(error)
    process.exit(1)
  })
}

/**
 * Kill one server and its group, falling back to the process itself.
 *
 * The group matters: a `dsh` server starts MCP children, and killing only the
 * launcher would leave those running with the pipes they inherited.
 * @param pid - the server's pid, which is also its process-group id.
 */
function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone, or not ours to kill — either way there is nothing to do.
    }
  }
}
