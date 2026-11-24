// Search (design record, build item 9): one question, asked of everything the person can read
// or of one context — the Search sub-tab asks the first, a context view the second, through the
// same region. No "yours" narrowing rides either: the read never sends `owner` (R2).
//
// The answer comes in two groups that are never merged — **exact** (the words matched) and **by
// meaning** (the idea matched) — each its own list in its own order, each saying in temper-
// design's sentences whether more matched past what it shows (`truncated`), and the by-meaning
// group saying what it ranked from (an exhaustive read, or a draw of the nearest passages). A
// resource both arms found stands in both. When the server could not embed the words
// (`wide.degraded`), the by-meaning group is a warning callout, never an empty list that reads
// like an answer; the exact group stands unaffected beside it.
//
// Filters narrow the question (no sort, no dates, never `owner`): a doc type, on both the Search
// tab and a context's search, and on the Search tab alone a context picker — everything readable
// or one context, from the contexts Explore already reads — then a stage, a status and tags
// (below). The answer is cached under the question whole (region, words aside, every filter), so an
// answer never stands under a filter it was not asked with; changing a filter asks again. The
// question shown with the answer names the type and the scope, and so does every omission
// sentence. On an unscoped search the server applies the type to the meaning arm only after its
// draw of the nearest passages (temper's `search_wide`, unscoped branch), so that arm's sentence
// says the type narrowed the draw — never that every match of the type was looked at. A scoped
// search reads all of its context, type applied within it, and says so as an exhaustive read.
//
// Stage, status and tags (0.2.2) narrow through a query plan instead (`POST /api/query`): a
// filter stage selects the population — the type, the stage (a task's), the status (a goal's)
// and the tags, all of them, in the scope — and both arms rank inside it, each asked one past the
// page. The answer says every filter and the scope, and "among M", M the filter stage's own
// count; the exact arm says "more" only when one past the page came back, and the meaning arm,
// exhaustive over the population, says how many of the M it shows. A population of none says
// nothing was searched, never "no results". With none of the three set, the search door answers
// exactly as before — the door that says what an unscoped meaning arm drew from.
//
// An empty query asks nothing. The panel never talks to temper itself: the read goes through the
// worker on the borrowed grant (`temper.search`). The last question asked in each region, and
// its filters, are device-local view state, held across the panel's runs, so a run that reopens
// owes its read.
import { atom, Button, Callout, Heading, Input, List, ListItem, plugin, read, Row, Select, set, Stack, Text, type OrcaNode } from 'orca'
import { CORE_BINDINGS, drawnSentence, uncountedSentence } from '../vendor/temper-design.mjs'
import { docTypeIcon, rowDescription } from './look'
import { GOAL_STATUSES, SEARCH_TAGS_MAX, TASK_STAGES } from './protocol'
import type { PlanSearchAnswer, PlanSearchArm, ResourceSummary, SearchArm, SearchOutput, WideSearchArm } from './protocol'
import { CountHeading, FailedRegion, Loading, NotConnected } from './regions'

/**
 * Where a search region stands: the Search tab, which asks everything the person can read or the
 * context its picker names, or a context's own search, whose scope is fixed to it.
 */
export type SearchScope = { kind: 'everything' } | { kind: 'context'; id: string; ref: string }

export const EVERYTHING: SearchScope = { kind: 'everything' }

/** A context as a search names it: by its bare id, its ref the words the region says. */
export interface SearchContext {
  id: string
  ref: string
}

/**
 * A region's filters: one doc type or any; — the Search tab's only — one context or none; a
 * stage, offered only while the type is task, and a status, only while it is goal; and tags,
 * matched all-of. A stage, a status or a tag sends the question as a query plan.
 */
export interface SearchFilters {
  docType: string | null
  context: SearchContext | null
  stage: string | null
  status: string | null
  tags: string[]
}

const NO_FILTERS: SearchFilters = { docType: null, context: null, stage: null, status: null, tags: [] }

