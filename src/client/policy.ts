/**
 * The per-project tool policy, as the browser half reads and writes it.
 *
 * The host owns the policy: it stores it next to the usage counters, applies it
 * on every request assembly, and answers with the fresh snapshot. This module
 * only shapes what the panel asks for and turns what came back into the two
 * readings the surfaces print — the mode in force and the list the user pinned.
 * Keeping the shapes here (instead of in a component) is what lets a no-DOM test
 * assert the exact body a `Pin` click posts.
 *
 * Nothing here invents a value: a project the host has no policy for follows
 * {@link DEFAULT_TOOL_POLICY}, which is the frozen contract's own default.
 *
 * @module dsh-project-mcp/client/policy
 */

import { ROUTE_ACTIONS, ROUTE_PREFIX } from '../shared.ts'
import type { ConflictRequest, OperatorRequest, PinRequest, PolicyRequest } from '../shared.ts'
import { DEFAULT_TOOL_POLICY } from '../types.ts'
import type { ConflictChoice, ProjectSnapshot, ToolMode, ToolPolicy } from '../types.ts'

/**
 * The project's effective policy.
 *
 * `policy` is absent only from a snapshot a host older than the policy store
 * produced; the contract makes that the shipped default, so the panel reads a
 * bare project correctly instead of guarding for the field everywhere.
 * @param project - one project of the host snapshot.
 * @returns the policy in force, never undefined.
 */
export function policyOf(project: Pick<ProjectSnapshot, 'policy'>): ToolPolicy {
  return project.policy ?? DEFAULT_TOOL_POLICY
}

/** The body the host expects for one pin or unpin, per `PinRequest`. */
export function pinBody(projectRoot: string, tool: string, pinned: boolean): PinRequest {
  return { projectRoot, tool, pinned }
}

/** The body the host expects for one mode change, per `PolicyRequest`. */
export function policyBody(projectRoot: string, mode: ToolMode): PolicyRequest {
  return { projectRoot, mode }
}

/**
 * The body the host expects for one conflict choice, per `ConflictRequest`.
 *
 * The name travels as the project declared it, never as the local alias: the
 * alias is the host's own computation from its config and the project folder,
 * and a panel that sent one back would disagree with the host the moment either
 * changed.
 * @param projectRoot - the project the contested name belongs to.
 * @param server - the contested `serverName`, as declared.
 * @param choice - the declaration to show.
 * @returns the request body.
 */
export function conflictBody(
  projectRoot: string,
  server: string,
  choice: ConflictChoice,
): ConflictRequest {
  return { projectRoot, server, choice }
}

/**
 * The body of one operator request — `Sync`, `Retry`.
 *
 * A surface that shows a single project names it: the host then touches only
 * that project's servers and answers with that project's slice of the snapshot.
 * `full` keeps the answer whole for a surface that lists every project — the
 * settings page — while the action itself still stays inside `projectRoot`.
 * @param projectRoot - the project the action applies to, when the surface has one.
 * @param full - ask for the whole snapshot in the answer.
 * @returns the request body; `{}` when there is no project to name.
 */
export function operatorBody(projectRoot: string | undefined, full = false): OperatorRequest {
  if (projectRoot === undefined) return {}
  return full ? { projectRoot, full: true } : { projectRoot }
}

/**
 * Submit one pin or unpin and read the host's answer.
 *
 * The host answers with the fresh snapshot on success and with an explanation
 * otherwise (unknown project, unknown tool). Both are returned rather than
 * thrown, because a refusal is a state the panel shows, not a crash.
 * @param body - the `PinRequest` to post.
 * @returns the fresh snapshot, or the host's refusal.
 */
export async function postPin(body: PinRequest): Promise<PolicyAnswer> {
  return postPolicy(ROUTE_ACTIONS.pin, body)
}

/**
 * Submit one mode change and read the host's answer.
 * @param body - the `PolicyRequest` to post.
 * @returns the fresh snapshot, or the host's refusal.
 */
export async function postPolicyMode(body: PolicyRequest): Promise<PolicyAnswer> {
  return postPolicy(ROUTE_ACTIONS.policy, body)
}

/**
 * Submit one conflict choice and read the host's answer.
 * @param body - the `ConflictRequest` to post.
 * @returns the fresh snapshot, or the host's refusal.
 */
export async function postConflict(body: ConflictRequest): Promise<PolicyAnswer> {
  return postPolicy(ROUTE_ACTIONS.conflict, body)
}

/**
 * A refusal the host answered with: the English prose, plus the wire code and
 * its flat params when the host coded it (F-48). The companions are what the
 * render sites resolve through the host namespace; an old host's refusal
 * carries none and renders its `message` exactly as before.
 */
export interface PolicyRefusal {
  /** The host's own English sentence. */
  readonly message: string
  /** Wire code of {@link message} (`projectMcp.host` namespace), when coded. */
  readonly messageCode?: string | undefined
  /** Flat params of {@link messageCode}, when it has any. */
  readonly messageParams?: Record<string, string> | undefined
}

/** Either the snapshot the host re-read after a write, or the reason it refused. */
export type PolicyAnswer = { ok: true; snapshot: unknown } | ({ ok: false } & PolicyRefusal)

interface PolicyEnvelope {
  ok?: boolean
  value?: unknown
  error?: { code?: string; message?: string; messageCode?: string; messageParams?: Record<string, string> }
}

