/**
 * The plugin's own configuration card (F-54): a `plugins.bundle.config` entry
 * that edits the volatile configuration the host serves over `configForms`.
 *
 * The card is deliberately thin: the host owns the schema, the revision dance
 * and the write path; this module renders the eighteen volatile fields as two
 * groups of setting rows, commits valid edits through `form.set`, and offers a
 * per-field reset (`form.unset`) only for fields the user layer overrides.
 *
 * Two host facts are mirrored here on purpose, because host code must never
 * enter the client bundle: the volatile-field defaults (`src/index.ts`
 * `DEFAULTS`, module-private and host-side) and the local-prefix rule
 * (`src/naming.ts` `isValidLocalPrefix`). Both mirrors carry a comment at the
 * copy.
 */

import { createElement as h, useMemo, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { PACKAGE_NAME } from '../shared.ts'
// settings.ts owns the locale namespace and the row/switch styles. Both are
// read inside function bodies only, never at module scope: `locales/ui.ts`
// imports this module while settings.ts imports `locales/ui.ts`, so a value
// read here during evaluation could land inside settings.ts's TDZ window.
import { NS, STYLE } from './settings.ts'

// ---------------------------------------------------------------------------
// Local faces — the vendored contracts, so the client never imports host types
// ---------------------------------------------------------------------------

/** The slice of `ConfigForm`'s snapshot the card reads. */
export interface ConfigFormSnapshotLike {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: Record<string, unknown> | undefined
  /** The user layer of the layered configuration; a field's PRESENCE marks an override. */
  readonly user: unknown
  readonly writable: boolean
}

/** The slice of the host's `ConfigForm` service object the card uses. */
export interface ConfigFormLike {
  getSnapshot(): ConfigFormSnapshotLike
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
}

/** The slice of the `configForms` service the registration block uses. */
export interface ConfigFormsLike {
  get<T>(namespace: string): ConfigFormLike
  whileServed(
    namespaces: readonly string[],
    register: (served: ReadonlySet<string>) => () => void,
  ): () => void
}

/**
 * The props the slot contract declares for `plugins.bundle.config`
 * (`PluginConfigViewProps`), with `form` widened to `unknown`: this
 * registration injects a factory under `form`, but the contract also lets an
 * owner pass its own page form, and a card must survive every shape quietly.
 */
export interface PluginConfigViewPropsLike {
  readonly view: 'summary' | 'page'
  readonly form?: unknown
  readonly t?: Translate
}

// ---------------------------------------------------------------------------
// English dictionary (zh/ru live in `./locales/ui.ts`, which merges this table)
// ---------------------------------------------------------------------------

export const EN = {
  configSummary: 'Edit this plugin’s activation and runtime configuration',
  configGroupActivation: 'Activation',
  configGroupRuntime: 'Runtime',
  configLoading: 'Loading the configuration…',
  configUnavailable: 'The host does not serve this plugin’s configuration to this client.',
  configReadOnly: 'This client keeps its preferences process-local, so these values are read-only here.',
  configOverridden: 'overridden',
  configReset: 'Reset',
  configResetHint: 'Clear this override and inherit the default',
  configInvalidInteger: 'Enter a whole number ≥ {min}',
  configInvalidRange: 'Enter a whole number between {min} and {max}',
  configInvalidPrefix: 'Up to {max} characters: letters, digits, “_” or “-”',
  // The Activation group: the tool-activation surface of `src/activation.ts`.
  configActivationEnabled: 'Tool activation',
  configActivationEnabledHint: 'Offer MCP tools progressively — counters, disclosure and the search gate',
  configActivationSeeded: 'Seeded tools',
  configActivationSeededHint: 'Tools offered from the first step, before any counter accrues; 0 seeds none',
  configActivationMinCalls: 'Calls to pin',
  configActivationMinCallsHint: 'Calls after which the counters pin a tool directly; 0 pins any tool with a recorded call',
  configToolIdleMs: 'Tool idle timeout (ms)',
  configToolIdleMsHint: 'A tool unused for this long drops back out of the request; 0 keeps it for the whole session',
  configGuidanceEnabled: 'System-prompt guidance',
  configGuidanceEnabledHint: 'Inject the plugin’s operating notes into the session prompt',
  configActivationAutoLimit: 'Auto-activation limit',
  configActivationAutoLimitHint: 'Most tools the counters may add on their own (0–50)',
  configActivationAutoStickySteps: 'Sticky steps',
  configActivationAutoStickyStepsHint: 'Extra user messages a context offer stays offered; 0 keeps it for that message only (0–1000)',
  configActivationToolBudgetChars: 'Tool budget (chars)',
  configActivationToolBudgetCharsHint: 'Character budget for the tool schemas one request carries (≥ 1000)',
  // The Runtime group: mounting, precedence and timeouts.
  configAllowGlobalWrite: 'Global writes',
  configAllowGlobalWriteHint: 'Allow saving into the user-level (~/.dsh) configuration',
  configEnvFiles: '.env files',
  configEnvFilesHint: 'Load .env files for server environment variables',
  configLazy: 'Lazy mounting',
  configLazyHint: 'Start project servers on the session’s first step, not at boot',
  configLocalPrefix: 'Local prefix',
  configLocalPrefixHint: 'Prefix for local tool names — up to 5 characters of A–Z, 0–9, _ or -; empty disables it',
  configProfileWins: 'Profile wins',
  configProfileWinsHint: 'Profile-level servers override project declarations of the same name',
  configConnectTimeoutMs: 'Connect timeout (ms)',
  configConnectTimeoutMsHint: 'How long starting one server may take',
  configToolCallTimeoutMs: 'Call timeout (ms)',
  configToolCallTimeoutMsHint: 'How long one tool call may take',
  configIdleTimeoutMs: 'Server idle timeout (ms)',
  configIdleTimeoutMsHint: 'A server idle for this long is stopped',
  configDebounceMs: 'Watch debounce (ms)',
  configDebounceMsHint: 'Quiet period before a config change triggers a rescan',
  configActivationWaitMs: 'Activation wait (ms)',
  configActivationWaitMsHint: 'How long the first step may wait for lazy servers',
} satisfies Record<string, string>

/** A dictionary key of this module's half of the namespace. */
export type LocaleKey = keyof typeof EN

/** Translate one key, with optional `{name}` template params (the DSH seat). */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/**
 * Bind the translate seat the framework injects, falling back to this module's
 * own English dictionary when the card renders outside a DSH shell (tests, or
 * a browser half newer than the host).
 * @param t - the `t` seat of the composed props, when the framework passes one.
 * @returns a translate function that always answers.
 */
export function translateOf(t?: Translate): Translate {
  return t ?? fallbackTranslate
}

function fallbackTranslate(key: string, params?: Record<string, unknown>): string {
  const template = (EN as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

// ---------------------------------------------------------------------------
// The volatile fields — a mirror of the host table, with the card's own bounds
// ---------------------------------------------------------------------------

/** The eighteen keys of `VOLATILE_CONFIG_KEYS` (`src/index.ts`), redeclared. */
export type VolatileConfigKey =
  | 'activationEnabled'
  | 'activationSeeded'
  | 'activationMinCalls'
  | 'toolIdleMs'
  | 'guidanceEnabled'
  | 'activationAutoLimit'
  | 'activationAutoStickySteps'
  | 'activationToolBudgetChars'
  | 'allowGlobalWrite'
  | 'envFiles'
  | 'lazy'
  | 'localPrefix'
  | 'profileWins'
  | 'connectTimeoutMs'
  | 'toolCallTimeoutMs'
  | 'idleTimeoutMs'
  | 'debounceMs'
  | 'activationWaitMs'

/**
 * The defaults the card displays when the served snapshot has no value for a
 * field. Mirror of the host's module-private `DEFAULTS` (`src/index.ts`) and
 * the activation constants (`src/activation.ts`): the host table cannot cross
 * into the client bundle, so the copy lives here and the schema's own defaults
 * remain the source of truth at write time.
 */
export const CONFIG_DEFAULTS: Record<VolatileConfigKey, boolean | number | string> = {
  activationEnabled: true,
  activationSeeded: 16,
  activationMinCalls: 1,
  toolIdleMs: 0,
  guidanceEnabled: true,
  activationAutoLimit: 12,
  activationAutoStickySteps: 100,
  activationToolBudgetChars: 40_000,
  allowGlobalWrite: false,
  envFiles: true,
  lazy: true,
  localPrefix: '',
  profileWins: true,
  connectTimeoutMs: 60_000,
  toolCallTimeoutMs: 60_000,
  idleTimeoutMs: 300_000,
  debounceMs: 300,
  activationWaitMs: 2_000,
}

/**
 * The local-prefix rule, mirrored from `src/naming.ts` (`MAX_LOCAL_PREFIX_LENGTH`
 * and `PREFIX_SHAPE`, in `isValidLocalPrefix`): empty disables the prefix,
 * otherwise at most five characters of letters, digits, `_` or `-`.
 */
const LOCAL_PREFIX_MAX = 5
const LOCAL_PREFIX_SHAPE = /^[A-Za-z0-9_-]+$/

/** Client-side replica of the host's `isValidLocalPrefix`; see the note above. */
export function isValidLocalPrefix(value: string): boolean {
  if (value === '') return true
  return value.length <= LOCAL_PREFIX_MAX && LOCAL_PREFIX_SHAPE.test(value)
}

/** One editable field: how it is grouped, edited and bounded. */
interface FieldDef {
  readonly key: VolatileConfigKey
  readonly kind: 'boolean' | 'integer' | 'text'
  readonly min?: number
  readonly max?: number
  readonly label: LocaleKey
  readonly hint: LocaleKey
}

const ACTIVATION_FIELDS: readonly FieldDef[] = [
  { key: 'activationEnabled', kind: 'boolean', label: 'configActivationEnabled', hint: 'configActivationEnabledHint' },
  { key: 'activationSeeded', kind: 'integer', min: 0, label: 'configActivationSeeded', hint: 'configActivationSeededHint' },
  { key: 'activationMinCalls', kind: 'integer', min: 0, label: 'configActivationMinCalls', hint: 'configActivationMinCallsHint' },
  { key: 'toolIdleMs', kind: 'integer', min: 0, label: 'configToolIdleMs', hint: 'configToolIdleMsHint' },
  { key: 'guidanceEnabled', kind: 'boolean', label: 'configGuidanceEnabled', hint: 'configGuidanceEnabledHint' },
  { key: 'activationAutoLimit', kind: 'integer', min: 0, max: 50, label: 'configActivationAutoLimit', hint: 'configActivationAutoLimitHint' },
  { key: 'activationAutoStickySteps', kind: 'integer', min: 0, max: 1000, label: 'configActivationAutoStickySteps', hint: 'configActivationAutoStickyStepsHint' },
  { key: 'activationToolBudgetChars', kind: 'integer', min: 1000, label: 'configActivationToolBudgetChars', hint: 'configActivationToolBudgetCharsHint' },
]

const RUNTIME_FIELDS: readonly FieldDef[] = [
  { key: 'allowGlobalWrite', kind: 'boolean', label: 'configAllowGlobalWrite', hint: 'configAllowGlobalWriteHint' },
  { key: 'envFiles', kind: 'boolean', label: 'configEnvFiles', hint: 'configEnvFilesHint' },
  { key: 'lazy', kind: 'boolean', label: 'configLazy', hint: 'configLazyHint' },
  { key: 'localPrefix', kind: 'text', label: 'configLocalPrefix', hint: 'configLocalPrefixHint' },
  { key: 'profileWins', kind: 'boolean', label: 'configProfileWins', hint: 'configProfileWinsHint' },
  { key: 'connectTimeoutMs', kind: 'integer', min: 0, label: 'configConnectTimeoutMs', hint: 'configConnectTimeoutMsHint' },
  { key: 'toolCallTimeoutMs', kind: 'integer', min: 0, label: 'configToolCallTimeoutMs', hint: 'configToolCallTimeoutMsHint' },
  { key: 'idleTimeoutMs', kind: 'integer', min: 0, label: 'configIdleTimeoutMs', hint: 'configIdleTimeoutMsHint' },
  { key: 'debounceMs', kind: 'integer', min: 0, label: 'configDebounceMs', hint: 'configDebounceMsHint' },
  { key: 'activationWaitMs', kind: 'integer', min: 0, label: 'configActivationWaitMs', hint: 'configActivationWaitMsHint' },
]

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

const QUIET: CSSProperties = {
  fontSize: '0.85em',
  color: 'var(--dsw-alias-label-tertiary, inherit)',
}

const OVERRIDDEN_CHIP: CSSProperties = {
  marginLeft: 8,
  padding: '0 6px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.4))',
  fontSize: '0.75em',
  fontWeight: 400,
  color: 'var(--dsw-alias-label-tertiary, inherit)',
  verticalAlign: '1px',
}

const RESET_BUTTON: CSSProperties = {
  border: 'none',
  background: 'none',
  padding: 0,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '0.85em',
  color: 'var(--dsw-alias-state-business-primary, #2563eb)',
}

const INPUT_WIDTH: CSSProperties = { width: 96 }

const INPUT_INVALID: CSSProperties = {
  borderColor: 'var(--dsw-alias-state-error-primary, #ef4444)',
}

const INVALID_NOTE: CSSProperties = {
  fontSize: '0.8em',
  color: 'var(--dsw-alias-state-error-primary, #ef4444)',
}

/** The snapshot used while there is no form at all: the unavailable note. */
const NO_FORM_SNAPSHOT: ConfigFormSnapshotLike = {
  status: 'unavailable',
  value: undefined,
  user: undefined,
  writable: false,
}

const noFormSnapshot = (): ConfigFormSnapshotLike => NO_FORM_SNAPSHOT
const subscribeNone = (): (() => void) => () => undefined

/** The memoized store pair `useSyncExternalStore` needs, plus the form itself. */
interface FormSource {
  readonly form: ConfigFormLike
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => ConfigFormSnapshotLike
}

/**
 * Resolve the `form` prop into a store the card can subscribe to. The
 * registration injects a factory (`() => forms.get(ns)`); a direct
 * `ConfigForm`-shaped object is accepted as well. Anything else — an absent
 * prop, a factory that throws, an owner-provided page form the card cannot
 * write through — resolves to `null`, and the card renders its quiet
 * unavailable note instead of failing.
 */
function formSourceOf(raw: unknown): FormSource | null {
  let candidate: unknown = raw
  if (typeof candidate === 'function') {
    try {
      candidate = (candidate as () => unknown)()
    } catch {
      return null
    }
  }
  if (candidate === null || typeof candidate !== 'object') return null
  const form = candidate as ConfigFormLike
  if (
    typeof form.getSnapshot !== 'function' ||
    typeof form.subscribe !== 'function' ||
    typeof form.set !== 'function' ||
    typeof form.unset !== 'function'
  ) {
    return null
  }
  return {
    form,
    subscribe: (listener) => form.subscribe(listener),
    getSnapshot: () => form.getSnapshot(),
  }
}

/** A field is overridden when it is PRESENT in the user layer, whatever its value. */
function hasOverride(user: unknown, field: string): boolean {
  return typeof user === 'object' && user !== null && Object.prototype.hasOwnProperty.call(user, field)
}

/** The displayed value: the served one, falling back to the mirrored default. */
function fieldValue(def: FieldDef, snapshot: ConfigFormSnapshotLike): boolean | number | string {
  const raw = snapshot.value?.[def.key]
  const fallback = CONFIG_DEFAULTS[def.key]
  if (def.kind === 'boolean') return typeof raw === 'boolean' ? raw : (fallback as boolean)
  if (def.kind === 'integer') {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : (fallback as number)
  }
  return typeof raw === 'string' ? raw : (fallback as string)
}

/** Parse a draft into a bounded whole number; `undefined` means "do not write". */
function parseInteger(raw: string, min: number, max: number | undefined): number | undefined {
  const trimmed = raw.trim()
  if (!/^-?\d+$/.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) return undefined
  return parsed
}

/**
 * The plugin's configuration card. `view: 'summary'` is the one-liner the
 * contract allows an owner to ask for; the Plugins page today only ever asks
 * for `'page'`, which is the full two-group form.
 */
export function PluginConfigCard(props: PluginConfigViewPropsLike): ReactNode {
  const t = translateOf(props.t)
  // The injected face is cached per entry, so `props.form` is stable and this
  // memo resolves the factory exactly once per entry.
  const source = useMemo(() => formSourceOf(props.form), [props.form])
  const snapshot = useSyncExternalStore(
    source === null ? subscribeNone : source.subscribe,
    source === null ? noFormSnapshot : source.getSnapshot,
  )
  if (props.view === 'summary') {
    return h('div', { style: QUIET }, t('configSummary'))
  }
  if (source === null || snapshot.status === 'unavailable') {
    return h('div', { style: QUIET }, t('configUnavailable'))
  }
  if (snapshot.status === 'loading') {
    return h('div', { style: QUIET }, t('configLoading'))
  }
  const disabled = !snapshot.writable
  return h(
    'div',
    null,
    disabled ? h('div', { style: { ...QUIET, marginBottom: 8 } }, t('configReadOnly')) : null,
    fieldGroup('activation', 'configGroupActivation', ACTIVATION_FIELDS, snapshot, source.form, t, disabled),
    fieldGroup('runtime', 'configGroupRuntime', RUNTIME_FIELDS, snapshot, source.form, t, disabled),
  )
}

/** One titled group of setting rows, in the shape DSH's own settings pages use. */
function fieldGroup(
  group: string,
  titleKey: LocaleKey,
  fields: readonly FieldDef[],
  snapshot: ConfigFormSnapshotLike,
  form: ConfigFormLike,
  t: Translate,
  disabled: boolean,
): ReactNode {
  return h(
    'section',
    { key: group, style: group === 'activation' ? undefined : STYLE.settingGroup },
    h('div', { style: STYLE.settingGroupHead }, t(titleKey)),
    fields.map((def, index) =>
      h(FieldRow, {
        key: def.key,
        def,
        snapshot,
        form,
        t,
        disabled,
        last: index === fields.length - 1,
      }),
    ),
  )
}

interface FieldRowProps {
  readonly def: FieldDef
  readonly snapshot: ConfigFormSnapshotLike
  readonly form: ConfigFormLike
  readonly t: Translate
  readonly disabled: boolean
  readonly last: boolean
}

/** One setting row: label and hint left, control right, reset when overridden. */
function FieldRow(props: FieldRowProps): ReactNode {
  const { def, snapshot, form, t, disabled, last } = props
  const overridden = hasOverride(snapshot.user, def.key)
  const value = fieldValue(def, snapshot)
  const label = t(def.label)
  const control =
    def.kind === 'boolean'
      ? h(BooleanControl, {
          label,
          value: value as boolean,
          disabled,
          onToggle: (next: boolean) => void form.set(def.key, next),
        })
      : def.kind === 'integer'
        ? h(IntegerControl, {
            label,
            value: value as number,
            disabled,
            min: def.min ?? 0,
            max: def.max,
            t,
            onCommit: (next: number) => void form.set(def.key, next),
          })
        : h(TextControl, {
            label,
            value: value as string,
            disabled,
            t,
            onCommit: (next: string) => void form.set(def.key, next),
          })
  return h(
    'div',
    { style: last ? { ...STYLE.settingRow, ...STYLE.lastRow } : STYLE.settingRow },
    h(
      'div',
      { style: STYLE.settingRowText },
      h(
        'span',
        { style: STYLE.settingRowLabel },
        label,
        overridden ? h('span', { style: OVERRIDDEN_CHIP }, t('configOverridden')) : null,
      ),
      h('span', { style: STYLE.settingRowDesc }, t(def.hint)),
    ),
    h(
      'div',
      { style: STYLE.settingRowControl },
      control,
      overridden
        ? h(
            'button',
            {
              type: 'button',
              style: RESET_BUTTON,
              disabled,
              title: t('configResetHint'),
              'aria-label': `${t('configReset')}: ${label}`,
              onClick: () => void form.unset(def.key),
            },
            t('configReset'),
          )
        : null,
    ),
  )
}

interface BooleanControlProps {
  readonly label: string
  readonly value: boolean
  readonly disabled: boolean
  readonly onToggle: (next: boolean) => void
}

/** The settings pages' sliding switch, bound to one boolean field. */
function BooleanControl(props: BooleanControlProps): ReactNode {
  return h(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': props.value,
      'aria-label': props.label,
      disabled: props.disabled,
      style: props.value ? STYLE.switchOn : { ...STYLE.switchOn, ...STYLE.switchOff },
      onClick: () => props.onToggle(!props.value),
    },
    h('span', {
      style: props.value ? { ...STYLE.switchKnob, ...STYLE.switchKnobOn } : STYLE.switchKnob,
      'aria-hidden': true,
    }),
  )
}

interface IntegerControlProps {
  readonly label: string
  readonly value: number
  readonly disabled: boolean
  readonly min: number
  readonly max: number | undefined
  readonly t: Translate
  readonly onCommit: (next: number) => void
}

/**
 * A bounded whole-number input. The draft is local; only a dirty draft commits,
 * on blur or Enter — a blur with no edit writes nothing. An invalid draft
 * never reaches `form.set` — it marks the control and explains the bound
 * instead. Escape abandons the draft.
 */
function IntegerControl(props: IntegerControlProps): ReactNode {
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [invalid, setInvalid] = useState(false)
  const invalidText =
    props.max === undefined
      ? props.t('configInvalidInteger', { min: props.min })
      : props.t('configInvalidRange', { min: props.min, max: props.max })
  const commit = (raw: string): void => {
    const parsed = parseInteger(raw, props.min, props.max)
    if (parsed === undefined) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setDraft(undefined)
    props.onCommit(parsed)
  }
  return h(
    'span',
    { style: { display: 'inline-flex', flexDirection: 'column', gap: 2 } },
    h('input', {
      type: 'number',
      inputMode: 'numeric',
      step: 1,
      min: props.min,
      ...(props.max === undefined ? {} : { max: props.max }),
      style: invalid ? { ...STYLE.input, ...INPUT_WIDTH, ...INPUT_INVALID } : { ...STYLE.input, ...INPUT_WIDTH },
      value: draft ?? String(props.value),
      disabled: props.disabled,
      'aria-label': props.label,
      'aria-invalid': invalid || undefined,
      onChange: (event: { target: { value: string } }) => {
        setDraft(String(event.target.value))
        if (invalid) setInvalid(false)
      },
      onBlur: () => {
        // Commit only a dirty draft: a blur with no edit must not write the
        // displayed snapshot value (it would pin a phantom override), and the
        // Enter path clears the draft, so an Enter-then-blur no-ops instead of
        // committing the stale value the input fell back to.
        if (draft !== undefined) commit(draft)
      },
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter') {
          if (draft !== undefined) commit(draft)
        } else if (event.key === 'Escape') {
          setDraft(undefined)
          setInvalid(false)
        }
      },
    }),
    invalid ? h('span', { role: 'alert', style: INVALID_NOTE }, invalidText) : null,
  )
}