/** The type a stage belongs to, and the type a status belongs to (temper's task and goal). */
const STAGE_TYPE = 'task'
const STATUS_TYPE = 'goal'

/** What a scope covers, in words. */
const EVERYTHING_SCOPE = 'everything you can read'

/** The Select values that mean "no filter": neither is a doc type's name nor a UUID. */
const ANY_TYPE = 'any-type'
const ANY_CONTEXT = 'everything'
const ANY_STAGE = 'any-stage'
const ANY_STATUS = 'any-status'

const STAGE_OPTIONS = [{ value: ANY_STAGE, label: 'Any stage' }, ...TASK_STAGES.map((stage) => ({ value: stage, label: stage }))]
const STATUS_OPTIONS = [
  { value: ANY_STATUS, label: 'Any status' },
  ...GOAL_STATUSES.map((status) => ({ value: status, label: status }))
]

/** The type filter's options: any type, then core's doc types in temper-design's own order. */
const TYPE_OPTIONS = [
  { value: ANY_TYPE, label: 'Any type' },
  ...CORE_BINDINGS.map((binding) => ({ value: binding.doctype, label: binding.doctype }))
]

/** Each arm in reader terms: what kind of answer it gave (temper-ui's palette words). */
const EXACT_LABEL = 'exact'
const WIDE_LABEL = 'by meaning'
const EXACT_WORDS = 'matching these words'
const WIDE_WORDS = 'similar in meaning'
const EXACT_ORDER = 'matching these words — closest match first'
const WIDE_ORDER = 'similar in meaning — closest first'

/** The callout's title when the meaning arm could not run (temper-ui's words). */
export const DEGRADED_TITLE = "Meaning-match couldn't run just now"

/** The region's key: the Search tab, or one context's own search. */
function scopeKey(scope: SearchScope): string {
  return scope.kind === 'everything' ? 'everything' : `context:${scope.id}`
}

/** The last question asked in each region, by region key — device-local view state. */
const searchAsked = atom('search-asked', {} as Record<string, string>, { persist: 'plugin' })
/** Each region's filters, by region key — device-local view state. Absent is no filter. */
const searchFilters = atom('search-filters', {} as Record<string, SearchFilters>, { persist: 'plugin' })
/** What each region's tag field holds, before Enter adds it. */
const tagDraft = atom('search-tag-draft', {} as Record<string, string>)
/** What the field holds in each region, before Enter asks it. */
const searchDraft = atom('search-draft', {} as Record<string, string>)
/** Each question's answer, by answer key; null while its request is out, absent before asked. */
const searchResults = atom('search-results', {} as Record<string, SearchOutput | null>)

/** Each region's newest ask: an answer to an older question never lands over a newer one. */
const searchAsks: Record<string, number> = {}

/**
 * A region's filters; a context's own search never carries a picked context. Filters held by an
 * earlier version carry no stage, status or tags: absent is none. A stage stands only under the
 * task type and a status only under the goal type — no control could clear one otherwise.
 */
function filtersOf(scope: SearchScope): SearchFilters {
  const held: Partial<SearchFilters> = read(searchFilters)[scopeKey(scope)] ?? NO_FILTERS
  const docType = held.docType ?? null
  return {
    docType,
    context: scope.kind === 'everything' ? (held.context ?? null) : null,
    stage: docType === STAGE_TYPE ? (held.stage ?? null) : null,
    status: docType === STATUS_TYPE ? (held.status ?? null) : null,
    tags: Array.isArray(held.tags) ? held.tags : []
  }
}

/** True when the question goes as a query plan: a stage, a status or a tag is set. */
function asksPlan(filters: SearchFilters): boolean {
  return filters.stage !== null || filters.status !== null || filters.tags.length > 0
}

/** The context a region's question asks of: its own, or the one its picker names, or none. */
function contextOf(scope: SearchScope, filters: SearchFilters): SearchContext | null {
  return scope.kind === 'context' ? { id: scope.id, ref: scope.ref } : filters.context
}

