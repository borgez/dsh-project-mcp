# Контракт Фаз 1–2: замороженные интерфейсы

> Archived record — kept for decisions, not a contract. Do not extend; the live docs are `docs/…` (as of F-49).


- **Статус:** заморожен координатором 2026-09-18, до начала письма.
- **Зачем:** пять параллельных исполнителей правят `src/types.ts`, `src/runtime.ts`,
  `src/activation.ts`, `src/client/view.ts`, `src/client/settings-tools.ts`. Каждый пишет
  против этого текста, а не против чужого кода: имена полей ниже менять нельзя без правки
  этого файла координатором.
- **Основание:** `docs/roadmap.md` (Фаза 1: F-10, F-11, F-12, F-18; Фаза 2: F-13…F-17),
  `docs/history/logs-parity.md` §4, §6.1 и `docs/history/wave4-demo.md` §8.

## C1. Логи (F-10): хост → вкладка

`src/types.ts`:

```ts
/** Уровень одного события плагина. */
export type LogLevel = 'info' | 'up' | 'warn' | 'error'

/** Одно событие жизненного цикла плагина, как его видит вкладка «Логи». */
export interface LogEvent {
  /** Время события, epoch ms. */
  readonly at: number
  readonly level: LogLevel
  readonly projectRoot: string
  /** Сессия, которой принадлежит событие; отсутствует у проектных событий. */
  readonly sessionId?: string
  /** `serverName` события; отсутствует у событий без сервера. */
  readonly server?: string
  /** Одна строка без перевода строки. */
  readonly message: string
  /** Деталь в три факта для ошибок (endpoint, документ) — без подсказок про retry. */
  readonly detail?: string
}
```

`ProjectSnapshot` (добавляются, читаются через `??`):

```ts
  /** Последние {@link LOG_PAGE_SIZE} событий, старые первыми; отсутствует, если событий нет. */
  logs?: readonly LogEvent[]
  /** Сколько событий проект сейчас держит в кольце (0…{@link LOG_RING_LIMIT}). */
  logCount?: number
```

`SessionSnapshot`:

```ts
  /** Сколько событий кольца принадлежит именно этой сессии. */
  logCount?: number
```

`src/logs.ts` (новый модуль, **единственный** владелец буфера):

```ts
export const LOG_RING_LIMIT = 200
export const LOG_PAGE_SIZE = 50
export function record(event: LogEvent): void          // пишет в кольцо проекта
export function latest(projectRoot: string, limit?: number): LogEvent[]   // старые первыми
export function page(input: { projectRoot: string; before?: number; limit?: number }): {
  events: LogEvent[]   // старые первыми, ограничено limit (≤ LOG_RING_LIMIT)
  total: number        // всего в кольце проекта
  more: boolean        // есть ли события старее первого отданного
}
export function countOf(projectRoot: string): number
export function countForSession(projectRoot: string, sessionId: string): number
export function clear(projectRoot?: string): void      // для тестов; роута Clear нет
```

**Роут** (`src/ui.ts`): `GET <ROUTE_PREFIX>/logs?projectRoot=<abs>[&before=<epoch ms>][&limit=<n>]`
отвечает `{ ok: true, value: { events: LogEvent[], total: number, more: boolean } }`, события
старые первыми, при `before` — только `at < before`. Ошибки — как у остальных роутов:
`{ ok: false, error: { code, message } }`, код `bad-request` при отсутствующем `projectRoot`.

**Уровни** (ровно пять точек записи, по одной на строку жизненного цикла):
`info` — `mounting`; `up` — `is up`/активация; `warn` — stall и `unmounting`; `error` — ошибка
маунта, а также `unmounting` инстанса, который до этого провалился. Отдельного события
«повторный проход» в кольце нет: повторный проход либо не логируется (нечего сказать), либо
пишет ту же строку, что и первый, и тогда её отсекает дедупликация по всем полям.

**Clear** во вкладке — клиентский: `localStorage` хранит `logsClearedAt` вкладки, события
`at <= logsClearedAt` не рисуются. Нового роута не появляется.

**Единственный источник.** `record()` вызывается из той же точки рантайма, что пишет строку
жизненного цикла в лог DSH (`project-mcp: mounting …`, `… is up …`, `… unmounting …`,
`this.ctx.logger.warn('project-mcp: …')`), — второго пути записи быть не должно.

## C2. Шаг раскрытия (F-13)

`OfferedTool` (только добавление):

```ts
  /** Номер шага агента (с 1), на котором инструмент был предложен. */
  readonly step?: number
```

Счётчик — на сессию, инкремент на каждом `agent/pre-step` (рантайм уже подписан), первый шаг
= `1`. Новые записи `activated`/`context` штампуются текущим значением. Поле необязательное:
без него клиент **не рисует** тег шага (никакого `step 4` и значка `demo`).

## C3. Второй владелец презентации (F-14 A3)

`ProjectSnapshot`:

```ts
  /** Другой загруженный плагин, владеющий `assembly.tools`; отсутствует, если такого нет. */
  presentation?: PresentationOwner

export interface PresentationOwner {
  /** Имя записи загрузчика, например `dsh-progressive-tools`. */
  readonly name: string
  /** Одна строка: почему сосуществование невозможно. */
  readonly note: string
}
```

Хост ищет запись в `ctx.get('loader').entries()` (тот же источник, что `reserved`-имена),
владеющую `assembly.tools` и не являющуюся этим плагином. Клиент рисует плашку **только**
когда поле есть; `DEMO.toolsPresentationOwner` больше не читается.

**Как это реализовано и где предел.** Загрузчик отдаёт наружу только спекулятивные имена
записей (прокси-модули), а не то, какие поверхности запись занимает: проверить владение
`assembly.tools` по факту нельзя. Поэтому проверяется **известный набор спекулятивных имён
владельцев презентации** (`dsh-progressive-tools` и его полное имя) среди активных, не
выключенных записей. Следствия, принятые сознательно: чужой владелец под другим спекулятивным
именем плашки не получит, а одноимённая запись, ничего не вписывающая в `assembly.tools`, —
получит. Отдельная идея в реестре: определять владельца по возможностям, когда загрузчик это
начнёт отдавать.

## C4. Конфликты `serverName` (F-14 B6)

`ProjectSnapshot`:

```ts
  /** Реальный отчёт конфликтов `serverName`; пустой список — конфликтов нет. */
  conflicts?: readonly ServerConflict[]

export interface ServerConflict {
  /** Конфликтующее имя. */
  readonly server: string
  /** `profile` — имя занято профильным инстансом; `duplicate` — два документа проекта. */
  readonly kind: 'profile' | 'duplicate'
  /** Документы-источники, основной первым. */
  readonly sources: readonly string[]
  /** Одна строка: кто побеждает и почему. */
  readonly message: string
}
```

Данные у рантайма уже есть: `profileServerNames()`/`reserved` (`src/runtime.ts:1755`,
`:2641`). Кнопка «Проверить конфликты» становится реальной: список из
`snapshot.conflicts ?? []` с пустым состоянием «конфликтов нет»; выключенной она не бывает.

## C5. Данные предпросмотра запроса (F-15)

`SessionTools` (только добавление, необязательные):

```ts
  /** Сериализованный размер видимого (предложенного) набора, в символах. */
  readonly visibleChars?: number
  /** Сериализованный размер отложенного набора, в символах. */
  readonly deferredChars?: number
```

Имена видимого списка клиент **не** просит: они уже есть как
`baseline` + `activated[].name` + `context[].name`; полный смонтированный набор —
`видимые ∪ deferred` (`SessionTools.deferred` описывает ровно «смонтировано, но не
предложено»). Оценка токенов — `Math.round(chars / 4)`; при отсутствии `deferredChars`
оценка не печатается (а не выдумывается).

## C6. Per-server счётчики (F-16)

Новых полей не нужно: число тулов сервера считается по префиксу `mcp__<server>__` по
`baseline`/`activated`/`context`/`deferred` этой сессии; `mounted` — суммарный контроль.
`DEMO.settingsLockedServer`/`settingsLockedReason` не читаются.

## C7. Ф11 — бюджет (F-11)

`budgetSplit()` (`src/client/view.ts`) рисует полосу по **реальным счётчикам** инструментов
(`toolCounts().offering` против `mounted`), а строка печатает **реальные единицы объёма**:
`surfaceChars` против `budgetChars` и `≈ токены` = `Math.round(surfaceChars / 4)`.
`slotBudget()` и `DEMO.toolsSlots`/`toolsSlotsUsed` удаляются; выдуманных слотов в UI не
остаётся. `settingsBudgetWarning` уходит вместе со слотами и не возвращается.

## C8. Страница настроек (F-12)

Удаляются: поле `policy` (дублирует тумблер режима), поле `slots` (см. C7), колонки
`prefix`/`budget` в таблице проектов, `DEMO.settingsPlans`/`settingsPlanFallback`/
`settingsPrefixNote`. Префикс `mcp__<server>__` — факт: если он остаётся показанным, то
фиксированным значением **без** значка `demo` и без вида «настройка».

## C9. Что запрещено всем исполнителям

- Править `docs/features.md` и `docs/roadmap.md` — реестр ведёт координатор.
- Коммитить, запускать `pnpm check`, `pnpm e2e`, `pnpm pack`, `dsh plugin …` — это финальные
  гейты координатора (общий `dist/`, `coverage/` и профиль `web`).
- Оставлять значок `demo`/`DEMO.*` в том, что они перевели на реальный источник: удаление
  самого `src/client/demo.ts` — отдельный шаг (задача closure).
- Переписывать файл целиком (`write`): только адресные `edit` с уникальным анкером; на
  `FS_STALE_VERSION` — перечитать файл и переналожить правку.