interface TextControlProps {
  readonly label: string
  readonly value: string
  readonly disabled: boolean
  readonly t: Translate
  readonly onCommit: (next: string) => void
}

/** The local-prefix input: same commit discipline as the numbers, prefix rule. */
function TextControl(props: TextControlProps): ReactNode {
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [invalid, setInvalid] = useState(false)
  const commit = (raw: string): void => {
    if (!isValidLocalPrefix(raw)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setDraft(undefined)
    props.onCommit(raw)
  }
  return h(
    'span',
    { style: { display: 'inline-flex', flexDirection: 'column', gap: 2 } },
    h('input', {
      type: 'text',
      maxLength: LOCAL_PREFIX_MAX,
      style: invalid ? { ...STYLE.input, ...INPUT_WIDTH, ...INPUT_INVALID } : { ...STYLE.input, ...INPUT_WIDTH },
      value: draft ?? props.value,
      placeholder: '—',
      disabled: props.disabled,
      'aria-label': props.label,
      'aria-invalid': invalid || undefined,
      onChange: (event: { target: { value: string } }) => {
        setDraft(String(event.target.value))
        if (invalid) setInvalid(false)
      },
      onBlur: () => {
        // Same commit discipline as the number input: dirty drafts only.
        if (draft !== undefined) commit(draft)
      },
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter') {
          if (draft !== undefined) commit(draft)
        } else if (event.key === 'Escape') {
          setDraft(undefined)
          setInvalid(false)
        }
      },
    }),
    invalid
      ? h('span', { role: 'alert', style: INVALID_NOTE }, props.t('configInvalidPrefix', { max: LOCAL_PREFIX_MAX }))
      : null,
  )
}