/**
 * The key an answer is cached under: the region, the doc type, the context, the stage, the
 * status and the tags the question asked (tags in a fixed order: all-of has none). A filter
 * changed is a different key, so no answer stands under a filter it was not asked with.
 */
export function answerKey(scope: SearchScope, filters: Partial<SearchFilters>): string {
  const full = { ...NO_FILTERS, ...filters }
  const context = contextOf(scope, full)
  const tags = [...full.tags].sort().map(encodeURIComponent).join(',')
  return (
    `${scopeKey(scope)}|type:${full.docType ?? '*'}|in:${context === null ? '*' : context.id}` +
    `|stage:${full.stage ?? '*'}|status:${full.status ?? '*'}|tags:${tags === '' ? '*' : tags}`
  )
}

/** Where a question asks, in words: everything readable, or the context's ref. */
function whereWords(scope: SearchScope, filters: SearchFilters): string {
  const context = contextOf(scope, filters)
  return context === null ? EVERYTHING_SCOPE : context.ref
}

/**
 * What the filters admit, in words — the type's records (or records), at the stage or status,
 * tagged with every tag: "task records at done tagged orca and rail".
 */
function admittedWords(
  filters: { docType: string | null; stage: string | null; status: string | null; tags: readonly string[] },
  count: number | null = null
): string {
  const noun = count === 1 ? 'record' : 'records'
  const at = filters.stage ?? filters.status
  return [
    filters.docType === null ? noun : `${filters.docType} ${noun}`,
    ...(at === null ? [] : [`at ${at}`]),
    ...(filters.tags.length === 0 ? [] : [`tagged ${filters.tags.join(' and ')}`])
  ].join(' ')
}

/** What a question covers, in words: its scope, and every filter that is set. */
function questionWords(scope: SearchScope, filters: SearchFilters): string {
  const where = whereWords(scope, filters)
  const narrowed = filters.docType !== null || asksPlan(filters)
  return narrowed ? `${admittedWords(filters)} in ${where}` : where
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

/** Every answer a region holds, under any of its filters, dropped. */
function withoutRegion<T>(record: Record<string, T>, region: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith(`${region}|`)))
}

/**
 * Asks the person's words in a region, under its filters. Empty words ask nothing: the held
 * question and its answer clear, and the region says what it would search. Each filter rides the
 * read only when set — never an empty one, never `owner`.
 */