/**
 * `POST` one policy write and unwrap the host's envelope.
 *
 * Both call sites pass the frozen route constant rather than a literal, so a
 * rename cannot leave one of the two routes behind.
 * @param action - route action under `ROUTE_PREFIX`.
 * @param body - the pin or mode request.
 * @returns the fresh snapshot or the refusal message.
 */
async function postPolicy(
  action: typeof ROUTE_ACTIONS.pin | typeof ROUTE_ACTIONS.policy | typeof ROUTE_ACTIONS.conflict,
  body: PinRequest | PolicyRequest | ConflictRequest,
): Promise<PolicyAnswer> {
  try {
    const response = await fetch(`${ROUTE_PREFIX}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = (await response.json()) as PolicyEnvelope
    if (payload.ok === true) return { ok: true, snapshot: payload.value }
    return {
      ok: false,
      message: payload.error?.message ?? `request failed (${response.status})`,
      // The coded companions are optional on the wire: an old host's refusal
      // has none, and the render sites fall back to the message.
      ...(typeof payload.error?.messageCode === 'string'
        ? { messageCode: payload.error.messageCode, messageParams: payload.error.messageParams }
        : {}),
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Hooks a pin write reports through, so one row can disable and explain. */
export interface PinWriteHooks {
  /** Called before the request goes out, with the tool it is about. */
  onStart?: (tool: string) => void
  /** Called after it settles, successfully or not. */
  onSettled?: (tool: string) => void
  /**
   * Called only when the host refused, with its own words — and with the
   * refusal's wire code and flat params when the host coded them (F-48).
   */
  onRefused?: (message: string, messageCode?: string, messageParams?: Record<string, string>) => void
}

/**
 * Write one tool's pin and report what happened.
 *
 * The twin of {@link requestMode} for the other half of the policy: it `POST`s
 * through {@link postPin}, which answers rather than throws, and leaves the
 * pending set and the refusal line to the caller — so one row disables while its
 * own write is in flight and a refusal is shown instead of swallowed.
 * @param body - the project, the public tool name and the wanted pin state.
 * @param hooks - lifecycle callbacks; all optional.
 * @returns the host's answer, for a caller that wants to keep the snapshot.
 */
export async function requestPin(
  body: PinRequest,
  hooks: PinWriteHooks = {},
): Promise<PolicyAnswer> {
  hooks.onStart?.(body.tool)
  const answer = await postPin(body)
  hooks.onSettled?.(body.tool)
  if (!answer.ok) hooks.onRefused?.(answer.message, answer.messageCode, answer.messageParams)
  return answer
}

/** Hooks a mode write reports through, so a surface can disable and explain. */
export interface ModeWriteHooks {
  /** Called before the request goes out. */
  onStart?: (projectRoot: string) => void
  /** Called after it settles, successfully or not. */
  onSettled?: (projectRoot: string) => void
  /**
   * Called only when the host refused, with its own words — and with the
   * refusal's wire code and flat params when the host coded them (F-48).
   */
  onRefused?: (message: string, messageCode?: string, messageParams?: Record<string, string>) => void
}

/**
 * Hooks a conflict choice reports through, so one card can disable its buttons.
 */
export interface ChoiceWriteHooks {
  /** Called before the request goes out, with the name it is about. */
  onStart?: (server: string) => void
  /** Called after it settles, successfully or not. */
  onSettled?: (server: string) => void
  /**
   * Called only when the host refused, with its own words — and with the
   * refusal's wire code and flat params when the host coded them (F-48).
   */
  onRefused?: (message: string, messageCode?: string, messageParams?: Record<string, string>) => void
}

/**
 * Write one conflict choice and report what happened.
 *
 * The twin of {@link requestPin} for the other durable decision a project
 * carries. A choice is what moves an entry between a conflict report and a
 * mounted server under its local name, so the host answers with the snapshot
 * that already reflects it and the caller can draw the new state at once.
 * @param body - the project, the contested name and the declaration to show.
 * @param hooks - lifecycle callbacks; all optional.
 * @returns the host's answer, for a caller that wants to keep the snapshot.
 */
export async function requestConflict(
  body: ConflictRequest,
  hooks: ChoiceWriteHooks = {},
): Promise<PolicyAnswer> {
  hooks.onStart?.(body.server)
  const answer = await postConflict(body)
  hooks.onSettled?.(body.server)
  if (!answer.ok) hooks.onRefused?.(answer.message, answer.messageCode, answer.messageParams)
  return answer
}

/**
 * Write one project's mode and report what happened.
 *
 * `POST`s through {@link postPolicyMode}, which already answers rather than
 * throws, and is deliberately plain: the caller owns the pending set and the
 * error line, so the whole write is a pure function of the request and three
 * callbacks. That is what makes the disabled and refusal states of the switch
 * testable without a DOM.
 * @param body - the project and mode to store.
 * @param hooks - lifecycle callbacks; all optional.
 * @returns the host's answer, for a caller that wants to keep the snapshot.
 */
export async function requestMode(
  body: PolicyRequest,
  hooks: ModeWriteHooks = {},
): Promise<PolicyAnswer> {
  hooks.onStart?.(body.projectRoot)
  const answer = await postPolicyMode(body)
  hooks.onSettled?.(body.projectRoot)
  if (!answer.ok) hooks.onRefused?.(answer.message, answer.messageCode, answer.messageParams)
  return answer
}