// ---------------------------------------------------------------------------
// Registration — the `plugins.bundle.config` entry, parked on the configForms
// service so the card appears exactly when the host serves the namespace
// ---------------------------------------------------------------------------

const PLUGIN_CONFIG_SLOT = 'plugins.bundle.config'
const PRIMARY_CONFIG_NS = 'dsh-project-mcp'
const LEGACY_CONFIG_NS = 'project-mcp'

/** The slot-services slice the registration needs, mirroring settings.ts. */
export interface PluginConfigSlotServices {
  effect(execute: () => unknown, label?: string): unknown
  slots: {
    inject(slot: string, callback: () => unknown): unknown
    register<Props>(
      options: {
        name: string
        key: string
        locale: string
        inject: () => Record<string, unknown>
      },
      component: (props: Props) => ReactNode,
    ): unknown
  }
  configForms: ConfigFormsLike
}

/**
 * Register the card on the Plugins page.
 *
 * The keyed slot's options are exactly `{ name, key, locale, inject }` — the
 * `id`/`order`/`label` options of list slots do not exist here. `whileServed`
 * watches both config namespaces and prefers the plugin's own; the register
 * callback fires once, when the first watched namespace becomes served (there
 * is no re-fire while any of them stays served), and its returned disposer —
 * the one `slots.inject` hands back — runs when the last one disappears.
 */
export function registerPluginConfigCard(services: PluginConfigSlotServices): void {
  const forms = services.configForms
  services.effect(
    () =>
      forms.whileServed([PRIMARY_CONFIG_NS, LEGACY_CONFIG_NS], (served) => {
        const ns = served.has(PRIMARY_CONFIG_NS) ? PRIMARY_CONFIG_NS : LEGACY_CONFIG_NS
        // `slots.inject` keeps registration a no-op on a composition whose
        // slots registry does not declare the slot (an older host) — the card
        // is simply absent there, nothing throws.
        const dispose = services.slots.inject(PLUGIN_CONFIG_SLOT, () =>
          services.slots.register(
            {
              name: PLUGIN_CONFIG_SLOT,
              key: PACKAGE_NAME,
              locale: NS,
              inject: () => ({ form: () => forms.get(ns) }),
            },
            (props: PluginConfigViewPropsLike) => h(PluginConfigCard, props),
          ),
        )
        return typeof dispose === 'function' ? (dispose as () => void) : (): void => undefined
      }),
    'project-mcp: plugin config card',
  )
}