export async function submitSearch(scope: SearchScope, words: string): Promise<void> {
  const key = scopeKey(scope)
  const filters = filtersOf(scope)
  const resultKey = answerKey(scope, filters)
  const query = words.trim()
  const ask = (searchAsks[key] ?? 0) + 1
  searchAsks[key] = ask
  if (query === '') {
    set(searchAsked, without(read(searchAsked), key))
    set(searchResults, withoutRegion(read(searchResults), key))
    return
  }
  set(searchAsked, { ...read(searchAsked), [key]: query })
  set(searchResults, { ...read(searchResults), [resultKey]: null })
  const context = contextOf(scope, filters)
  let answer: SearchOutput
  try {
    answer = await plugin.request('temper.search', {
      query,
      ...(context === null ? {} : { contextId: context.id }),
      ...(filters.docType === null ? {} : { docType: filters.docType }),
      ...(filters.stage === null ? {} : { stage: filters.stage }),
      ...(filters.status === null ? {} : { status: filters.status }),
      ...(filters.tags.length === 0 ? {} : { tags: [...filters.tags] })
    })
  } catch (error) {
    answer = {
      state: 'failed',
      message: `the search never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (searchAsks[key] === ask) {
    set(searchResults, { ...read(searchResults), [resultKey]: answer })
  }
}

/**
 * A filter changed: held, and — when the region holds a question — that question asked again
 * under it, so the answer below always answers the words and the filters above it.
 */
export function setSearchFilters(scope: SearchScope, next: SearchFilters): void {
  const key = scopeKey(scope)
  const kept: SearchFilters = {
    ...next,
    stage: next.docType === STAGE_TYPE ? next.stage : null,
    status: next.docType === STATUS_TYPE ? next.status : null
  }
  set(searchFilters, { ...read(searchFilters), [key]: kept })
  const held = read(searchAsked)[key]
  if (held !== undefined) {
    void submitSearch(scope, held)
  }
}

/**
 * The question a scope holds from an earlier run, asked again when it has no answer here — or
 * always, on a Refresh. A scope holding no question asks nothing.
 */
export function resumeSearch(scope: SearchScope, options: { again?: boolean } = {}): void {
  const key = scopeKey(scope)
  const held = read(searchAsked)[key]
  if (held === undefined) {
    return
  }
  if (options.again === true || read(searchResults)[answerKey(scope, filtersOf(scope))] === undefined) {
    void submitSearch(scope, held)
  }
}

/** True once the everything scope was asked in this run, so a Refresh asks it again. */
export function everythingWasAsked(): boolean {
  return Object.keys(read(searchResults)).some((key) => key.startsWith(`${scopeKey(EVERYTHING)}|`))
}

/** "result" or "results", led by the doc type when the question named one. */
function resultsWord(count: number, docType: string | null): string {
  const word = count === 1 ? 'result' : 'results'
  return docType === null ? word : `${docType} ${word}`
}

/**
 * An arm's omission sentence, from the arm's own word (temper-ui's palette rule): the exact
 * arm's `truncated` false means nothing more matched; the meaning arm's means that only after an
 * exhaustive read, and a read ranked from the nearest passages says so and is never "all". An
 * arm that does not say is "not reported", never "more" inferred from a full page.
 *
 * A doc type names the results. On a read ranked from the nearest passages the type was applied
 * after the draw, so the draw is of passages of any type, and the sentence says the type
 * narrowed it — that records of the type outside the draw were never looked at.
 */
export function armSentence(
  arm: SearchArm,
  words: string,
  draw: WideSearchArm['draw'] | 'exact',
  docType: string | null = null
): string {
  const scope = `${resultsWord(arm.rows.length, docType)} ${words}`
  const more = arm.truncated
  if (more === null) {
    return uncountedSentence(arm.rows.length, scope, null)
  }
  if (draw === 'exact' || draw?.kind === 'exhaustive') {
    return uncountedSentence(arm.rows.length, scope, { more })
  }
  if (draw?.kind === 'nearest') {
    if (docType === null) {
      return drawnSentence(arm.rows.length, scope, { more, draw: draw.chunks, of: 'nearest passages' })
    }
    const drawn = drawnSentence(arm.rows.length, scope, { more, draw: draw.chunks, of: 'nearest passages of any type' })
    return `${drawn} The type narrowed that draw — ${docType} records outside it were never looked at.`
  }
  return uncountedSentence(arm.rows.length, scope, more ? { more } : null)
}

/** An arm with no rows, in words that say why — never a bare zero. */
function emptyWords(arm: SearchArm, words: string, docType: string | null): string {
  if (arm.reason === 'out_of_scope') {
    return '— No phrasing will reach this — the answer is not inside what you can read.'
  }
  return `— No ${resultsWord(0, docType)} ${words} — try different words.`
}

/** An arm's rows, each its type's icon and words, its home beside them; a press opens it. */
function ResultList(props: { label: string; rows: readonly ResourceSummary[]; onOpenItem: (item: ResourceSummary) => void }) {
  return (
    <List label={props.label}>
      {props.rows.map((item) => (
        <ListItem
          key={item.id}
          title={item.title}
          icon={docTypeIcon(item.docType)}
          description={
            item.contextRef === null
              ? rowDescription(item.docType, item.stage)
              : `${rowDescription(item.docType, item.stage)} · ${item.contextRef}`
          }
          onPress={() => props.onOpenItem(item)}
        />
      ))}
    </List>
  )
}

/** One arm as its own group: heading and count, its order, its rows, its omission sentence. */
function ArmGroup(props: {
  label: string
  words: string
  order: string
  arm: SearchArm
  draw: WideSearchArm['draw'] | 'exact'
  docType: string | null
  onOpenItem: (item: ResourceSummary) => void
}) {
  const arm = props.arm
  return (
    <Stack gap="sm">
      <CountHeading label={props.label} count={arm.rows.length} />
      <Text muted size="xs">
        {props.order}
      </Text>
      {arm.rows.length === 0 ? (
        arm.truncated === true ? undefined : (
          <Text muted size="xs">
            {emptyWords(arm, props.words, props.docType)}
          </Text>
        )
      ) : (
        <ResultList label={props.label} rows={arm.rows} onOpenItem={props.onOpenItem} />
      )}
      {arm.rows.length === 0 && arm.truncated !== true ? undefined : (
        <Text muted size="xs">
          {armSentence(arm, props.words, props.draw, props.docType)}
        </Text>
      )}
    </Stack>
  )
}

/** The meaning arm could not run: said as a warning, and no list stands as its answer. */
function DegradedGroup() {
  return (
    <Stack gap="sm">
      <Heading level={3}>{WIDE_LABEL}</Heading>
      <Callout tone="warning" title={DEGRADED_TITLE}>
        <Text muted size="xs">
          Exact matches only — nothing was read by meaning, so nothing here says what would match.
        </Text>
      </Callout>
    </Stack>
  )
}

/** The plan's exact arm, in words: how many of the M it shows, and whether more matched. */
export function planExactSentence(arm: PlanSearchArm, among: number): string {
  if (arm.rows.length === 0) {
    return `None of the ${among} match these words — try different words.`
  }
  return arm.more
    ? `${arm.rows.length} shown of the ${among}; more match these words.`
    : `All ${arm.rows.length} of the ${among} match these words.`
}

/**
 * The plan's meaning arm, in words. It ranks every record of the M it can read by meaning, so
 * one past the page coming back is "the rest not shown"; fewer than that is all it ranked — all
 * of the M, or the M less those it could not rank, said as such.
 */
export function planMeaningSentence(arm: PlanSearchArm, among: number): string {
  const shown = arm.rows.length
  if (arm.more) {
    return `The ${shown} closest in meaning of the ${among}; the rest not shown.`
  }
  if (shown === 0) {
    return `None of the ${among} could be ranked by meaning.`
  }
  if (shown >= among) {
    return `All ${shown} of the ${among}, closest in meaning first.`
  }
  return `The ${shown} closest in meaning of the ${among}; the other ${among - shown} were not ranked by meaning.`
}

/** One arm of a plan's answer as its own group: heading and count, order, rows, sentence. */
function PlanArmGroup(props: {
  label: string
  order: string
  arm: PlanSearchArm
  sentence: string
  onOpenItem: (item: ResourceSummary) => void
}) {
  return (
    <Stack gap="sm">
      <CountHeading label={props.label} count={props.arm.rows.length} />
      <Text muted size="xs">
        {props.order}
      </Text>
      {props.arm.rows.length === 0 ? undefined : <ResultList label={props.label} rows={props.arm.rows} onOpenItem={props.onOpenItem} />}
      <Text muted size="xs">
        {props.sentence}
      </Text>
    </Stack>
  )
}

/**
 * A plan's answer: the question with every filter and the scope, "among M"; then the two arms
 * apart. A population of none says so — nothing was searched, so no arm stands to read as "no
 * results".
 */
function PlanAnswer(props: { scope: SearchScope; answer: PlanSearchAnswer; onOpenItem: (item: ResourceSummary) => void }) {
  const answer = props.answer
  const where = whereWords(props.scope, filtersOf(props.scope))
  if (answer.among === 0) {
    return (
      <Text muted size="xs">
        {`No ${admittedWords(answer)} in ${where} — nothing was searched for “${answer.query}”.`}
      </Text>
    )
  }
  return (
    <Stack gap="md">
      <Text muted size="xs">
        {`Results for “${answer.query}” in ${where}, among ${answer.among} ${admittedWords(answer, answer.among)}.`}
      </Text>
      <PlanArmGroup
        label={EXACT_LABEL}
        order={EXACT_ORDER}
        arm={answer.exact}
        sentence={planExactSentence(answer.exact, answer.among)}
        onOpenItem={props.onOpenItem}
      />
      {answer.wide.degraded ? (
        <DegradedGroup />
      ) : (
        <PlanArmGroup
          label={WIDE_LABEL}
          order={WIDE_ORDER}
          arm={answer.wide}
          sentence={planMeaningSentence(answer.wide, answer.among)}
          onOpenItem={props.onOpenItem}
        />
      )}
    </Stack>
  )
}

/** The answer below the field, in every region state — always the answer to its filters. */
function SearchAnswer(props: { scope: SearchScope; onOpenItem: (item: ResourceSummary) => void }) {
  const filters = filtersOf(props.scope)
  const key = answerKey(props.scope, filters)
  const results = read(searchResults)
  if (!(key in results)) {
    return (
      <Text muted size="xs">
        {`Type words and press Enter to search ${questionWords(props.scope, filters)} — exact matches and matches by meaning, each said apart.`}
      </Text>
    )
  }
  const answer = results[key] ?? null
  if (answer === null) {
    return <Loading words="◌ Loading search results…" />
  }
  if (answer.state === 'not-connected') {
    return <NotConnected message={answer.message} />
  }
  if (answer.state === 'failed') {
    return <FailedRegion label="search" message={answer.message} />
  }
  if (answer.engine === 'plan') {
    return <PlanAnswer scope={props.scope} answer={answer} onOpenItem={props.onOpenItem} />
  }
  return (
    <Stack gap="md">
      <Text muted size="xs">
        {`Results for “${answer.query}” in ${questionWords(props.scope, filters)}.`}
      </Text>
      <ArmGroup
        label={EXACT_LABEL}
        words={EXACT_WORDS}
        order={EXACT_ORDER}
        arm={answer.exact}
        draw="exact"
        docType={answer.docType}
        onOpenItem={props.onOpenItem}
      />
      {answer.wide.degraded ? (
        <DegradedGroup />
      ) : (
        <ArmGroup
          label={WIDE_LABEL}
          words={WIDE_WORDS}
          order={WIDE_ORDER}
          arm={answer.wide}
          draw={answer.wide.draw}
          docType={answer.docType}
          onOpenItem={props.onOpenItem}
        />
      )}
    </Stack>
  )
}

/**
 * The context picker's options: everything readable, then the contexts Explore's read answered.
 * A context held from an earlier run stays listed while that read is out, so the picker never
 * shows a choice it cannot name.
 */
function contextOptions(contexts: readonly SearchContext[] | null, held: SearchContext | null) {
  const listed = contexts ?? []
  const kept = held !== null && !listed.some((context) => context.id === held.id) ? [held] : []
  return [
    { value: ANY_CONTEXT, label: 'Everything readable' },
    ...[...kept, ...listed].map((context) => ({ value: context.id, label: context.ref }))
  ]
}

/**
 * The tag filter: a field that adds the typed tag on Enter, and each tag held as a chip whose
 * press removes it. Every tag held must match (all-of). A blank or repeated tag adds nothing,
 * and the field closes at the most a question carries.
 */
function TagFilter(props: { scope: SearchScope; filters: SearchFilters }) {
  const key = scopeKey(props.scope)
  const tags = props.filters.tags
  const full = tags.length >= SEARCH_TAGS_MAX
  const add = (typed: string) => {
    const tag = typed.trim()
    set(tagDraft, { ...read(tagDraft), [key]: '' })
    if (tag === '' || tags.includes(tag) || full) {
      return
    }
    setSearchFilters(props.scope, { ...props.filters, tags: [...tags, tag] })
  }
  return (
    <Stack gap="xs">
      <Input
        label="tags"
        placeholder={full ? `At most ${SEARCH_TAGS_MAX} tags` : 'Add a tag, then Enter — every tag must match'}
        value={read(tagDraft)[key] ?? ''}
        disabled={full}
        onChange={(next) => set(tagDraft, { ...read(tagDraft), [key]: next })}
        onSubmit={add}
      />
      {tags.length === 0 ? undefined : (
        <Row gap="xs" wrap>
          {tags.map((tag) => (
            <Button
              key={tag}
              size="xs"
              variant="outline"
              icon="close"
              tooltip={`Remove the tag ${tag}`}
              onPress={() => setSearchFilters(props.scope, { ...props.filters, tags: tags.filter((held) => held !== tag) })}
            >
              {tag}
            </Button>
          ))}
        </Row>
      )}
    </Stack>
  )
}

/**
 * The region's filters, in Orca's own controls: the doc type on every region; the stage under the
 * task type and the status under the goal type; the tags; and the context picker on the Search
 * tab only — a context's own search keeps its fixed scope.
 */
function SearchFilterControls(props: { scope: SearchScope; contexts: readonly SearchContext[] | null }) {
  const filters = filtersOf(props.scope)
  const contexts = props.contexts
  return (
    <Stack gap="xs">
      <Select
        label="type"
        value={filters.docType ?? ANY_TYPE}
        options={TYPE_OPTIONS}
        onChange={(value) =>
          setSearchFilters(props.scope, { ...filters, docType: value === ANY_TYPE ? null : value })
        }
      />
      {filters.docType === STAGE_TYPE ? (
        <Select
          label="stage"
          value={filters.stage ?? ANY_STAGE}
          options={STAGE_OPTIONS}
          onChange={(value) => setSearchFilters(props.scope, { ...filters, stage: value === ANY_STAGE ? null : value })}
        />
      ) : undefined}
      {filters.docType === STATUS_TYPE ? (
        <Select
          label="status"
          value={filters.status ?? ANY_STATUS}
          options={STATUS_OPTIONS}
          onChange={(value) => setSearchFilters(props.scope, { ...filters, status: value === ANY_STATUS ? null : value })}
        />
      ) : undefined}
      <TagFilter scope={props.scope} filters={filters} />
      {props.scope.kind === 'everything' ? (
        <Select
          label="in"
          value={filters.context?.id ?? ANY_CONTEXT}
          options={contextOptions(contexts, filters.context)}
          onChange={(value) =>
            setSearchFilters(props.scope, {
              ...filters,
              context:
                value === ANY_CONTEXT
                  ? null
                  : (contexts ?? []).find((context) => context.id === value) ??
                    (filters.context?.id === value ? filters.context : null)
            })
          }
        />
      ) : undefined}
    </Stack>
  )
}

/**
 * The search field, its filters and its answer, for one region. Enter asks; an empty field asks
 * nothing. `contexts` lists the picker's choices on the Search tab — Explore's read, or null
 * while it is out.
 */
export function SearchRegion(props: {
  scope: SearchScope
  contexts?: readonly SearchContext[] | null
  onOpenItem: (item: ResourceSummary) => void
}): OrcaNode {
  const key = scopeKey(props.scope)
  const value = read(searchDraft)[key] ?? read(searchAsked)[key] ?? ''
  return (
    <Stack gap="sm">
      <Input
        type="search"
        label={props.scope.kind === 'everything' ? 'search everything' : `search ${props.scope.ref}`}
        labelHidden
        placeholder={props.scope.kind === 'everything' ? 'Search everything you can read' : `Search ${props.scope.ref}`}
        value={value}
        onChange={(next) => set(searchDraft, { ...read(searchDraft), [key]: next })}
        onSubmit={(words) => void submitSearch(props.scope, words)}
      />
      <SearchFilterControls scope={props.scope} contexts={props.contexts ?? null} />
      <SearchAnswer scope={props.scope} onOpenItem={props.onOpenItem} />
    </Stack>
  )
}
